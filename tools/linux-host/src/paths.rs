//! Locations that never come from a caller. The account comes from the password
//! database; the installation from this executable's own path; state from the
//! account's home. A credential-resolving worker runs with an empty environment,
//! so every mode must reach the same answers without one.
use std::ffi::CStr;
use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub struct Account {
    pub uid: u32,
    pub name: String,
    pub home: PathBuf,
    pub shell: Option<PathBuf>,
}

pub fn account() -> io::Result<Account> {
    let uid = unsafe { libc::getuid() };
    let mut buffer = vec![0u8; 16384];
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let status = unsafe {
        libc::getpwuid_r(uid, &mut entry, buffer.as_mut_ptr().cast(), buffer.len(), &mut result)
    };
    if status != 0 || result.is_null() || entry.pw_dir.is_null() || entry.pw_name.is_null() {
        return Err(io::Error::other("This account has no password-database entry"));
    }
    let text = |pointer: *const libc::c_char| unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned();
    let home = PathBuf::from(text(entry.pw_dir));
    if !home.is_absolute() {
        return Err(io::Error::other("This account's home folder is not an absolute path"));
    }
    let shell = (!entry.pw_shell.is_null()).then(|| PathBuf::from(text(entry.pw_shell))).filter(|s| s.is_absolute());
    Ok(Account { uid, name: text(entry.pw_name), home, shell })
}

/// The installed resource directory: the parent of `host/` holding this executable.
/// Symlinks are resolved first, so a `current` link selects one exact copy.
pub fn installation() -> io::Result<Installation> {
    let exe = fs::canonicalize("/proc/self/exe")?;
    let host = exe.parent().ok_or_else(|| io::Error::other("Invalid helper location"))?;
    if host.file_name().and_then(|n| n.to_str()) != Some("host") {
        return Err(io::Error::other("counterpart-host must run from its installed host/ folder"));
    }
    let root = host.parent().ok_or_else(|| io::Error::other("Invalid helper location"))?.to_path_buf();
    Ok(Installation { exe, root })
}

pub struct Installation {
    pub exe: PathBuf,
    pub root: PathBuf,
}

impl Installation {
    pub fn payload(&self) -> PathBuf { self.root.join("Payload") }
    pub fn node(&self) -> PathBuf { self.payload().join("node/bin/node") }
    pub fn source(&self) -> PathBuf { self.payload().join("source") }
    pub fn companion(&self, script: &str) -> PathBuf { self.source().join("services/companion/dist").join(script) }
    pub fn bundled_python(&self) -> Option<PathBuf> {
        let path = self.payload().join("python/bin/python3");
        executable(&path).then_some(path)
    }
    /// The files the companion cannot start without, including the workspace package links
    /// and npm (Download/Update). A packager that drops symlinks breaks exactly these.
    pub fn require_payload(&self) -> io::Result<()> {
        let source = self.source();
        let required = [
            self.node(),
            self.companion("server-cli.js"),
            self.companion("ai-tweak-cli.js"),
            source.join("services/companion/node_modules/@scan-to-make/contracts/package.json"),
            source.join("services/companion/node_modules/@scan-to-make/printer-handoff/package.json"),
            source.join("services/companion/node_modules/@scan-to-make/project/package.json"),
            source.join("services/project/node_modules/@scan-to-make/contracts/package.json"),
            self.payload().join("node/bin/npm"),
        ];
        // metadata() follows links: a dropped or dangling link is reported by its path.
        let missing: Vec<String> = required.iter().filter(|path| fs::metadata(path).is_err())
            .map(|path| path.strip_prefix(&self.root).unwrap_or(path).display().to_string()).collect();
        if missing.is_empty() && executable(&self.node()) { return Ok(()); }
        Err(io::Error::other(format!(
            "The Counterpart runtime at {} is incomplete (missing {}). Its package must keep the payload's symbolic links; reinstall Counterpart.",
            self.root.display(), if missing.is_empty() { "an executable Node".to_owned() } else { missing.join(", ") })))
    }
}

pub fn executable(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

/// `~/.local/share/counterpart`, the XDG data default. XDG_DATA_HOME is not
/// consulted: the keyed worker cannot see it, and both must name the same state.
pub fn state_dir(account: &Account) -> PathBuf { account.home.join(".local/share/counterpart") }

pub fn config_home(account: &Account) -> PathBuf {
    match std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from) {
        Some(path) if path.is_absolute() => path,
        _ => account.home.join(".config"),
    }
}

pub fn unit_dir(account: &Account) -> PathBuf { config_home(account).join("systemd/user") }

/// A directory owned by this account and closed to everyone else, not a symlink.
pub fn is_private_dir(path: &Path, uid: u32) -> bool {
    fs::symlink_metadata(path).map(|m| m.is_dir() && m.uid() == uid && m.mode() & 0o077 == 0).unwrap_or(false)
}

/// Creates the directory (0700) when missing; refuses one that exists but is not private.
pub fn private_dir(path: &Path, uid: u32) -> io::Result<()> {
    if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    if is_private_dir(path, uid) { Ok(()) } else {
        Err(io::Error::other(format!("{} must be a private folder owned by you (chmod 700)", path.display())))
    }
}

const SOCKET_LIMIT: usize = 107; // sun_path holds 108 bytes including the terminator.

/// The private runtime directory: /run/user/<uid> as logind creates it, then the
/// session's XDG_RUNTIME_DIR, each only when owned and private; else a folder in state.
pub fn runtime_dir(account: &Account) -> Option<PathBuf> {
    let candidates = [Some(PathBuf::from(format!("/run/user/{}", account.uid))), std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from)];
    candidates.into_iter().flatten().find(|path| path.is_absolute() && is_private_dir(path, account.uid))
}

pub fn control_socket(account: &Account) -> PathBuf {
    let preferred = runtime_dir(account).map(|dir| dir.join("counterpart/control.sock"));
    let fallback = state_dir(account).join("run/control.sock");
    let last = PathBuf::from(format!("/tmp/counterpart-{}/control.sock", account.uid));
    [preferred, Some(fallback), Some(last)].into_iter().flatten()
        .find(|path| path.as_os_str().len() <= SOCKET_LIMIT).expect("the /tmp fallback is short")
}

/// The user's session bus, only when it is this account's own socket.
pub fn session_bus(account: &Account) -> Option<String> {
    let runtime = runtime_dir(account)?;
    let bus = runtime.join("bus");
    let meta = fs::symlink_metadata(&bus).ok()?;
    use std::os::unix::fs::FileTypeExt;
    (meta.file_type().is_socket() && meta.uid() == account.uid).then(|| format!("unix:path={}", bus.display()))
}
