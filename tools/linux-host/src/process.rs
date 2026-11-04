//! Bounded child processes. Output is captured in memory and never logged;
//! error messages name the step, never its arguments or output.
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct Output {
    pub status: i32,
    pub stdout: Vec<u8>,
    /// At most 64 KiB. Callers decide whether it may be kept: never for anything secret-bearing.
    pub stderr: Vec<u8>,
}

fn bounded_reader(mut stream: impl Read + Send + 'static, limit: u64) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = (&mut stream).take(limit).read_to_end(&mut buffer);
        // Drain the rest so the child never blocks on a full pipe.
        let _ = io::copy(&mut stream, &mut io::sink());
        buffer
    })
}

/// Runs a command in its own process group with an exact environment, killing the
/// whole group at the deadline (a login shell's background job cannot hold it open).
pub fn run(program: &Path, args: &[&str], env: &BTreeMap<String, String>, cwd: Option<&Path>, input: Option<&[u8]>, timeout: Duration) -> io::Result<Output> {
    let mut command = Command::new(program);
    command.args(args).env_clear().envs(env).stdout(Stdio::piped()).stderr(Stdio::piped())
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
    if let Some(cwd) = cwd { command.current_dir(cwd); }
    unsafe { command.pre_exec(|| { if libc::setpgid(0, 0) != 0 { return Err(io::Error::last_os_error()); } Ok(()) }); }
    let mut child = command.spawn()?;
    let pid = child.id() as i32;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(input);
    }
    let stdout = bounded_reader(child.stdout.take().expect("piped"), 16 * 1024 * 1024);
    let stderr = bounded_reader(child.stderr.take().expect("piped"), 64 * 1024);
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? { break status; }
        if Instant::now() >= deadline {
            unsafe { libc::kill(-pid, libc::SIGKILL) };
            let _ = child.wait();
            return Err(io::Error::new(io::ErrorKind::TimedOut, "timed out"));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    // Descendants that keep stdout open are ended with the group.
    unsafe { libc::kill(-pid, libc::SIGKILL) };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    Ok(Output { status: status.code().unwrap_or(1), stdout, stderr })
}

pub fn inherited() -> BTreeMap<String, String> {
    std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect()
}
