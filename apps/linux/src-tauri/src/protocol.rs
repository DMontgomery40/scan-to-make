use serde_json::{json, Value};
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::time::{timeout, Duration};
pub const MAX_REQUEST: usize = 64 * 1024;
pub const MAX_RESPONSE: usize = 8 * 1024 * 1024;
// Intentionally excludes arbitrary local paths, Apple-only capabilities, and worker execution.
pub fn allowed(method: &str) -> bool {
    matches!(
        method,
        "status.get"
            | "jobs.list"
            | "objects.list"
            | "objects.get"
            | "objects.create"
            | "objects.addStarter"
            | "objects.start"
            | "objects.correct"
            | "objects.delete"
            | "objects.duplicate"
            | "objects.settings.get"
            | "objects.settings.set"
            | "objects.passActivity"
            | "objects.printers"
            | "objects.filaments"
            | "objects.colourMapping"
            | "objects.selectPrinter"
            | "objects.selectPlate"
            | "objects.answerAsk"
            | "objects.answerCloseup"
            | "objects.answerReconstruction"
            | "objects.print"
            | "objects.estimate"
            | "objects.pausePrint"
            | "objects.resumePrint"
            | "objects.cancelPrint"
            | "objects.camera"
            | "objects.answerPrintConfirmation"
            | "confirmations.list"
            | "confirmations.answer"
            | "events.wait"
            | "printers.mcps"
            | "printers.installMcp"
            | "printers.updateMcp"
            | "printers.discover"
            | "printers.check"
            | "printers.add"
            | "printers.remove"
            | "printers.completeSettings"
            | "printers.chooseMcp"
            | "printers.route"
            | "printers.camera"
            | "devices.list"
            | "devices.remove"
            | "pairing.create"
            | "pairing.isActive"
            | "nearby.list"
            | "nearby.answer"
            | "modelAccess.get"
            | "modelAccess.set"
            | "modelAccess.check"
            | "settings.get"
            | "settings.set"
            | "blender.status"
            | "blender.check"
            | "blender.update"
    )
}
pub fn validate(method: &str, params: &Value) -> Result<(), String> {
    if !allowed(method) || !params.is_object() {
        return Err("This operation is not available to this window.".into());
    }
    if method == "objects.correct" && params.get("photos").is_some() {
        return Err("Choose photos using the native file picker.".into());
    }
    if matches!(method, "printers.add" | "printers.check")
        && params.pointer("/printer/folder").is_some()
    {
        return Err("Choose a discovered printer through the native bridge.".into());
    }
    Ok(())
}
pub fn deadline(method: &str, params: &Value) -> u64 {
    // Companion deadlines + two seconds to deliver its bounded reply. Never retry a write.
    match method {
        "objects.correct" | "printers.route" => 27_000,
        // Its slice may take 600 s on the companion (630 s with what it reads first).
        "objects.estimate" => 632_000,
        // A model file of up to 64 MB is read, hashed and kept: 120 s on the companion (Nov 6).
        "objects.addFile" => 122_000,
        "printers.updateMcp" | "printers.installMcp" | "printers.discover" => 17_000,
        "printers.check" => 62_000,
        "printers.add" | "printers.remove" | "printers.chooseMcp" | "printers.completeSettings" => {
            32_000
        }
        "objects.pausePrint" | "objects.resumePrint" | "objects.cancelPrint" => 132_000,
        "events.wait" => {
            params
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(25_000)
                .min(25_000)
                + 7_000
        }
        _ => 12_000,
    }
}
pub fn decode(bytes: &[u8], id: &str) -> Result<Value, String> {
    let envelope: Value =
        serde_json::from_slice(bytes).map_err(|_| "The companion returned an invalid reply.")?;
    // An answer before the request was read (`id: null`, the companion's `busy`) can only be a refusal.
    let unread = envelope["id"].is_null() && envelope.get("error").is_some() && envelope.get("result").is_none();
    if envelope["v"] != 1
        || (envelope["id"] != id && !unread)
        || envelope.get("result").is_some() == envelope.get("error").is_some()
    {
        return Err("The companion reply did not match this request.".into());
    }
    if let Some(error) = envelope.get("error") {
        return Err(error["message"]
            .as_str()
            .unwrap_or("The companion refused this request.")
            .chars()
            .take(4096)
            .collect());
    }
    Ok(envelope["result"].clone())
}
pub async fn request(socket: &Path, method: &str, params: Value) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut bytes = serde_json::to_vec(&json!({"v":1,"id":id,"method":method,"params":params}))
        .map_err(|_| "Invalid request.")?;
    bytes.push(b'\n');
    if bytes.len() > MAX_REQUEST {
        return Err("This request is too large. Send fewer photos or a shorter message.".into());
    }
    let work = async {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        let meta = std::fs::symlink_metadata(socket)
            .map_err(|_| "The companion is not running. Start it in Settings.")?;
        let parent = std::fs::symlink_metadata(socket.parent().ok_or("Invalid control socket.")?)
            .map_err(|_| "Invalid control socket.")?;
        let uid = unsafe { libc::geteuid() };
        if !meta.file_type().is_socket()
            || meta.uid() != uid
            || meta.mode() & 0o077 != 0
            || !parent.is_dir()
            || parent.uid() != uid
            || parent.mode() & 0o077 != 0
        {
            return Err("The companion socket is not private to your account.".into());
        }
        let mut stream = UnixStream::connect(socket)
            .await
            .map_err(|_| "The companion is not answering. Refresh its status.")?;
        if stream
            .peer_cred()
            .map_err(|_| "Cannot verify companion identity.")?
            .uid()
            != uid
        {
            return Err("The companion socket belongs to another user.".into());
        }
        stream.write_all(&bytes).await.map_err(|_| {
            "Connection lost. The operation may have been accepted; refresh before trying again."
        })?;
        let mut reader = BufReader::new(stream);
        let mut reply = Vec::new();
        loop {
            let available = reader
                .fill_buf()
                .await
                .map_err(|_| "Connection lost. Refresh before trying again.")?;
            if available.is_empty() {
                return Err("The companion closed the request. Its outcome may be unknown; refresh before trying again.".into());
            }
            let end = available.iter().position(|b| *b == b'\n');
            let count = end.map(|n| n + 1).unwrap_or(available.len());
            if reply.len() + count > MAX_RESPONSE {
                return Err("The companion reply exceeded the size limit.".into());
            }
            reply.extend_from_slice(&available[..count]);
            reader.consume(count);
            if end.is_some() {
                return decode(&reply, &id);
            }
        }
    };
    timeout(Duration::from_millis(deadline(method,&params)),work).await.map_err(|_|"The companion did not reply in time. The operation may still finish; refresh before trying again.".to_owned())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_path_and_shell_escape_hatches() {
        for method in ["objects.addFile", "doors.prepare", "shell", "fusion.report"] {
            assert!(!allowed(method));
        }
        assert!(validate("objects.correct", &json!({"photos":["/etc/passwd"]})).is_err());
        assert!(allowed("objects.answerReconstruction"));
        assert!(!allowed("objects.reconstructionPreview"));
    }
    #[test]
    fn validates_request_identity() {
        assert!(decode(br#"{"v":1,"id":"other","result":{}}"#, "one").is_err());
        assert!(decode(br#"{"v":1,"id":"one","result":{},"error":{}}"#, "one").is_err());
        assert_eq!(
            decode(br#"{"v":1,"id":"one","result":{"ok":true}}"#, "one").unwrap()["ok"],
            true
        );
        // Nov 6: past its connection limit the companion answers before reading the request (no id); its sentence shows.
        assert_eq!(
            decode(br#"{"v":1,"id":null,"error":{"code":"busy","message":"Your Mac is answering too many requests at once. Try again in a moment."}}"#, "one").unwrap_err(),
            "Your Mac is answering too many requests at once. Try again in a moment."
        );
        assert!(decode(br#"{"v":1,"id":null,"result":{}}"#, "one").is_err());
    }
    #[test]
    fn permits_independent_confirmation_deadlines() {
        assert_eq!(deadline("objects.pausePrint", &json!({})), 132000);
        assert_eq!(deadline("objects.addFile", &json!({})), 122000, "an import outlives the companion's 120 s, never 12 s");
        assert_eq!(deadline("confirmations.answer", &json!({})), 12000);
        assert_eq!(deadline("events.wait", &json!({"timeoutMs":999999})), 32000);
    }
}
#[cfg(test)]
mod socket_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;
    struct Fixture {
        dir: std::path::PathBuf,
        path: std::path::PathBuf,
        listener: UnixListener,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("cp-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&dir).unwrap();
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
            let path = dir.join("control.sock");
            let listener = UnixListener::bind(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            Self {
                dir,
                path,
                listener,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    async fn receive(stream: UnixStream) -> (UnixStream, Value) {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        (reader.into_inner(), serde_json::from_str(&line).unwrap())
    }
    #[tokio::test]
    async fn reads_fragmented_replies() {
        let f = Fixture::new();
        let serve = async {
            let (stream, _) = f.listener.accept().await.unwrap();
            let (mut stream, q) = receive(stream).await;
            let reply =
                serde_json::to_vec(&json!({"v":1,"id":q["id"],"result":{"done":true}})).unwrap();
            for part in reply.chunks(3) {
                stream.write_all(part).await.unwrap();
            }
            stream.write_all(b"\n").await.unwrap();
        };
        let (read, _) = tokio::join!(request(&f.path, "status.get", json!({})), serve);
        assert_eq!(read.unwrap()["done"], true);
    }
    #[tokio::test]
    async fn answer_can_finish_while_control_request_is_pending() {
        let f = Fixture::new();
        let ready = tokio::sync::Notify::new();
        let serve = async {
            let (stream, _) = f.listener.accept().await.unwrap();
            let (mut pending, first) = receive(stream).await;
            assert_eq!(first["method"], "objects.pausePrint");
            ready.notify_one();
            let (stream, _) = f.listener.accept().await.unwrap();
            let (mut answer, second) = receive(stream).await;
            assert_eq!(second["method"], "confirmations.answer");
            for (s, q) in [(&mut answer, &second), (&mut pending, &first)] {
                s.write_all(
                    format!(
                        "{}\n",
                        json!({"v":1,"id":q["id"],"result":{"accepted":true}})
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            }
        };
        let answer = async {
            ready.notified().await;
            request(&f.path, "confirmations.answer", json!({})).await
        };
        let (a, b, _) = tokio::join!(
            request(&f.path, "objects.pausePrint", json!({})),
            answer,
            serve
        );
        assert!(a.is_ok());
        assert!(b.is_ok());
    }
    #[tokio::test]
    async fn disconnect_never_replays_a_mutation() {
        let f = Fixture::new();
        let serve = async {
            let (stream, _) = f.listener.accept().await.unwrap();
            let (stream, q) = receive(stream).await;
            assert_eq!(q["method"], "objects.print");
            drop(stream);
            assert!(timeout(Duration::from_millis(100), f.listener.accept())
                .await
                .is_err());
        };
        let (reply, _) = tokio::join!(request(&f.path, "objects.print", json!({})), serve);
        assert!(reply.unwrap_err().contains("unknown"));
    }
    #[tokio::test]
    async fn refuses_nonprivate_socket() {
        let f = Fixture::new();
        std::fs::set_permissions(&f.path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(request(&f.path, "status.get", json!({}))
            .await
            .unwrap_err()
            .contains("not private"));
    }
    #[tokio::test]
    async fn bounds_requests_before_connecting() {
        assert!(request(
            Path::new("/missing"),
            "objects.correct",
            json!({"note":"x".repeat(MAX_REQUEST)})
        )
        .await
        .unwrap_err()
        .contains("too large"));
    }
    #[tokio::test]
    async fn refuses_oversized_response() {
        let f = Fixture::new();
        let serve = async {
            let (stream, _) = f.listener.accept().await.unwrap();
            let (mut stream, _) = receive(stream).await;
            let _ = stream.write_all(&vec![b'x'; MAX_RESPONSE + 1]).await;
        };
        let (reply, _) = tokio::join!(request(&f.path, "status.get", json!({})), serve);
        assert!(reply.unwrap_err().contains("size limit"));
    }
}
