//! `status`, `setup`, `serve` and `service start|stop`: the Linux counterpart of the
//! Mac app's `configure`/`serve` (apps/mac/Resources/agent.mjs, App/Runtime.swift).
use crate::paths::{self, Account, Installation};
use crate::process::{self, inherited};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

pub const UNIT: &str = "counterpart-companion.service";
pub const DEFAULT_PORT: &str = "9077";

pub struct Context {
    pub account: Account,
    pub installation: Installation,
    pub state: PathBuf,
}

impl Context {
    pub fn load() -> io::Result<Context> {
        let account = paths::account()?;
        let installation = paths::installation()?;
        let state = paths::state_dir(&account);
        Ok(Context { account, installation, state })
    }
    fn auth(&self) -> PathBuf { self.state.join("auth") }
    fn env_file(&self) -> PathBuf { self.state.join("companion.env") }
    fn unit_file(&self) -> PathBuf { paths::unit_dir(&self.account).join(UNIT) }
    fn runtime(&self) -> PathBuf { self.state.join("runtime") }
    pub fn socket(&self) -> PathBuf { paths::control_socket(&self.account) }
    fn configured(&self) -> bool {
        self.auth().join("auth.json").is_file() && self.env_file().is_file() && self.unit_file().is_file()
    }
}

fn node_env(context: &Context) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("HOME".into(), context.account.home.display().to_string()),
        ("PATH".into(), format!("{}:/usr/bin:/bin", context.installation.node().parent().unwrap().display())),
        ("LANG".into(), "C.UTF-8".into()),
    ])
}

/// companion.env exactly as Node reads it (util.parseEnv), using the bundled Node.
pub fn parse_env_file(context: &Context, path: &Path) -> io::Result<BTreeMap<String, String>> {
    if !path.exists() { return Ok(BTreeMap::new()); }
    let script = "import {parseEnv} from 'node:util';import {readFileSync} from 'node:fs';process.stdout.write(JSON.stringify(parseEnv(readFileSync(process.argv[1],'utf8'))))";
    let path = path.to_str().ok_or_else(|| io::Error::other("Invalid companion.env path"))?;
    let out = process::run(&context.installation.node(), &["--input-type=module", "-e", script, path], &node_env(context), None, None, Duration::from_secs(20))?;
    if out.status != 0 { return Err(io::Error::other("companion.env could not be read")); }
    let value: BTreeMap<String, Value> = serde_json::from_slice(&out.stdout).map_err(|_| io::Error::other("companion.env could not be read"))?;
    Ok(value.into_iter().filter_map(|(k, v)| v.as_str().map(|v| (k, v.to_owned()))).collect())
}

fn connectable(socket: &Path) -> bool { UnixStream::connect(socket).is_ok() }

fn systemctl_env(context: &Context) -> BTreeMap<String, String> {
    let mut env = inherited();
    if let Some(runtime) = paths::runtime_dir(&context.account) {
        env.entry("XDG_RUNTIME_DIR".into()).or_insert(runtime.display().to_string());
    }
    if let Some(bus) = paths::session_bus(&context.account) {
        env.entry("DBUS_SESSION_BUS_ADDRESS".into()).or_insert(bus);
    }
    env
}

fn systemctl(context: &Context, args: &[&str]) -> io::Result<i32> {
    let mut full = vec!["--user"];
    full.extend_from_slice(args);
    Ok(process::run(Path::new("/usr/bin/systemctl"), &full, &systemctl_env(context), None, None, Duration::from_secs(60))?.status)
}

fn active(context: &Context) -> bool { systemctl(context, &["is-active", "--quiet", UNIT]).map(|s| s == 0).unwrap_or(false) }

pub fn status(context: &Context) -> Value {
    let socket = context.socket();
    json!({
        "configured": context.configured(),
        "running": context.unit_file().is_file() && active(context) && connectable(&socket),
        "stateDir": context.state.display().to_string(),
        "controlSocket": socket.display().to_string(),
    })
}

fn wait_ready(context: &Context, timeout: Duration) -> bool {
    let socket = context.socket();
    let started = Instant::now();
    while started.elapsed() < timeout {
        if connectable(&socket) { return true; }
        // A unit systemd has given up on will not open the socket; status reports it.
        if started.elapsed() > Duration::from_secs(5) && !active(context) { return false; }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

/// Quoted for systemd's ExecStart (`%` and `$` are specifiers there).
fn unit_quote(path: &Path) -> String {
    let text = path.display().to_string().replace('\\', "\\\\").replace('"', "\\\"").replace('%', "%%").replace('$', "$$");
    format!("\"{text}\"")
}

pub fn unit_text(executable: &Path) -> String {
    format!(
        "[Unit]\nDescription=Counterpart companion\nDocumentation=https://counterpart.dtmont.com/\nStartLimitIntervalSec=300\nStartLimitBurst=10\n\n\
         [Service]\nType=simple\nExecStart={} serve\nRestart=on-failure\nRestartSec=5\nUMask=0077\nTimeoutStopSec=30\nNoNewPrivileges=yes\n\n\
         [Install]\nWantedBy=default.target\n",
        unit_quote(executable)
    )
}

fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| io::Error::other("Invalid path"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.{}", path.file_name().unwrap().to_string_lossy(), uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).mode(mode).open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

/// System packages (/usr, /opt) stay where they are. Anything else, an AppImage's
/// temporary mount in particular, is copied into state so the service outlives the UI.
fn stable_root(context: &Context) -> bool {
    let root = &context.installation.root;
    root.starts_with("/usr/") || root.starts_with("/opt/") || root.starts_with(context.runtime())
}

fn build_id(installation: &Installation) -> io::Result<String> {
    let text = fs::read_to_string(installation.root.join("BUILD-ID")).map_err(|_| io::Error::other("This Counterpart runtime has no BUILD-ID; rebuild it with tools/linux-host/prepare-payload.sh"))?;
    let id = text.trim().to_owned();
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.') {
        return Err(io::Error::other("Invalid BUILD-ID"));
    }
    Ok(id)
}

/// The helper the user unit runs, installing a stable runtime copy when needed.
/// Returns whether the selected runtime changed.
fn install_runtime(context: &Context) -> io::Result<(PathBuf, bool)> {
    if stable_root(context) && !context.installation.root.starts_with(context.runtime()) {
        let exe = context.installation.root.join("host/counterpart-host");
        return Ok((exe, false));
    }
    let runtime = context.runtime();
    paths::private_dir(&runtime, context.account.uid)?;
    let current = runtime.join("current");
    if context.installation.root.starts_with(&runtime) {
        // Already running from the installed copy.
        return Ok((current.join("host/counterpart-host"), false));
    }
    let id = build_id(&context.installation)?;
    let target = runtime.join(&id);
    if !target.join("host/counterpart-host").is_file() {
        let staging = runtime.join(format!(".staging-{}", uuid::Uuid::new_v4()));
        let copied = Command::new("/bin/cp").arg("-a").arg("--").arg(&context.installation.root).arg(&staging)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status()?;
        if !copied.success() {
            let _ = fs::remove_dir_all(&staging);
            return Err(io::Error::other("Counterpart could not copy its runtime into your data folder; check free disk space"));
        }
        if target.exists() { fs::remove_dir_all(&target)?; }
        fs::rename(&staging, &target)?;
    }
    let previous = fs::read_link(&current).ok();
    let changed = previous.as_deref() != Some(Path::new(&id));
    if changed {
        let link = runtime.join(format!(".current-{}", uuid::Uuid::new_v4()));
        std::os::unix::fs::symlink(&id, &link)?;
        fs::rename(&link, &current)?;
    }
    Ok((current.join("host/counterpart-host"), changed))
}

/// Older runtime copies once the new one is selected and running.
fn prune_runtimes(context: &Context) {
    let runtime = context.runtime();
    let Ok(current) = fs::read_link(runtime.join("current")) else { return };
    let Ok(entries) = fs::read_dir(&runtime) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name == "current" || Path::new(&name) == current { continue; }
        if context.installation.root == entry.path() { continue; }
        let _ = fs::remove_dir_all(entry.path());
    }
}

fn lan_address(context: &Context) -> io::Result<String> {
    let module = context.installation.companion("lan-addresses.js");
    let url = format!("file://{}", module.display());
    let script = format!("const {{discoverAddresses}}=await import({});process.stdout.write(JSON.stringify(discoverAddresses()))", serde_json::to_string(&url).unwrap());
    let out = process::run(&context.installation.node(), &["--input-type=module", "-e", &script], &node_env(context), Some(&context.installation.source()), None, Duration::from_secs(20))?;
    let value: Value = serde_json::from_slice(&out.stdout).map_err(|_| io::Error::other("Counterpart could not list this computer's network addresses"))?;
    value["lan"].as_array().and_then(|list| list.first()).and_then(Value::as_str).map(str::to_owned).ok_or_else(|| io::Error::other(
        "No private network address was found on a wired or Wi-Fi connection. Connect this computer to your home or office network, then run setup again."))
}

fn single_quoted(value: &str) -> io::Result<String> {
    if value.contains('\'') || value.contains('\n') { return Err(io::Error::other("Unsupported character in Counterpart's data folder path")); }
    Ok(format!("'{value}'"))
}

/// LAN TLS, pairing auth, companion.env and an empty printer configuration.
/// Each piece is created only when missing; existing state is never replaced.
fn initialize_state(context: &Context) -> io::Result<()> {
    let uid = context.account.uid;
    paths::private_dir(&context.state, uid)?;
    let env_file = context.env_file();
    let handoff = context.state.join("printer-handoff.json");
    let handoff_dir = context.state.join("printer-handoff");
    let handoff_lines = format!(
        "SCAN_TO_MAKE_PRINTER_HANDOFF_CONFIG={}\nSCAN_TO_MAKE_PRINTER_HANDOFF_DIR={}\n",
        single_quoted(&handoff.display().to_string())?, single_quoted(&handoff_dir.display().to_string())?
    );
    if !env_file.exists() {
        let text = format!("SCAN_TO_MAKE_GENERATION_PORT={DEFAULT_PORT}\nMCP_TRANSPORT=stdio\n{handoff_lines}");
        match OpenOptions::new().write(true).create_new(true).mode(0o600).open(&env_file) {
            Ok(mut file) => { file.write_all(text.as_bytes())?; file.sync_all()?; }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    } else {
        let existing = parse_env_file(context, &env_file)?;
        if !existing.contains_key("SCAN_TO_MAKE_PRINTER_HANDOFF_CONFIG") && !existing.contains_key("SCAN_TO_MAKE_PRINTER_HANDOFF_DIR") {
            let mut file = OpenOptions::new().append(true).open(&env_file)?;
            file.write_all(format!("\n{handoff_lines}").as_bytes())?;
        }
    }
    let env = parse_env_file(context, &env_file)?;
    let port = env.get("SCAN_TO_MAKE_GENERATION_PORT").cloned().unwrap_or_else(|| DEFAULT_PORT.into());
    if !port.bytes().all(|b| b.is_ascii_digit()) || port.parse::<u16>().map_or(true, |p| p == 0) {
        return Err(io::Error::other("SCAN_TO_MAKE_GENERATION_PORT in companion.env must be a port number"));
    }

    // The printer MCP is the backend: the default points at the app's own copy of
    // bambu-printer-mcp, which Settings → Printers → Download installs from npm.
    // Nothing is vendored here; until Download, the printer list stays empty.
    if !handoff.exists() && env.get("SCAN_TO_MAKE_PRINTER_HANDOFF_CONFIG").map(PathBuf::from).as_deref() == Some(handoff.as_path()) {
        let entry = context.state.join("printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js");
        let config = json!({"backend": "bambu-printer-mcp", "process": {"command": "node", "args": [entry.display().to_string()]}});
        match OpenOptions::new().write(true).create_new(true).mode(0o600).open(&handoff) {
            Ok(mut file) => file.write_all(format!("{}\n", serde_json::to_string_pretty(&config).unwrap()).as_bytes())?,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    if env.get("SCAN_TO_MAKE_PRINTER_HANDOFF_DIR").map(PathBuf::from).as_deref() == Some(handoff_dir.as_path()) {
        paths::private_dir(&handoff_dir, uid)?;
    }

    if context.auth().join("auth.json").is_file() {
        return Ok(()); // Pinned identity is kept across address changes and reinstalls.
    }
    let address = lan_address(context)?;
    let python = context.installation.bundled_python().unwrap_or_else(|| PathBuf::from("/usr/bin/python3"));
    if !paths::executable(&python) {
        return Err(io::Error::other("Counterpart needs Python 3 (/usr/bin/python3) to create its network certificate. Install python3, then run setup again."));
    }
    let tls_env = BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into()), ("HOME".into(), context.account.home.display().to_string()), ("LANG".into(), "C.UTF-8".into())]);
    let tls = context.state.join("tls");
    let script = context.installation.source().join("deploy/companion/generate-lan-tls.py");
    let out = process::run(&python, &["-B", script.to_str().unwrap(), tls.to_str().unwrap(), &address], &tls_env, None, None, Duration::from_secs(60))?;
    if out.status != 0 {
        return Err(io::Error::other("Counterpart could not create its network certificate. Make sure openssl is installed, then run setup again."));
    }
    let cli = context.installation.companion("remote-auth-cli.js");
    let origin = if port == "443" { format!("https://{address}") } else { format!("https://{address}:{port}") };
    let auth = context.auth();
    let cert = tls.join("cert.pem");
    let out = process::run(&context.installation.node(), &[cli.to_str().unwrap(), "init-lan", auth.to_str().unwrap(), &origin, cert.to_str().unwrap()],
        &node_env(context), Some(&context.installation.source()), None, Duration::from_secs(60))?;
    if out.status != 0 {
        return Err(io::Error::other("Counterpart could not set up pairing. If this computer's network address changed since a previous setup, remove the incomplete tls folder in Counterpart's data folder and run setup again."));
    }
    Ok(())
}

pub fn setup(context: &Context) -> io::Result<Value> {
    unsafe { libc::umask(0o077) };
    context.installation.require_payload()?;
    initialize_state(context)?;
    let (executable, runtime_changed) = install_runtime(context)?;
    let unit = unit_text(&executable);
    let unit_file = context.unit_file();
    let unit_changed = fs::read_to_string(&unit_file).ok().as_deref() != Some(unit.as_str());
    if unit_changed { write_atomic(&unit_file, unit.as_bytes(), 0o644)?; }
    let failed = |what: &str| io::Error::other(format!("systemd could not {what} Counterpart's user service. Check `systemctl --user status {UNIT}`."));
    if systemctl(context, &["daemon-reload"])? != 0 { return Err(failed("reload")); }
    if systemctl(context, &["enable", UNIT])? != 0 { return Err(failed("enable")); }
    // A running service keeps its jobs; it restarts only to apply a changed runtime or unit.
    let action = if active(context) { if unit_changed || runtime_changed { "restart" } else { "" } } else { "start" };
    if !action.is_empty() && systemctl(context, &[action, UNIT])? != 0 { return Err(failed(action)); }
    wait_ready(context, Duration::from_secs(45));
    if runtime_changed && active(context) { prune_runtimes(context); }
    Ok(status(context))
}

pub fn service(context: &Context, action: &str) -> io::Result<Value> {
    match action {
        "start" => {
            if !context.configured() { return Err(io::Error::other("Counterpart is not set up on this computer yet. Run setup first.")); }
            if systemctl(context, &["start", UNIT])? != 0 { return Err(io::Error::other(format!("systemd could not start {UNIT}"))); }
            wait_ready(context, Duration::from_secs(45));
        }
        "stop" => {
            if context.unit_file().is_file() && systemctl(context, &["stop", UNIT])? != 0 {
                return Err(io::Error::other(format!("systemd could not stop {UNIT}")));
            }
        }
        _ => return Err(io::Error::other("Usage: counterpart-host service start|stop")),
    }
    Ok(status(context))
}

// ---- serve ----------------------------------------------------------------------------

static PENDING: AtomicI32 = AtomicI32::new(0);
extern "C" fn record(signal: libc::c_int) { PENDING.store(signal, Ordering::SeqCst); }

fn runnable(path: &Path) -> bool { path.is_absolute() && paths::executable(path) }

/// `command -v claude` in the user's login shell, then the usual install places
/// (agent.mjs findClaude). The shell starts from a minimal environment.
fn find_claude(context: &Context, env: &BTreeMap<String, String>) -> Option<String> {
    let home = &context.account.home;
    let shell = env.get("SHELL").map(PathBuf::from).filter(|s| s.is_absolute()).or(context.account.shell.clone()).unwrap_or_else(|| PathBuf::from("/bin/sh"));
    let mark = "__SCAN_TO_MAKE_CLAUDE__";
    let shell_env = BTreeMap::from([
        ("HOME".into(), home.display().to_string()), ("USER".into(), context.account.name.clone()), ("LOGNAME".into(), context.account.name.clone()),
        ("SHELL".into(), shell.display().to_string()), ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()), ("TERM".into(), "dumb".into()),
    ]);
    let script = format!("printf '%s' {mark}; command -v claude; printf '%s' {mark}");
    let from_shell = process::run(&shell, &["-ilc", &script], &shell_env, None, None, Duration::from_secs(5)).ok().and_then(|out| {
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let parts: Vec<&str> = text.split(mark).collect();
        (parts.len() >= 3).then(|| parts[1].trim().to_owned())
    });
    let places = [from_shell.map(PathBuf::from), Some(home.join(".local/bin/claude")), Some(home.join(".claude/local/claude")),
        Some(PathBuf::from("/usr/local/bin/claude")), Some(PathBuf::from("/usr/bin/claude"))];
    places.into_iter().flatten().find(|p| runnable(p)).map(|p| p.display().to_string())
}

pub fn serve_environment(context: &Context, inherited: BTreeMap<String, String>, saved: BTreeMap<String, String>) -> BTreeMap<String, String> {
    let installation = &context.installation;
    let state = &context.state;
    let mut env = inherited;
    // process.loadEnvFile semantics: companion.env never overrides the service environment.
    for (key, value) in saved { env.entry(key).or_insert(value); }
    let node_bin = installation.node().parent().unwrap().display().to_string();
    let mut path = vec![node_bin];
    if let Some(python) = installation.bundled_python() { path.push(python.parent().unwrap().display().to_string()); }
    path.push(context.account.home.join(".local/bin").display().to_string());
    path.extend(["/usr/local/bin", "/usr/bin", "/bin"].map(String::from));
    let python = env.get("SCAN_TO_MAKE_CAPTURE_PYTHON").filter(|p| Path::new(p).is_absolute()).cloned()
        .or_else(|| installation.bundled_python().map(|p| p.display().to_string())).unwrap_or_else(|| "/usr/bin/python3".into());
    let fixed = [
        ("PYTHONDONTWRITEBYTECODE", "1".to_owned()),
        ("PATH", path.join(":")),
        ("HOME", context.account.home.display().to_string()),
        ("SCAN_TO_MAKE_REMOTE_AUTH_DIR", state.join("auth").display().to_string()),
        ("SCAN_TO_MAKE_CAPTURE_DIR", state.join("capture").display().to_string()),
        // Printer MCPs run under the bundled Node, whatever node a profile names.
        ("SCAN_TO_MAKE_PRINTER_NODE", installation.node().display().to_string()),
        ("SCAN_TO_MAKE_CAPTURE_PYTHON", python),
        // This helper alone resolves keys; the companion never sees one.
        ("SCAN_TO_MAKE_MODEL_WORKER", installation.exe.display().to_string()),
        ("SCAN_TO_MAKE_CONTROL_SOCKET", context.socket().display().to_string()),
    ];
    for (key, value) in fixed { env.insert(key.into(), value); }
    if state.join("tls/cert.pem").is_file() {
        env.insert("SCAN_TO_MAKE_LAN_TLS_CERT".into(), state.join("tls/cert.pem").display().to_string());
        env.insert("SCAN_TO_MAKE_LAN_TLS_KEY".into(), state.join("tls/key.pem").display().to_string());
    }
    env
}

pub fn serve(context: &Context) -> io::Result<i32> {
    unsafe { libc::umask(0o077) };
    context.installation.require_payload()?;
    if !context.auth().join("auth.json").is_file() {
        return Err(io::Error::other("Counterpart is not set up on this computer yet. Run setup first."));
    }
    let saved = parse_env_file(context, &context.env_file())?;
    let mut env = serve_environment(context, inherited(), saved);
    if !env.get("SCAN_TO_MAKE_CLAUDE_PATH").is_some_and(|p| Path::new(p).is_absolute()) {
        env.remove("SCAN_TO_MAKE_CLAUDE_PATH");
        if let Some(claude) = find_claude(context, &env) { env.insert("SCAN_TO_MAKE_CLAUDE_PATH".into(), claude); }
    }
    let logs = context.state.join("logs");
    paths::private_dir(&logs, context.account.uid)?;
    let log = |name: &str| OpenOptions::new().create(true).append(true).mode(0o600).open(logs.join(name));
    let (out, err) = (log("companion.log")?, log("companion-error.log")?);
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = record as *const () as usize;
            libc::sigaction(signal, &action, std::ptr::null_mut());
        }
    }
    let mut child = Command::new(context.installation.node()).arg(context.installation.companion("server-cli.js"))
        .current_dir(context.installation.source()).env_clear().envs(&env)
        .stdin(Stdio::null()).stdout(out).stderr(err).spawn()?;
    let mut forwarded = false;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status.code().unwrap_or(1));
        }
        let signal = PENDING.load(Ordering::SeqCst);
        if signal != 0 && !forwarded {
            // The companion closes its listeners and MCP sessions on SIGTERM.
            let forward = if signal == libc::SIGHUP { libc::SIGTERM } else { signal };
            unsafe { libc::kill(child.id() as i32, forward) };
            forwarded = true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
