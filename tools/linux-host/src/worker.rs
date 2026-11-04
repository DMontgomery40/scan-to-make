//! `--model-worker check|run|project …`: the Linux counterpart of the Mac app's
//! `launchModelWorker`. The companion starts it detached with stdin carrying the
//! saved choice. A keyed choice must arrive with an empty environment; the key is
//! read from Secret Service, checked against the exact saved binding, placed in a
//! minimal environment, and this process is replaced by Node running the existing
//! ai-tweak-cli, so the companion's process-group cancellation still reaches it.
use crate::choice::Choice;
use crate::credentials::{resolve, CredentialError, CredentialStore};
use crate::paths::{self, Account, Installation};
use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const MAX_INPUT: usize = 65536;

#[derive(Debug, PartialEq, Eq)]
pub enum WorkerError {
    Input,
    /// A keyed request arrived with caller environment (Mac: forbiddenOverride).
    ForbiddenOverride,
    Credential(CredentialError),
    Unavailable,
}

pub fn valid_arguments(args: &[String]) -> bool {
    match args.first().map(String::as_str) {
        Some("check") => args.len() == 1,
        Some("run") | Some("project") => true,
        _ => false,
    }
}

pub fn read_choice(input: &mut dyn Read) -> Result<Choice, WorkerError> {
    let mut bytes = Vec::new();
    input.take(MAX_INPUT as u64 + 1).read_to_end(&mut bytes).map_err(|_| WorkerError::Input)?;
    if bytes.len() > MAX_INPUT {
        return Err(WorkerError::Input);
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| WorkerError::Input)?;
    Choice::from_value(&value).map_err(|_| WorkerError::Input)
}

const UNKEYED: [&str; 8] = ["HOME", "PATH", "TMPDIR", "LANG", "SCAN_TO_MAKE_CLAUDE_PATH", "SCAN_TO_MAKE_CODEX_PATH", "SCAN_TO_MAKE_SCAN_BLENDER", "SCAN_TO_MAKE_CAPTURE_PYTHON"];

/// Blender where a Linux package, snap, Flatpak export or manual install puts it.
pub fn linux_blender(account: &Account) -> Option<PathBuf> {
    let home = &account.home;
    [
        PathBuf::from("/usr/bin/blender"),
        PathBuf::from("/usr/local/bin/blender"),
        PathBuf::from("/snap/bin/blender"),
        PathBuf::from("/opt/blender/blender"),
        PathBuf::from("/var/lib/flatpak/exports/bin/org.blender.Blender"),
        home.join(".local/share/flatpak/exports/bin/org.blender.Blender"),
    ]
    .into_iter()
    .find(|path| paths::executable(path))
}

/// The worker environment (ModelWorkerEnvironment.make on the Mac).
pub fn environment(
    choice: &Choice,
    base: &BTreeMap<String, String>,
    store: &dyn CredentialStore,
    account: &Account,
    installation: &Installation,
) -> Result<BTreeMap<String, String>, WorkerError> {
    choice.validate().map_err(|_| WorkerError::Input)?;
    let mut env = BTreeMap::new();
    let (selected, secret) = if choice.reference().is_some() {
        if !base.is_empty() {
            return Err(WorkerError::ForbiddenOverride);
        }
        let saved = resolve(choice, store).map_err(WorkerError::Credential)?.expect("keyed choice");
        // Only the account database and the installation choose these paths.
        env.insert("HOME".into(), account.home.display().to_string());
        env.insert("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into());
        env.insert("TMPDIR".into(), "/tmp".into());
        env.insert("LANG".into(), "C.UTF-8".into());
        if let Some(python) = installation.bundled_python() {
            env.insert("SCAN_TO_MAKE_CAPTURE_PYTHON".into(), python.display().to_string());
        }
        if let Some(blender) = linux_blender(account) {
            env.insert("SCAN_TO_MAKE_SCAN_BLENDER".into(), blender.display().to_string());
        }
        (saved.choice, Some(saved.secret))
    } else {
        for key in UNKEYED {
            if let Some(value) = base.get(key) {
                env.insert(key.into(), value.clone());
            }
        }
        if matches!(choice, Choice::ClaudeCode | Choice::CodexCli) {
            for key in ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] {
                if let Some(value) = base.get(key) {
                    env.insert(key.into(), value.clone());
                }
            }
        }
        (choice.clone(), None)
    };
    env.extend(selected.access_environment(secret.as_deref()));
    // Cleanup uses the independently installed workers recorded in our own state.
    // The caller can never supply this path, including when a key was resolved.
    env.insert("SCAN_TO_MAKE_MODEL_STATE".into(), paths::state_dir(account).display().to_string());
    Ok(env)
}

/// Outcome JSON for `check`, so the companion shows a cause without any secret.
/// Only outcomes the existing clients already decode are used.
pub fn check_outcome(error: &WorkerError) -> &'static str {
    match error {
        WorkerError::Credential(CredentialError::Locked) => "needs-gui-session",
        WorkerError::Credential(CredentialError::Missing | CredentialError::Mismatch | CredentialError::Invalid) => "auth-failed",
        _ => "failed",
    }
}

fn redirect_null() -> bool {
    let null = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDWR) };
    if null < 0 { return false; }
    let ok = unsafe { libc::dup2(null, libc::STDIN_FILENO) >= 0 && libc::dup2(null, libc::STDERR_FILENO) >= 0 };
    if null > libc::STDERR_FILENO { unsafe { libc::close(null) }; }
    ok
}

pub fn exec(installation: &Installation, args: &[String], env: &BTreeMap<String, String>) -> std::io::Error {
    let node = installation.node();
    let script = installation.companion("ai-tweak-cli.js");
    // Replace this process: a child would sit in a second process group, outside
    // the companion's SIGTERM/SIGKILL target.
    Command::new(&node).arg(&script).args(args).env_clear().envs(env).stdin(Stdio::inherit()).stderr(Stdio::inherit()).exec()
}

/// Entry point. Never prints errors: stderr is discarded by the companion and must
/// never carry Secret Service text. `check` answers with an outcome on stdout.
pub fn main(args: Vec<String>, store: &dyn CredentialStore) -> i32 {
    unsafe { libc::umask(0o077) };
    if !valid_arguments(&args) {
        return 2;
    }
    let check = args[0] == "check";
    let fail = |error: WorkerError| -> i32 {
        if check {
            println!("{}", serde_json::json!({"ok": false, "outcome": check_outcome(&error)}));
            return 1;
        }
        2
    };
    let choice = match read_choice(&mut std::io::stdin().lock()) { Ok(c) => c, Err(e) => return fail(e) };
    let base: BTreeMap<String, String> = std::env::vars_os()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        .collect();
    let (Ok(account), Ok(installation)) = (paths::account(), paths::installation()) else { return fail(WorkerError::Unavailable) };
    if installation.require_payload().is_err() || !Path::new(&installation.companion("ai-tweak-cli.js")).is_file() {
        return fail(WorkerError::Unavailable);
    }
    if choice.reference().is_some() && base.is_empty() {
        // The account's own session bus, found without any caller environment.
        match paths::session_bus(&account) {
            Some(bus) => std::env::set_var("DBUS_SESSION_BUS_ADDRESS", bus),
            None => return fail(WorkerError::Credential(CredentialError::Unavailable)),
        }
    }
    let env = match environment(&choice, &base, store, &account, &installation) { Ok(env) => env, Err(e) => return fail(e) };
    if !redirect_null() {
        return 2;
    }
    let _ = exec(&installation, &args, &env);
    2
}
