//! The saved AI choice, exactly as `packages/contracts/src/model-access.ts` and
//! `apps/mac/AgentKit/ModelAccess.swift` define it. Metadata only: a reference
//! names one Secret Service item; this type can never hold an API key.
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::net::{Ipv4Addr, Ipv6Addr};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Provider {
    Anthropic,
    OpenAI,
}

impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::OpenAI => "openai",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Choice {
    None,
    ClaudeCode,
    CodexCli,
    Api { provider: Provider, model: String, reference: String },
    Endpoint { url: String, model: String, reference: Option<String> },
}

#[derive(Debug, PartialEq, Eq)]
pub struct InvalidChoice;

fn model_ok(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..].iter().all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(b))
}

/// zod 4's `z.uuid()`: RFC 9562 versions 1-8 with the RFC variant, or the nil/max UUIDs.
pub fn uuid_ok(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower == "00000000-0000-0000-0000-000000000000" || lower == "ffffffff-ffff-ffff-ffff-ffffffffffff" {
        return true;
    }
    let b = lower.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        let dash = i == 8 || i == 13 || i == 18 || i == 23;
        if dash != (*c == b'-') || (!dash && !c.is_ascii_hexdigit()) {
            return false;
        }
    }
    (b'1'..=b'8').contains(&b[14]) && b"89ab".contains(&b[19])
}

/// The contract's endpoint rule, checked on the raw string. The string itself is
/// what the companion stores and what the saved credential binds, so it is never
/// normalized here: `HTTPS://…` is refused and `…/model%20name` kept verbatim.
pub fn endpoint_ok(value: &str) -> bool {
    if value.chars().count() > 2048 || value.len() > 2048 * 4 {
        return false;
    }
    let rest = if let Some(rest) = value.strip_prefix("http://") {
        rest
    } else if let Some(rest) = value.strip_prefix("https://") {
        rest
    } else {
        return false;
    };
    if value.chars().any(|c| c <= ' ' || c == '\u{7f}' || c == '?' || c == '#' || c == '\\') {
        return false;
    }
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
        let Some(end) = inner.find(']') else { return false };
        if inner[..end].parse::<Ipv6Addr>().is_err() {
            return false;
        }
        let after = &inner[end + 1..];
        let port = match after.strip_prefix(':') {
            Some(port) => Some(port),
            None if after.is_empty() => None,
            None => return false,
        };
        ("[]", port)
    } else {
        let mut parts = authority.splitn(2, ':');
        let host = parts.next().unwrap_or("");
        let port = parts.next();
        if port.is_some_and(|p| p.contains(':')) {
            return false;
        }
        (host, port)
    };
    if host.is_empty() || host.chars().any(|c| "%<>[]^|".contains(c)) && host != "[]" {
        return false;
    }
    if host != "[]" {
        // A host whose last label is numeric must be an IPv4 address (WHATWG).
        let last = host.trim_end_matches('.').rsplit('.').next().unwrap_or("");
        if !last.is_empty() && last.bytes().all(|b| b.is_ascii_digit()) && host.parse::<Ipv4Addr>().is_err() {
            return false;
        }
    }
    if let Some(port) = port {
        // WHATWG accepts an empty port (the default); digits must stay within 0-65535.
        if !port.is_empty() && (!port.bytes().all(|b| b.is_ascii_digit()) || port.len() > 5 || port.parse::<u32>().map_or(true, |p| p > 65535)) {
            return false;
        }
    }
    true
}

fn string_field(object: &Map<String, Value>, key: &str) -> Result<String, InvalidChoice> {
    object.get(key).and_then(Value::as_str).map(str::to_owned).ok_or(InvalidChoice)
}

impl Choice {
    /// Strict decoding: every kind has exactly its own keys (zod strictObject).
    pub fn from_value(value: &Value) -> Result<Choice, InvalidChoice> {
        let object = value.as_object().ok_or(InvalidChoice)?;
        let kind = object.get("kind").and_then(Value::as_str).ok_or(InvalidChoice)?;
        let allowed: &[&str] = match kind {
            "none" | "claude-code" | "codex-cli" => &["kind"],
            "api" => &["kind", "provider", "model", "keychainRef"],
            "endpoint" => &["kind", "url", "model", "keychainRef"],
            _ => return Err(InvalidChoice),
        };
        if object.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(InvalidChoice);
        }
        let choice = match kind {
            "none" => Choice::None,
            "claude-code" => Choice::ClaudeCode,
            "codex-cli" => Choice::CodexCli,
            "api" => Choice::Api {
                provider: match string_field(object, "provider")?.as_str() {
                    "anthropic" => Provider::Anthropic,
                    "openai" => Provider::OpenAI,
                    _ => return Err(InvalidChoice),
                },
                model: string_field(object, "model")?,
                reference: string_field(object, "keychainRef")?,
            },
            _ => Choice::Endpoint {
                url: string_field(object, "url")?,
                model: string_field(object, "model")?,
                reference: match object.get("keychainRef") {
                    None => None,
                    Some(Value::String(value)) => Some(value.clone()),
                    Some(_) => return Err(InvalidChoice),
                },
            },
        };
        choice.validate()?;
        Ok(choice)
    }

    pub fn validate(&self) -> Result<(), InvalidChoice> {
        let ok = match self {
            Choice::Api { model, reference, .. } => model_ok(model) && uuid_ok(reference),
            Choice::Endpoint { url, model, reference } => {
                endpoint_ok(url) && model_ok(model) && reference.as_deref().map_or(true, uuid_ok)
            }
            _ => true,
        };
        if ok { Ok(()) } else { Err(InvalidChoice) }
    }

    pub fn reference(&self) -> Option<&str> {
        match self {
            Choice::Api { reference, .. } => Some(reference),
            Choice::Endpoint { reference: Some(reference), .. } => Some(reference),
            _ => None,
        }
    }

    /// The same choice bound to a new reference. Only kinds that can hold a key accept one.
    pub fn with_reference(&self, new: &str) -> Result<Choice, InvalidChoice> {
        match self {
            Choice::Api { provider, model, .. } => {
                Ok(Choice::Api { provider: provider.clone(), model: model.clone(), reference: new.to_owned() })
            }
            Choice::Endpoint { url, model, .. } => {
                Ok(Choice::Endpoint { url: url.clone(), model: model.clone(), reference: Some(new.to_owned()) })
            }
            _ => Err(InvalidChoice),
        }
    }

    /// The exact binding check: provider/destination/model strings compare verbatim;
    /// UUIDs compare as UUIDs (Swift encodes them uppercase, this helper lowercase).
    pub fn same_binding(&self, other: &Choice) -> bool {
        let reference = |choice: &Choice| choice.reference().map(str::to_ascii_lowercase);
        let strip = |choice: &Choice| match choice {
            Choice::Api { provider, model, .. } => Choice::Api { provider: provider.clone(), model: model.clone(), reference: String::new() },
            Choice::Endpoint { url, model, reference } => {
                Choice::Endpoint { url: url.clone(), model: model.clone(), reference: reference.as_ref().map(|_| String::new()) }
            }
            other => other.clone(),
        };
        reference(self) == reference(other) && strip(self) == strip(other)
    }

    pub fn to_value(&self) -> Value {
        let mut object = Map::new();
        let kind = match self {
            Choice::None => "none",
            Choice::ClaudeCode => "claude-code",
            Choice::CodexCli => "codex-cli",
            Choice::Api { .. } => "api",
            Choice::Endpoint { .. } => "endpoint",
        };
        object.insert("kind".into(), kind.into());
        match self {
            Choice::Api { provider, model, reference } => {
                object.insert("provider".into(), provider.as_str().into());
                object.insert("model".into(), model.clone().into());
                object.insert("keychainRef".into(), reference.clone().into());
            }
            Choice::Endpoint { url, model, reference } => {
                object.insert("url".into(), url.clone().into());
                object.insert("model".into(), model.clone().into());
                if let Some(reference) = reference {
                    object.insert("keychainRef".into(), reference.clone().into());
                }
            }
            _ => {}
        }
        Value::Object(object)
    }

    /// The canonical `SCAN_TO_MAKE_AI_*` variables ai-tweak-cli reads (ModelAccessEnvironment).
    pub fn access_environment(&self, secret: Option<&str>) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        let mut set = |key: &str, value: &str| {
            env.insert(key.to_owned(), value.to_owned());
        };
        match self {
            Choice::None => set("SCAN_TO_MAKE_AI_ACCESS", "none"),
            Choice::ClaudeCode => set("SCAN_TO_MAKE_AI_ACCESS", "claude-code"),
            Choice::CodexCli => set("SCAN_TO_MAKE_AI_ACCESS", "codex-cli"),
            Choice::Api { provider, model, .. } => {
                set("SCAN_TO_MAKE_AI_ACCESS", "api");
                set("SCAN_TO_MAKE_AI_PROVIDER", provider.as_str());
                set("SCAN_TO_MAKE_AI_MODEL", model);
            }
            Choice::Endpoint { url, model, .. } => {
                set("SCAN_TO_MAKE_AI_ACCESS", "endpoint");
                set("SCAN_TO_MAKE_AI_ENDPOINT", url);
                set("SCAN_TO_MAKE_AI_MODEL", model);
            }
        }
        if let Some(secret) = secret {
            set("SCAN_TO_MAKE_AI_KEY_ENV", "SCAN_TO_MAKE_MODEL_KEY");
            set("SCAN_TO_MAKE_MODEL_KEY", secret);
        }
        env
    }
}

/// Unicode format characters (Cf), which Foundation counts as control characters.
fn format_character(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0x180E
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF
        | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// Same rule as ModelWorkerEnvironment.validateSecret on the Mac.
pub fn secret_ok(secret: &str) -> bool {
    !secret.is_empty()
        && secret.len() <= 16384
        && !secret.chars().any(|c| c.is_whitespace() || c.is_control() || format_character(c))
}
