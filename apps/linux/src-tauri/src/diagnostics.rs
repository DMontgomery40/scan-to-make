//! Export Diagnostics on Linux (#799): the companion's `diagnostics.bundle` (its own redacted state and each printer
//! MCP's own bundle) saved as a ZIP the person chooses where to keep. The renderer never sees the files: this module
//! turns the companion's answer into ZIP entries, and `main.rs` asks where to save it and writes it.
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

/// The folder every entry sits in, as the Mac's export does.
pub const ROOT: &str = "Counterpart Diagnostics";

/// A name the companion gave, as a path inside `companion/`: relative, no `..`, `.` or empty part, nothing unprintable.
pub fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 512
        && !name.starts_with('/')
        && !name.contains('\\')
        && !name.chars().any(|c| c.is_control())
        && name.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Secrets recognisable by their shape alone, whatever they're labelled, as the Mac's `Diagnostics.scrub`: URL
/// credentials, authorization schemes in any case, PEM blocks, JSON web tokens, keys with a known prefix, a pairing link,
/// email addresses, and home folders (this computer's reads `~`, anyone else's `/home/<user>`). The companion already
/// redacted the bundle; this second pass is for what it might have missed.
pub fn scrub(text: &str, home: Option<&str>) -> String {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            (r#"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@"']+(:[^/\s@"']*)?@"#, "${1}<removed>@"),
            (r"(?i)\b(bearer|basic|digest|token)(\s+)[A-Za-z0-9._~+/=-]{6,}", "${1}${2}<removed>"),
            (r"-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|$)", "<removed PEM block>"),
            (r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+", "<removed token>"),
            (r"\b((sk|pk|rk)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|A(KIA|SIA)[0-9A-Z]{16}\b|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,})", "<removed key>"),
            (r#"scantomake://pair\?[^\s"]+"#, "scantomake://pair?<removed>"),
            (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}", "<removed email>"),
        ]
        .into_iter()
        .map(|(pattern, with)| (Regex::new(pattern).expect("diagnostics pattern"), with))
        .collect()
    });
    static HOMES: OnceLock<Regex> = OnceLock::new();
    let mut out = text.to_string();
    for (regex, with) in rules {
        out = regex.replace_all(&out, *with).into_owned();
    }
    if let Some(home) = home.filter(|home| home.len() > 1) {
        out = out.replace(home, "~").replace(&home.replace('/', "\\/"), "~");
    }
    let homes = HOMES.get_or_init(|| Regex::new(r#"(\\?/)(home|Users)(\\?/)([^/\\\s"'<>:\[]+)"#).expect("home pattern"));
    homes.replace_all(&out, "${1}${2}${3}<user>").into_owned()
}

/// The ZIP's entries: `companion/<name>` for each file, `notes.txt` (what didn't answer) and `about.txt`.
/// `answer` is the companion's reply, or why there is none.
pub fn entries(answer: Result<&Value, &str>, about: &str, home: Option<&str>) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    match answer {
        Ok(bundle) => {
            // Every file and note is checked for its shape; anything dropped is said, so notes.txt never claims
            // "Everything answered." for a bundle that wasn't whole.
            match bundle["files"].as_array() {
                Some(files) => {
                    for file in files {
                        let (Some(name), Some(content)) = (file["name"].as_str(), file["content"].as_str()) else {
                            notes.push("The companion sent a file without a name or text; it was left out.".into());
                            continue;
                        };
                        if !safe_name(name) {
                            notes.push("The companion named a file this export can’t use; it was left out.".into());
                            continue;
                        }
                        if file["truncated"].as_bool() == Some(true) {
                            notes.push(format!("companion/{name} holds only its newest part."));
                        }
                        out.push((format!("{ROOT}/companion/{name}"), scrub(content, home).into_bytes()));
                    }
                }
                None => notes.push("The companion’s answer had no list of files, so this export has none of its files.".into()),
            }
            match bundle["notes"].as_array() {
                Some(list) => {
                    for note in list {
                        match note.as_str() {
                            Some(note) => notes.push(scrub(note, home)),
                            None => notes.push("The companion sent a note that isn’t text; it was left out.".into()),
                        }
                    }
                }
                None => notes.push("The companion’s answer had no list of notes.".into()),
            }
        }
        Err(why) => notes.push(format!(
            "Counterpart couldn’t read the companion’s part ({why}), so this export has no event log, printer list, printer software or printer MCP diagnostics. Start the companion in Settings → General and export again."
        )),
    }
    let notes = if notes.is_empty() {
        "Everything answered.\n".to_string()
    } else {
        notes.iter().map(|note| format!("- {note}\n")).collect()
    };
    out.push((format!("{ROOT}/notes.txt"), notes.into_bytes()));
    out.push((format!("{ROOT}/about.txt"), about.as_bytes().to_vec()));
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// A ZIP of stored (uncompressed) entries with UTF-8 names, which every unzip tool opens. Diagnostics are a few MiB.
pub fn zip(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    if entries.len() > u16::MAX as usize {
        return Err("Too many files for one export.".into());
    }
    let (mut out, mut central) = (Vec::new(), Vec::new());
    // 1980-01-01 00:00, the earliest DOS date: entries carry no time of their own.
    let (time, date) = (0u16, (1u16 << 5) | 1);
    for (name, data) in entries {
        let offset = u32::try_from(out.len()).map_err(|_| "The export is too large.")?;
        let size = u32::try_from(data.len()).map_err(|_| "A file is too large.")?;
        let name_len = u16::try_from(name.len()).map_err(|_| "A file name is too long.")?;
        let crc = crc32(data);
        let header = |signature: u32, central_entry: bool| {
            let mut h = Vec::new();
            h.extend(signature.to_le_bytes());
            if central_entry {
                h.extend(20u16.to_le_bytes()); // made by
            }
            h.extend(20u16.to_le_bytes()); // version needed
            h.extend((1u16 << 11).to_le_bytes()); // UTF-8 names
            h.extend(0u16.to_le_bytes()); // stored
            h.extend(time.to_le_bytes());
            h.extend(date.to_le_bytes());
            h.extend(crc.to_le_bytes());
            h.extend(size.to_le_bytes());
            h.extend(size.to_le_bytes());
            h.extend(name_len.to_le_bytes());
            h.extend(0u16.to_le_bytes()); // extra
            if central_entry {
                h.extend(0u16.to_le_bytes()); // comment
                h.extend(0u16.to_le_bytes()); // disk
                h.extend(0u16.to_le_bytes()); // internal attributes
                h.extend(0u32.to_le_bytes()); // external attributes
                h.extend(offset.to_le_bytes());
            }
            h.extend(name.as_bytes());
            h
        };
        out.extend(header(0x0403_4b50, false));
        out.extend(data);
        central.extend(header(0x0201_4b50, true));
    }
    let central_offset = u32::try_from(out.len()).map_err(|_| "The export is too large.")?;
    let central_size = u32::try_from(central.len()).map_err(|_| "The export is too large.")?;
    out.extend(central);
    out.extend(0x0605_4b50u32.to_le_bytes());
    out.extend([0u8; 4]); // this disk, the central directory's disk
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend(central_size.to_le_bytes());
    out.extend(central_offset.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_stay_inside_their_folder() {
        assert!(safe_name("mcp/P1S-bambu-printer-mcp/fulu/control-trace.log"));
        for bad in ["", "/etc/passwd", "../escape", "a/../../b", "a//b", "./a", "a\\b", "line\nbreak"] {
            assert!(!safe_name(bad), "{bad}");
        }
    }

    #[test]
    fn the_companion_part_goes_under_companion_with_notes_and_about() {
        let bundle = json!({"files":[
            {"name":"events-tail.ndjson","content":"{\"seq\":1}\n","truncated":true},
            {"name":"mcp/P1S-bambu-printer-mcp/server.json","content":"{}","truncated":false},
            {"name":"../escape","content":"x","truncated":false}],
            "notes":["mcp-3D-printer-server 1.2.26 is too old to add its own diagnostics; update it in Settings → Printers."]});
        let out = entries(Ok(&bundle), "Counterpart for Linux 0.1.0\n", None);
        let names: Vec<&str> = out.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, [
            "Counterpart Diagnostics/companion/events-tail.ndjson",
            "Counterpart Diagnostics/companion/mcp/P1S-bambu-printer-mcp/server.json",
            "Counterpart Diagnostics/notes.txt",
            "Counterpart Diagnostics/about.txt",
        ]);
        let notes = String::from_utf8(out[2].1.clone()).unwrap();
        assert!(notes.contains("too old to add its own diagnostics; update it in Settings → Printers."));
        assert!(notes.contains("left out"));
        assert!(notes.contains("companion/events-tail.ndjson holds only its newest part."));
    }

    #[test]
    fn a_companion_that_does_not_answer_still_gives_a_zip_that_says_so() {
        let out = entries(Err("The companion is not running. Start it in Settings."), "about", None);
        assert_eq!(out.len(), 2);
        assert!(String::from_utf8(out[0].1.clone()).unwrap().contains("couldn’t read the companion’s part"));
    }

    #[test]
    fn a_malformed_answer_is_said_never_everything_answered() {
        for bundle in [json!({}), json!({"files":"nope","notes":7}), json!({"files":[{"name":1,"content":2}],"notes":[3]})] {
            let out = entries(Ok(&bundle), "about", None);
            let notes = String::from_utf8(out.iter().find(|(name, _)| name.ends_with("notes.txt")).unwrap().1.clone()).unwrap();
            assert!(!notes.contains("Everything answered."), "{bundle}: {notes}");
        }
    }

    #[test]
    fn the_value_shaped_pass_runs_on_every_file_and_note() {
        let planted = "authorization: basic dXNlcjpwYXNzd29yZA== Token abcDEF123456 http://u:pw@192.0.2.7 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6 AKIAIOSFODNN7EXAMPLE a.b+tag@example.co.uk /home/someone/x /home/me/y -----BEGIN CERTIFICATE-----\nMIIBszCC\n-----END CERTIFICATE----- scantomake://pair?c=abc";
        let bundle = json!({"files":[{"name":"x.log","content":planted,"truncated":false}],"notes":[planted]});
        let out = entries(Ok(&bundle), "about", Some("/home/me"));
        let all: String = out.iter().map(|(_, data)| String::from_utf8_lossy(data).into_owned()).collect();
        for secret in ["dXNlcjpwYXNzd29yZA==", "abcDEF123456", "pw@", "eyJzdWIiOiIxIn0", "ghp_A1b2", "AKIAIOSFODNN7EXAMPLE", "a.b+tag@example.co.uk", "someone", "/home/me", "MIIBszCC", "c=abc"] {
            assert!(!all.contains(secret), "{secret} survived: {all}");
        }
        assert!(all.contains("192.0.2.7") && all.contains("~/y"));
    }

    #[test]
    fn the_zip_is_well_formed() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926, "the standard CRC-32 check value");
        let files = vec![("Counterpart Diagnostics/a.txt".to_string(), b"hello".to_vec()), ("Counterpart Diagnostics/é.txt".to_string(), Vec::new())];
        let bytes = zip(&files).unwrap();
        assert_eq!(&bytes[..4], &[0x50, 0x4b, 0x03, 0x04]);
        let end = &bytes[bytes.len() - 22..];
        assert_eq!(&end[..4], &[0x50, 0x4b, 0x05, 0x06]);
        assert_eq!(u16::from_le_bytes([end[10], end[11]]), 2);
        let central = u32::from_le_bytes([end[16], end[17], end[18], end[19]]) as usize;
        assert_eq!(&bytes[central..central + 4], &[0x50, 0x4b, 0x01, 0x02]);
        // The first entry's data follows its 30-byte header and name.
        let name_len = u16::from_le_bytes([bytes[26], bytes[27]]) as usize;
        assert_eq!(&bytes[30 + name_len..30 + name_len + 5], b"hello");
    }
}
