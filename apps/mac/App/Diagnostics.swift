import Foundation
#if canImport(ControlKit)
import ControlKit
#endif

/// A zip of the companion's logs and settings with every secret removed: no auth or TLS files, and every value whose
/// name says token, key, secret, password or access code replaced. Since #799 it also holds the companion's own part
/// (`diagnostics.bundle`: the event log's tail, the printers, their printer software and each printer MCP's own bundle)
/// as `companion/`, the build in `about.txt`, and `notes.txt`, which says what didn't answer.
enum Diagnostics {
    static let secretNames = try! NSRegularExpression(pattern:"(TOKEN|KEY|SECRET|PASSWORD|PASSPHRASE|PASS|ACCESS_CODE|AUTH|CREDENTIAL|EMAIL|COOKIE|SESSION|(^|_)PIN($|_)|(^|_)OTP($|_))", options:[.caseInsensitive])

    /// `scheme://user:password@host` keeps its host and loses its credentials, wherever it appears.
    static func stripURLCredentials(_ text: String) -> String {
        let regex = try! NSRegularExpression(pattern:#"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@"']+(:[^/\s@"']*)?@"#)
        return regex.stringByReplacingMatches(in:text, range:NSRange(text.startIndex..., in:text), withTemplate:"$1<removed>@")
    }

    /// Secrets recognisable by their shape alone, whatever they're labelled: URL credentials, authorization schemes in any
    /// case, PEM blocks, JSON web tokens, keys with a known prefix, a pairing link, email addresses, and home folders
    /// (this Mac's reads `~`, anyone else's `/Users/<user>`). Linux runs the same pass (`diagnostics.rs`).
    static let valueRules: [(NSRegularExpression, String)] = [
        // PEM blocks first: a header line or scheme rule must never eat a block's BEGIN marker.
        (#"-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|$)"#, "<removed PEM block>"),
        (#"(?im)(^|[^"\w-])((?:Proxy-)?Authorization[ \t]*:)[^\n]*"#, "$1$2 <removed>"),
        (#"(?i)\b(bearer|basic|digest|negotiate|token)(\s+)[A-Za-z0-9._~+/=-]{6,}"#, "$1$2<removed>"),
        (#"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+"#, "<removed token>"),
        (#"\b((sk|pk|rk)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|A(KIA|SIA)[0-9A-Z]{16}\b|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,})"#, "<removed key>"),
        (#"scantomake://pair\?[^\s"]+"#, "scantomake://pair?<removed>"),
        (#"[A-Za-z0-9._%+-]+(@|%40)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"#, "<removed email>"),
    ].map { (try! NSRegularExpression(pattern:$0.0), $0.1) }
    static let homeRules: [(NSRegularExpression, String)] = [
        (#"(\\?/)(Users)(\\?/)(?!<user>)([^/\\\s"'<>:]+)"#, "$1$2$3<user>"),
    ].map { (try! NSRegularExpression(pattern:$0.0), $0.1) }

    static func scrub(_ text: String, home: String = NSHomeDirectory()) -> String {
        var out = stripURLCredentials(text)
        for (regex, template) in valueRules {
            out = regex.stringByReplacingMatches(in:out, range:NSRange(out.startIndex..., in:out), withTemplate:template)
        }
        if home.count > 1 {
            out = out.replacingOccurrences(of:home, with:"~").replacingOccurrences(of:home.replacingOccurrences(of:"/", with:"\\/"), with:"~")
        }
        for (regex, template) in homeRules {
            out = regex.stringByReplacingMatches(in:out, range:NSRange(out.startIndex..., in:out), withTemplate:template)
        }
        return out
    }

    /// `NAME=value` lines, commented-out ones too (`# BAMBU_TOKEN=…` may be a live credential), lose a secret's value.
    static func redact(env text: String) -> String {
        scrub(text).components(separatedBy:"\n").map { line in
            guard let equals = line.firstIndex(of:"=") else { return line }
            let name = String(line[..<equals])
            let bare = name.trimmingCharacters(in:CharacterSet(charactersIn:"# \t"))
            let hit = secretNames.firstMatch(in:bare, range:NSRange(bare.startIndex..., in:bare)) != nil
            return hit ? name + "=<removed>" : line
        }.joined(separator:"\n")
    }

    /// Log lines: `NAME=value` or `"name": "value"` for a secret-looking name, and every value-shaped secret, are removed.
    static func redact(log text: String) -> String {
        var out = scrub(text)
        let named = try! NSRegularExpression(pattern:#"(?i)("?[A-Za-z0-9_.-]*(?:token|key|secret|password|pass(?![a-z])|access_code|accesscode|auth|credential|session|cookie)[A-Za-z0-9_.-]*"?\s*[=:]\s*)("[^"]*"|[^\s,}]+)"#)
        out = named.stringByReplacingMatches(in:out, range:NSRange(out.startIndex..., in:out), withTemplate:"$1<removed>")
        return out
    }

    /// The companion's part arrives redacted (#799): only the value-shaped pass runs again, so its JSON stays JSON and its
    /// words and `[set]` markers stay.
    static func redact(companion text: String) -> String { scrub(text) }

    static func redact(json value: Any) -> Any {
        if let object = value as? [String: Any] {
            return object.reduce(into:[String: Any]()) { result, pair in
                let hit = secretNames.firstMatch(in:pair.key, range:NSRange(pair.key.startIndex..., in:pair.key)) != nil
                result[pair.key] = hit ? "<removed>" : redact(json:pair.value)
            }
        }
        if let array = value as? [Any] { return array.map(redact(json:)) }
        if let string = value as? String { return scrub(string) }
        return value
    }

    /// A name the companion gave, as a path inside `companion/`: relative, no `..`, `.` or empty part, nothing unprintable,
    /// and no part longer than a file name may be (255 bytes).
    static func safeRelativePath(_ name: String) -> String? {
        guard !name.isEmpty, name.utf8.count <= 512, !name.hasPrefix("/"), !name.contains("\\"),
              !name.unicodeScalars.contains(where:{ $0.value < 0x20 || $0.value == 0x7f }) else { return nil }
        let parts = name.split(separator:"/", omittingEmptySubsequences:false)
        guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.count <= 255 }) else { return nil }
        return name
    }

    /// `companion` is `diagnostics.bundle` on the companion's control socket. The export never fails as a whole for one
    /// file: a companion that doesn't answer, or a file that can't be written, is a line in `notes.txt`.
    /// The folder inside the ZIP, named by date as Settings names the ZIP ("Counterpart Diagnostics 2026-11-15"), not by a UUID (#829).
    static func folderName(_ date: Date) -> String { "Counterpart Diagnostics \(date.formatted(.iso8601.year().month().day()))" }

    /// `ditto` without resource forks or extended attributes, so the ZIP has no AppleDouble `._` files (#829).
    static func zip(_ folder: URL, to destination: URL) throws -> Bool {
        let zip = Process()
        zip.executableURL = URL(fileURLWithPath:"/usr/bin/ditto")
        zip.arguments = ["-c", "-k", "--norsrc", "--keepParent", folder.path, destination.path]
        try zip.run(); zip.waitUntilExit()
        return zip.terminationStatus == 0
    }

    static func export(state: URL, to destination: URL, now: Date = Date(), companion: @Sendable () async throws -> CompanionDiagnostics) async -> Bool {
        var bundle: CompanionDiagnostics?
        var problem: String?
        do { bundle = try await companion() }
        catch { problem = "Counterpart couldn’t read the companion’s part (\(error.localizedDescription)), so this export has no event log, printer list, printer software or printer MCP diagnostics. Export again once Counterpart is running." }
        let answered = bundle, unanswered = problem
        return await Task.detached {
            let fm = FileManager.default
            // A private parent keeps two exports apart; the folder itself carries the date.
            let parent = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory:true)
            let folder = parent.appendingPathComponent(folderName(now), isDirectory:true)
            defer { try? fm.removeItem(at:parent) }
            var notes = unanswered.map { [$0] } ?? []
            /// One file: written, or a note saying why not, and the export carries on.
            func save(_ relative: String, _ write: (URL) throws -> Void) {
                let url = folder.appendingPathComponent(relative)
                do {
                    try fm.createDirectory(at:url.deletingLastPathComponent(), withIntermediateDirectories:true)
                    try write(url)
                } catch { notes.append("\(relative) couldn’t be written (\(error.localizedDescription)); it was left out.") }
            }
            do {
                try fm.createDirectory(at:folder, withIntermediateDirectories:true)
                for name in (try? fm.contentsOfDirectory(atPath:state.appendingPathComponent("logs").path)) ?? [] where name.hasSuffix(".log") {
                    let data = (try? Data(contentsOf:state.appendingPathComponent("logs/\(name)"))) ?? Data()
                    // The last 4 MB, from its first whole line: a cut after a label would leave a secret unlabelled.
                    var tail = data.suffix(4 * 1024 * 1024)
                    if tail.count < data.count, let newline = tail.firstIndex(of:0x0A) { tail = tail[tail.index(after:newline)...] }
                    let text = String(decoding:tail, as:UTF8.self)
                    save("logs/\(name)") { try redact(log:text).write(to:$0, atomically:true, encoding:.utf8) }
                }
                if let env = try? String(contentsOf:state.appendingPathComponent("companion.env"), encoding:.utf8) {
                    save("companion.env") { try redact(env:env).write(to:$0, atomically:true, encoding:.utf8) }
                }
                for name in ["printer-handoff.json", "app-migration.json"] {
                    guard let data = try? Data(contentsOf:state.appendingPathComponent(name)),
                          let json = try? JSONSerialization.jsonObject(with:data) else { continue }
                    save(name) { try JSONSerialization.data(withJSONObject:redact(json:json), options:[.prettyPrinted, .sortedKeys]).write(to:$0) }
                }
                if let answered {
                    // The companion already redacted it; the value-shaped pass runs again over every file (`redact(companion:)`).
                    for file in answered.files {
                        guard let name = safeRelativePath(file.name) else { notes.append("The companion named a file this export can’t use; it was left out."); continue }
                        save("companion/\(name)") { try redact(companion:file.content).write(to:$0, atomically:true, encoding:.utf8) }
                        if file.truncated { notes.append("companion/\(name) holds only its newest part.") }
                    }
                    notes += answered.notes.map(redact(companion:))
                }
                let version = Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "—"
                let build = Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as? String ?? "—"
                let about = "Counterpart \(version) (build \(build))\nmacOS \(ProcessInfo.processInfo.operatingSystemVersionString)\n"
                try about.write(to:folder.appendingPathComponent("about.txt"), atomically:true, encoding:.utf8)
                let notesText = notes.isEmpty ? "Everything answered.\n" : notes.map { "- \($0)" }.joined(separator:"\n") + "\n"
                try notesText.write(to:folder.appendingPathComponent("notes.txt"), atomically:true, encoding:.utf8)
                try? fm.removeItem(at:destination)
                return try zip(folder, to:destination)
            } catch { return false }
        }.value
    }
}
