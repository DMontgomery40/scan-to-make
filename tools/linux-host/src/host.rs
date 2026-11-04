//! `status`, `setup`, `serve` and `service start|stop`: the Linux counterpart of the
//! Mac app's `configure`/`serve` (apps/mac/Resources/agent.mjs, App/Runtime.swift).
use crate::paths::{self, Account, Installation};
use crate::process::{self, inherited};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
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
    fn applied_build_file(&self) -> PathBuf { self.state.join("applied-build-id") }
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
    // Its stderr is not kept: a parse error could quote a value from the file.
    let out = process::run(&context.installation.node(), &["--input-type=module", "-e", script, path], &node_env(context), None, None, Duration::from_secs(20))
        .map_err(|e| io::Error::other(format!("Counterpart's bundled Node could not run to read {path} ({e}). Reinstall Counterpart.")))?;
    if out.status != 0 { return Err(io::Error::other(format!("{path} could not be read (Node exit {}). Check that it is a readable KEY=value file.", out.status))); }
    let value: BTreeMap<String, Value> = serde_json::from_slice(&out.stdout).map_err(|_| io::Error::other(format!("{path} could not be read")))?;
    Ok(value.into_iter().filter_map(|(k, v)| v.as_str().map(|v| (k, v.to_owned()))).collect())
}

fn connectable(socket: &Path) -> bool { UnixStream::connect(socket).is_ok() }

/// `<state>/logs/setup.log` (0600): the failing step, its exit status and its bounded stderr,
/// for steps whose output never carries a secret. Returns the log path for the user message.
fn diagnose(context: &Context, step: &str, status: Option<i32>, stderr: &[u8]) -> String {
    let logs = context.state.join("logs");
    let path = logs.join("setup.log");
    let written = paths::private_dir(&logs, context.account.uid).and_then(|_| {
        let mut file = OpenOptions::new().create(true).append(true).mode(0o600).open(&path)?;
        let when = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let text = String::from_utf8_lossy(&stderr[..stderr.len().min(8192)]).replace('\0', "");
        let status = status.map_or("did not finish".to_owned(), |code| format!("exit {code}"));
        writeln!(file, "[{when}] {step}: {status}\n{}\n", text.trim_end())
    });
    match written { Ok(()) => path.display().to_string(), Err(_) => "(the setup log could not be written)".to_owned() }
}

/// A runtime step that failed to run at all (missing module, broken install) is not a user's network problem.
fn runtime_failure(context: &Context, step: &str, result: &io::Result<process::Output>) -> io::Error {
    let log = match result {
        Ok(out) => diagnose(context, step, Some(out.status), &out.stderr),
        Err(error) => diagnose(context, step, None, error.to_string().as_bytes()),
    };
    io::Error::other(format!("Counterpart's runtime failed while it {step}, so its installation is incomplete or damaged. Reinstall Counterpart; details: {log}"))
}

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
    let out = process::run(Path::new("/usr/bin/systemctl"), &full, &systemctl_env(context), None, None, Duration::from_secs(60))?;
    if out.status != 0 && args.first() != Some(&"is-active") && context.state.is_dir() {
        diagnose(context, &format!("ran systemctl --user {}", args.join(" ")), Some(out.status), &out.stderr);
    }
    Ok(out.status)
}

fn active(context: &Context) -> bool { systemctl(context, &["is-active", "--quiet", UNIT]).map(|s| s == 0).unwrap_or(false) }

/// The user service's main PID, so a restart can prove the old process is gone.
fn main_pid(context: &Context) -> Option<u32> {
    let out = process::run(
        Path::new("/usr/bin/systemctl"),
        &["--user", "show", "-p", "MainPID", "--value", UNIT],
        &systemctl_env(context),
        None,
        None,
        Duration::from_secs(20),
    )
    .ok()?;
    if out.status != 0 { return None; }
    String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().ok().filter(|pid| *pid > 0)
}

pub fn status(context: &Context) -> Value {
    let socket = context.socket();
    json!({
        "configured": context.configured(),
        "running": context.unit_file().is_file() && active(context) && connectable(&socket),
        "buildId": intended_build_id(context).ok(),
        "appliedBuildId": read_applied_build_id(&context.applied_build_file()),
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

pub fn parse_build_id(text: &str) -> io::Result<String> {
    let id = text.trim().to_owned();
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.') {
        return Err(io::Error::other("Invalid BUILD-ID"));
    }
    Ok(id)
}

fn build_id_at(root: &Path) -> io::Result<String> {
    let text = fs::read_to_string(root.join("BUILD-ID")).map_err(|_| io::Error::other("This Counterpart runtime has no BUILD-ID; rebuild it with tools/linux-host/prepare-payload.sh"))?;
    parse_build_id(&text)
}

fn build_id(installation: &Installation) -> io::Result<String> { build_id_at(&installation.root) }

/// The build this setup should leave running. A helper already inside the copied
/// runtime names the `current` copy, never an older sibling it happened to start from.
fn intended_build_id(context: &Context) -> io::Result<String> {
    let runtime = context.runtime();
    if context.installation.root.starts_with(&runtime) {
        let current = runtime.join("current");
        if current.join("BUILD-ID").is_file() { return build_id_at(&current); }
    }
    build_id(&context.installation)
}

/// The build the service last proved it is running (recorded only once it answers
/// on its control socket). A missing or unreadable record means "not applied yet":
/// the next setup must still (re)start the service to apply the intended build.
pub fn read_applied_build_id(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().and_then(|text| parse_build_id(&text).ok())
}

pub fn record_applied_build_id(path: &Path, id: &str) -> io::Result<()> {
    let id = parse_build_id(id)?;
    write_atomic(path, format!("{id}\n").as_bytes(), 0o600)
}

/// Whether applying `intended` still needs a (re)start. `linked` is only for a
/// copied runtime: true when its `current` link already names `intended`.
/// A failed earlier restart leaves the link right but the applied build old,
/// so the link alone must never count as applied.
pub fn runtime_change_pending(intended: &str, applied: Option<&str>, linked: Option<bool>) -> bool {
    applied != Some(intended) || linked == Some(false)
}

fn pending_runtime_change(context: &Context, intended: &str) -> bool {
    let applied = read_applied_build_id(&context.applied_build_file());
    let linked = if stable_root(context) {
        None
    } else {
        Some(fs::read_link(context.runtime().join("current")).ok().as_deref() == Some(Path::new(intended)))
    };
    runtime_change_pending(intended, applied.as_deref(), linked)
}

/// The helper the user unit runs, installing a stable runtime copy when needed.
/// Returns whether the applied runtime must change: for a system package at a
/// stable path (/usr, /opt) the path does not change across upgrades, so the
/// BUILD-ID decides; a same-build setup keeps the live service untouched.
fn install_runtime(context: &Context, intended: &str) -> io::Result<(PathBuf, bool)> {
    if stable_root(context) && !context.installation.root.starts_with(context.runtime()) {
        let exe = context.installation.root.join("host/counterpart-host");
        return Ok((exe, pending_runtime_change(context, intended)));
    }
    let runtime = context.runtime();
    paths::private_dir(&runtime, context.account.uid)?;
    let current = runtime.join("current");
    if context.installation.root.starts_with(&runtime) {
        // Already running from the installed copy; only an unapplied build is a change.
        return Ok((current.join("host/counterpart-host"), pending_runtime_change(context, intended)));
    }
    let id = intended.to_owned();
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
    let link_changed = previous.as_deref() != Some(Path::new(&id));
    // A link already naming this build does not prove the service runs it:
    // an earlier restart may have failed after the link flipped.
    let changed = link_changed || read_applied_build_id(&context.applied_build_file()).as_deref() != Some(id.as_str());
    if link_changed {
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
    let step = "listed this computer's network addresses";
    let result = process::run(&context.installation.node(), &["--input-type=module", "-e", &script], &node_env(context), Some(&context.installation.source()), None, Duration::from_secs(20));
    let value: Option<Value> = match &result {
        Ok(out) if out.status == 0 => serde_json::from_slice(&out.stdout).ok(),
        _ => None,
    };
    let Some(value) = value.filter(|v| v["lan"].is_array()) else { return Err(runtime_failure(context, step, &result)) };
    value["lan"].as_array().and_then(|list| list.first()).and_then(Value::as_str).map(str::to_owned).ok_or_else(|| io::Error::other(
        "No private network address was found on a wired or Wi-Fi connection. Connect this computer to your home or office network, then run setup again."))
}

fn single_quoted(value: &str) -> io::Result<String> {
    if value.contains('\'') || value.contains('\n') { return Err(io::Error::other("Unsupported character in Counterpart's data folder path")); }
    Ok(format!("'{value}'"))
}

pub fn default_printer_config(state: &Path, node: &Path) -> Value {
    let entry = state.join("printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js");
    json!({"backend": "bambu-printer-mcp", "process": {"command": node.display().to_string(), "args": [entry.display().to_string()]}})
}

/// Creates the default printer configuration, naming the service runtime's absolute Node
/// (the companion's schema requires an absolute command; SCAN_TO_MAKE_PRINTER_NODE pins it at
/// run time). An existing file is left alone, except the exact relative-`node` default an
/// earlier helper build generated, which the companion refuses to load.
pub fn write_default_printer_config(path: &Path, state: &Path, node: &Path) -> io::Result<()> {
    if !node.is_absolute() { return Err(io::Error::other("Invalid runtime Node path")); }
    let config = default_printer_config(state, node);
    let text = format!("{}\n", serde_json::to_string_pretty(&config).unwrap());
    match fs::read(path) {
        Ok(bytes) => {
            let earlier = json!({"backend": "bambu-printer-mcp", "process": {"command": "node", "args": [config["process"]["args"][0].clone()]}});
            if serde_json::from_slice::<Value>(&bytes).ok().as_ref() == Some(&earlier) { write_atomic(path, text.as_bytes(), 0o600)?; }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => match OpenOptions::new().write(true).create_new(true).mode(0o600).open(path) {
            Ok(mut file) => file.write_all(text.as_bytes()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error),
        },
        Err(error) => Err(error),
    }
}

/// LAN TLS, pairing auth, companion.env and an empty printer configuration.
/// Each piece is created only when missing; existing state is never replaced.
fn initialize_state(context: &Context, node: &Path) -> io::Result<()> {
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
    if env.get("SCAN_TO_MAKE_PRINTER_HANDOFF_CONFIG").map(PathBuf::from).as_deref() == Some(handoff.as_path()) {
        write_default_printer_config(&handoff, &context.state, node)?;
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
    let result = process::run(&python, &["-B", script.to_str().unwrap(), tls.to_str().unwrap(), &address], &tls_env, None, None, Duration::from_secs(60));
    if !matches!(&result, Ok(out) if out.status == 0) {
        let log = match &result { Ok(out) => diagnose(context, "created the network certificate", Some(out.status), &out.stderr), Err(e) => diagnose(context, "created the network certificate", None, e.to_string().as_bytes()) };
        return Err(io::Error::other(format!("Counterpart could not create its network certificate. Make sure openssl is installed, then run setup again; details: {log}")));
    }
    let cli = context.installation.companion("remote-auth-cli.js");
    let origin = if port == "443" { format!("https://{address}") } else { format!("https://{address}:{port}") };
    let auth = context.auth();
    let cert = tls.join("cert.pem");
    // init-lan prints nothing secret on stderr (its stdout, never kept, is the store summary).
    let result = process::run(&context.installation.node(), &[cli.to_str().unwrap(), "init-lan", auth.to_str().unwrap(), &origin, cert.to_str().unwrap()],
        &node_env(context), Some(&context.installation.source()), None, Duration::from_secs(60));
    if !matches!(&result, Ok(out) if out.status == 0) {
        let log = match &result { Ok(out) => diagnose(context, "set up pairing", Some(out.status), &out.stderr), Err(e) => diagnose(context, "set up pairing", None, e.to_string().as_bytes()) };
        return Err(io::Error::other(format!("Counterpart could not set up pairing. If this computer's network address changed since a previous setup, remove the incomplete tls folder in {} and run setup again; details: {log}", context.state.display())));
    }
    Ok(())
}

/// One bounded, read-only request on the companion's private control socket,
/// in its own framing ({v,id,method,params} per line). Never a mutation.
fn control_request(context: &Context, method: &str, params: Value) -> io::Result<Value> {
    let socket = context.socket();
    let meta = fs::symlink_metadata(&socket)?;
    let parent = socket.parent().ok_or_else(|| io::Error::other("Invalid control socket"))?;
    if !meta.file_type().is_socket() || meta.uid() != context.account.uid || meta.mode() & 0o077 != 0 || !paths::is_private_dir(parent, context.account.uid) {
        return Err(io::Error::other("The companion socket is not private to your account"));
    }
    let mut stream = UnixStream::connect(&socket)?;
    stream.set_read_timeout(Some(Duration::from_secs(12)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut bytes = serde_json::to_vec(&json!({"v": 1, "id": id, "method": method, "params": params}))
        .map_err(|_| io::Error::other("Invalid control request"))?;
    bytes.push(b'\n');
    stream.write_all(&bytes)?;
    let mut reply = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        if let Some(end) = reply.iter().position(|b| *b == b'\n') { reply.truncate(end); break; }
        if reply.len() > 8 * 1024 * 1024 { return Err(io::Error::other("The companion reply exceeded the size limit")); }
        let read = stream.read(&mut buffer)?;
        if read == 0 { return Err(io::Error::other("The companion closed the request")); }
        reply.extend_from_slice(&buffer[..read]);
    }
    let envelope: Value = serde_json::from_slice(&reply).map_err(|_| io::Error::other("The companion returned an invalid reply"))?;
    if envelope["v"] != 1 || envelope["id"] != id.as_str() || envelope.get("result").is_some() == envelope.get("error").is_some() {
        return Err(io::Error::other("The companion reply did not match this request"));
    }
    if envelope.get("error").is_some() { return Err(io::Error::other("The companion refused this request")); }
    Ok(envelope["result"].clone())
}

/// A project being modeled right now (`touching-up`). A print already
/// dispatched keeps going on the printer across a restart, so it is not busy.
pub fn objects_busy(result: &Value) -> Option<bool> {
    let objects = result.get("objects")?.as_array()?;
    Some(objects.iter().any(|object| object.get("state").and_then(Value::as_str) == Some("touching-up")))
}

/// A scan-cleanup job waiting or running. Print handoffs are not modeling.
pub fn cleanup_jobs_busy(result: &Value) -> Option<bool> {
    let items = result.get("items")?.as_array()?;
    let mut busy = false;
    for item in items {
        if item.get("kind").and_then(Value::as_str) != Some("cleanup") { continue; }
        let status = item.get("job")?.get("status")?.as_str()?;
        busy |= status == "queued" || status == "running";
    }
    Some(busy)
}

/// Whether the running companion is modeling. Restarting it aborts that work
/// (the next start records the pass interrupted), so setup asks first and
/// refuses to restart rather than silently discarding it.
fn companion_busy(context: &Context) -> io::Result<bool> {
    let invalid = || io::Error::other("The companion returned an unexpected work list");
    if objects_busy(&control_request(context, "objects.list", json!({}))?).ok_or_else(invalid)? { return Ok(true); }
    let mut cursor: Option<String> = None;
    for _ in 0..50 {
        let mut params = json!({"limit": 100});
        if let Some(cursor) = &cursor { params["cursor"] = json!(cursor); }
        let page = control_request(context, "jobs.list", params)?;
        if cleanup_jobs_busy(&page).ok_or_else(invalid)? { return Ok(true); }
        match page.get("nextCursor").and_then(Value::as_str) {
            Some(next) => cursor = Some(next.to_owned()),
            None => return Ok(false),
        }
    }
    Err(io::Error::other("The companion's work list is too long to check"))
}

pub fn setup(context: &Context) -> io::Result<Value> {
    unsafe { libc::umask(0o077) };
    context.installation.require_payload()?;
    paths::private_dir(&context.state, context.account.uid)?;
    let intended = intended_build_id(context)?;
    let (executable, runtime_changed) = install_runtime(context, &intended)?;
    // The Node of the runtime the service runs (a stable `current` link for a copied runtime).
    let node = executable.parent().and_then(Path::parent).ok_or_else(|| io::Error::other("Invalid helper location"))?.join("Payload/node/bin/node");
    initialize_state(context, &node)?;
    let unit = unit_text(&executable);
    let unit_file = context.unit_file();
    let unit_changed = fs::read_to_string(&unit_file).ok().as_deref() != Some(unit.as_str());
    if unit_changed { write_atomic(&unit_file, unit.as_bytes(), 0o644)?; }
    let log = context.state.join("logs/setup.log");
    let failed = |what: &str| io::Error::other(format!("systemd could not {what} Counterpart's user service. Check `systemctl --user status {UNIT}` and {}.", log.display()));
    if systemctl(context, &["daemon-reload"])? != 0 { return Err(failed("reload")); }
    if systemctl(context, &["enable", UNIT])? != 0 { return Err(failed("enable")); }
    // A running service keeps its jobs; it restarts only to apply a changed runtime or unit.
    let action = if active(context) { if unit_changed || runtime_changed { "restart" } else { "" } } else { "start" };
    if action == "restart" {
        // Checked as late as possible, so work started during this setup is seen.
        // The running companion resolved its files through the old runtime copy at
        // startup, so the link/unit written above do not disturb it; refusing here
        // keeps it and its jobs, and the unrecorded build makes a later setup retry.
        match companion_busy(context) {
            Ok(true) => return Err(io::Error::other(
                "Counterpart is working on a project, so setup didn't restart it to apply the new version. Wait for that work to finish, then run Repair setup again. Your projects and settings are unchanged.")),
            Ok(false) => {}
            Err(error) => {
                diagnose(context, "checked whether project work is running before restarting", None, error.to_string().as_bytes());
                return Err(io::Error::other(
                    "Counterpart couldn't check whether project work is running, so setup didn't restart it to apply the new version. Run Repair setup again. If it stays stuck, stop the companion first; stopping interrupts active work."));
            }
        }
    }
    let before_pid = if action == "restart" { main_pid(context) } else { None };
    // A failed restart returns here: the intended build is not recorded as applied,
    // and the old runtime copy is not pruned, so a later setup retries the upgrade.
    if !action.is_empty() && systemctl(context, &[action, UNIT])? != 0 { return Err(failed(action)); }
    let ready = wait_ready(context, Duration::from_secs(45));
    // Applied is proved, not assumed: the service answers, is active, and after a
    // restart is a different process than the one setup found running.
    let applied = ready && active(context) && (action != "restart" || before_pid.is_none() || main_pid(context) != before_pid);
    if applied && record_applied_build_id(&context.applied_build_file(), &intended).is_err() {
        diagnose(context, "recorded the applied build", None, b"the applied-build record could not be written");
    }
    if runtime_changed && applied { prune_runtimes(context); }
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
        // Preserve the install/update target without advertising an unconfigured printer.
        ("SCAN_TO_MAKE_DEFAULT_PRINTER_ENTRY", default_printer_config(state, &installation.node())["process"]["args"][0].as_str().unwrap().to_owned()),
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
    // This process records the build it actually serves, once the companion
    // answers, so a package replaced at the same path while this process keeps
    // running is still applied by the next setup (the id is read now, not later).
    let serving_build = build_id(&context.installation).ok();
    let mut recorded = serving_build.is_none();
    let mut ticks = 0u32;
    let mut forwarded = false;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status.code().unwrap_or(1));
        }
        ticks = ticks.wrapping_add(1);
        if !recorded && ticks % 10 == 1 && connectable(&context.socket()) {
            if let Some(id) = &serving_build {
                recorded = record_applied_build_id(&context.applied_build_file(), id).is_ok();
            }
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
