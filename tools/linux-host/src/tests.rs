//! Shared contract fixtures (packages/contracts/fixtures) and binding rules.
use crate::choice::{endpoint_ok, secret_ok, uuid_ok, Choice};
use crate::credentials::{decode, encode, resolve, CredentialError, CredentialStore, Saved};
use crate::paths::{Account, Installation};
use crate::worker::{check_outcome, environment, valid_arguments, WorkerError};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/contracts/fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[derive(Default)]
struct Memory { items: RefCell<HashMap<String, Vec<u8>>>, locked: bool, unavailable: bool }
impl CredentialStore for Memory {
    fn read(&self, reference: &str) -> Result<Saved, CredentialError> {
        if self.unavailable { return Err(CredentialError::Unavailable); }
        if self.locked { return Err(CredentialError::Locked); }
        let items = self.items.borrow();
        decode(items.get(&reference.to_ascii_lowercase()).ok_or(CredentialError::Missing)?, reference)
    }
    fn save(&self, choice: &Choice, secret: &str, _: bool) -> Result<(), CredentialError> {
        if !secret_ok(secret) { return Err(CredentialError::Invalid); }
        self.items.borrow_mut().insert(choice.reference().unwrap().to_ascii_lowercase(), encode(choice, secret));
        Ok(())
    }
    fn remove(&self, reference: &str) -> Result<bool, CredentialError> { Ok(self.items.borrow_mut().remove(reference).is_some()) }
}

fn account() -> Account { Account { uid: 1000, name: "fixture".into(), home: "/home/fixture".into(), shell: None } }
fn installation() -> Installation { Installation { exe: "/nonexistent/host/counterpart-host".into(), root: "/nonexistent".into() } }
const REFERENCE: &str = "6f3de8c4-83b6-4ad7-9c6f-9b73c7077c73";

#[test]
fn endpoint_urls_match_the_shared_contract() {
    for case in fixture("model-access-urls.json").as_array().unwrap() {
        let url = case["url"].as_str().unwrap();
        assert_eq!(endpoint_ok(url), case["valid"].as_bool().unwrap(), "{url}");
    }
}

#[test]
fn environments_match_the_shared_contract() {
    for case in fixture("model-access.json").as_array().unwrap() {
        let choice = Choice::from_value(&case["choice"]).expect("fixture choice decodes");
        assert_eq!(choice.to_value(), case["choice"], "round trip");
        let store = Memory::default();
        if choice.reference().is_some() { store.save(&choice, "fixture-secret", false).unwrap(); }
        let env = environment(&choice, &BTreeMap::new(), &store, &account(), &installation()).unwrap();
        let expected: BTreeMap<String, String> = serde_json::from_value(case["environment"].clone()).unwrap();
        let produced: BTreeMap<String, String> = env.iter().filter(|(k, _)| k.starts_with("SCAN_TO_MAKE_AI_") || *k == "SCAN_TO_MAKE_MODEL_KEY").map(|(k, v)| (k.clone(), v.clone())).collect();
        assert_eq!(produced, expected, "{}", case["choice"]);
        assert_eq!(env["SCAN_TO_MAKE_MODEL_STATE"], "/home/fixture/.local/share/counterpart");
        if choice.reference().is_some() {
            assert_eq!(env["HOME"], "/home/fixture");
            assert_eq!(env["PATH"], "/usr/local/bin:/usr/bin:/bin");
        }
    }
}

#[test]
fn choices_are_strict() {
    for bad in [
        json!({"kind": "none", "extra": 1}),
        json!({"kind": "api", "provider": "anthropic", "model": "m"}),
        json!({"kind": "api", "provider": "google", "model": "m", "keychainRef": REFERENCE}),
        json!({"kind": "api", "provider": "openai", "model": "-bad", "keychainRef": REFERENCE}),
        json!({"kind": "api", "provider": "openai", "model": "m", "keychainRef": "not-a-uuid"}),
        json!({"kind": "endpoint", "url": "https://x.test/v1", "model": "m", "keychainRef": null}),
        json!({"kind": "endpoint", "url": "HTTPS://x.test/v1", "model": "m"}),
        json!({"kind": "endpoint", "url": "https://x.test/v1", "model": "m", "secret": "k"}),
        json!({"kind": "other"}),
        json!("none"),
    ] {
        assert!(Choice::from_value(&bad).is_err(), "{bad}");
    }
    assert!(uuid_ok(&REFERENCE.to_uppercase()));
    assert!(!uuid_ok("6f3de8c4-83b6-0ad7-9c6f-9b73c7077c73"), "version 0");
}

#[test]
fn a_key_saved_for_one_endpoint_is_refused_for_another() {
    let saved = Choice::from_value(&json!({"kind": "endpoint", "url": "https://one.example.test/v1", "model": "m", "keychainRef": REFERENCE})).unwrap();
    let store = Memory::default();
    store.save(&saved, "key-1", false).unwrap();
    for other in [
        json!({"kind": "endpoint", "url": "https://two.example.test/v1", "model": "m", "keychainRef": REFERENCE}),
        json!({"kind": "endpoint", "url": "https://one.example.test/v1/", "model": "m", "keychainRef": REFERENCE}),
        json!({"kind": "endpoint", "url": "https://one.example.test/v1", "model": "other", "keychainRef": REFERENCE}),
        json!({"kind": "api", "provider": "openai", "model": "m", "keychainRef": REFERENCE}),
    ] {
        let choice = Choice::from_value(&other).unwrap();
        assert_eq!(resolve(&choice, &store).unwrap_err(), CredentialError::Mismatch, "{other}");
        let error = environment(&choice, &BTreeMap::new(), &store, &account(), &installation()).unwrap_err();
        assert_eq!(check_outcome(&error), "auth-failed");
    }
    // Uppercase references (Swift's UUID encoding) name the same item.
    let upper = Choice::from_value(&json!({"kind": "endpoint", "url": "https://one.example.test/v1", "model": "m", "keychainRef": REFERENCE.to_uppercase()})).unwrap();
    assert_eq!(resolve(&upper, &store).unwrap().unwrap().secret, "key-1");
}

#[test]
fn keyed_requests_refuse_caller_environment_and_report_keyring_state() {
    let choice = Choice::from_value(&json!({"kind": "api", "provider": "anthropic", "model": "claude-opus-5-5", "keychainRef": REFERENCE})).unwrap();
    let store = Memory::default();
    store.save(&choice, "k", false).unwrap();
    let base = BTreeMap::from([("SCAN_TO_MAKE_CAPTURE_PYTHON".to_owned(), "/tmp/evil".to_owned())]);
    assert_eq!(environment(&choice, &base, &store, &account(), &installation()).unwrap_err(), WorkerError::ForbiddenOverride);
    let missing = environment(&choice, &BTreeMap::new(), &Memory::default(), &account(), &installation()).unwrap_err();
    assert_eq!(check_outcome(&missing), "auth-failed");
    let locked = environment(&choice, &BTreeMap::new(), &Memory { locked: true, ..Default::default() }, &account(), &installation()).unwrap_err();
    assert_eq!(check_outcome(&locked), "needs-gui-session");
    let none = environment(&choice, &BTreeMap::new(), &Memory { unavailable: true, ..Default::default() }, &account(), &installation()).unwrap_err();
    assert_eq!(check_outcome(&none), "failed");
}

#[test]
fn unkeyed_requests_keep_only_the_allowlisted_environment() {
    let base: BTreeMap<String, String> = [("HOME", "/h"), ("PATH", "/p"), ("ANTHROPIC_API_KEY", "x"), ("CODEX_HOME", "/c"), ("SCAN_TO_MAKE_MODEL_STATE", "/evil")]
        .into_iter().map(|(k, v)| (k.to_owned(), v.to_owned())).collect();
    let env = environment(&Choice::CodexCli, &base, &Memory::default(), &account(), &installation()).unwrap();
    assert_eq!(env.get("ANTHROPIC_API_KEY"), None);
    assert_eq!(env["CODEX_HOME"], "/c");
    assert_eq!(env["SCAN_TO_MAKE_MODEL_STATE"], "/home/fixture/.local/share/counterpart");
    let env = environment(&Choice::None, &base, &Memory::default(), &account(), &installation()).unwrap();
    assert_eq!(env.get("CODEX_HOME"), None);
}

#[test]
fn stored_records_must_be_bound_version_one() {
    let choice = Choice::from_value(&json!({"kind": "api", "provider": "openai", "model": "m", "keychainRef": REFERENCE})).unwrap();
    assert!(decode(&encode(&choice, "k"), REFERENCE).is_ok());
    let other = "0b8f1f8e-1111-4222-8333-444455556666";
    assert_eq!(decode(&encode(&choice, "k"), other).unwrap_err(), CredentialError::Unavailable);
    let unversioned = serde_json::to_vec(&json!({"choice": choice.to_value(), "secret": "k"})).unwrap();
    assert!(decode(&unversioned, REFERENCE).is_err());
    let bare = b"just-a-key";
    assert!(decode(bare, REFERENCE).is_err(), "no unbound legacy string item");
}

#[test]
fn secrets_follow_the_mac_rules() {
    assert!(secret_ok("sk-ant-api03-abc_DEF"));
    for bad in ["", "has space", "line\nbreak", "tab\t", "zero\u{200B}width", "bom\u{FEFF}"] { assert!(!secret_ok(bad), "{bad:?}"); }
    assert!(!secret_ok(&"a".repeat(16385)));
    assert!(secret_ok(&"a".repeat(16384)));
}

#[test]
fn worker_arguments_match_the_mac_helper() {
    let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert!(valid_arguments(&args(&["check"])));
    assert!(!valid_arguments(&args(&["check", "extra"])));
    assert!(valid_arguments(&args(&["run", "--mesh", "a"])));
    assert!(valid_arguments(&args(&["project", "/tmp/r.json"])));
    assert!(!valid_arguments(&args(&["pick"])));
    assert!(!valid_arguments(&args(&[])));
}

#[test]
fn store_binds_a_fresh_reference() {
    let choice = Choice::from_value(&json!({"kind": "endpoint", "url": "http://localhost:1234/v1", "model": "local"})).unwrap();
    let bound = choice.with_reference("0b8f1f8e-1111-4222-8333-444455556666").unwrap();
    assert_eq!(bound.to_value()["keychainRef"], "0b8f1f8e-1111-4222-8333-444455556666");
    assert!(Choice::ClaudeCode.with_reference(REFERENCE).is_err());
}

#[test]
fn unit_quotes_systemd_specifiers() {
    let text = crate::host::unit_text(std::path::Path::new("/home/a b/%x$y/host/counterpart-host"));
    assert!(text.contains("ExecStart=\"/home/a b/%%x$$y/host/counterpart-host\" serve\n"));
    assert!(text.contains("WantedBy=default.target"));
}

#[test]
fn the_default_printer_config_names_an_absolute_node_and_repairs_only_our_old_default() {
    use crate::host::write_default_printer_config;
    use std::path::Path;
    let dir = std::env::temp_dir().join(format!("counterpart-host-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let state = Path::new("/home/fixture/.local/share/counterpart");
    let node = Path::new("/home/fixture/.local/share/counterpart/runtime/current/Payload/node/bin/node");
    let entry = "/home/fixture/.local/share/counterpart/printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js";
    let read = |path: &Path| -> Value { serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap() };
    // Fresh: created with an absolute command (printerHandoffConfigSchema's absolutePath).
    let fresh = dir.join("fresh.json");
    write_default_printer_config(&fresh, state, node).unwrap();
    let config = read(&fresh);
    assert_eq!(config, json!({"backend": "bambu-printer-mcp", "process": {"command": node.to_str().unwrap(), "args": [entry]}}));
    assert!(Path::new(config["process"]["command"].as_str().unwrap()).is_absolute());
    // The relative default an earlier build wrote is replaced.
    let old = dir.join("old.json");
    std::fs::write(&old, serde_json::to_vec(&json!({"backend": "bambu-printer-mcp", "process": {"command": "node", "args": [entry]}})).unwrap()).unwrap();
    write_default_printer_config(&old, state, node).unwrap();
    assert_eq!(read(&old), config);
    // Anything the user or Counterpart has changed is never touched.
    let mine = dir.join("mine.json");
    let custom = json!({"backend": "mcp-3d-printer-server", "process": {"command": "node", "args": ["/home/fixture/mcp-3D-printer-server/dist/index.js"]}});
    std::fs::write(&mine, serde_json::to_vec(&custom).unwrap()).unwrap();
    write_default_printer_config(&mine, state, node).unwrap();
    assert_eq!(read(&mine), custom);
    assert!(write_default_printer_config(&dir.join("x.json"), state, Path::new("node")).is_err());
    std::fs::remove_dir_all(&dir).unwrap();
}
