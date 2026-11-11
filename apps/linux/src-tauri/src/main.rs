mod protocol;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{Manager, State};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Semaphore,
    time::{timeout, Duration},
};
struct Bridge {
    regular: Arc<Semaphore>,
    answers: Arc<Semaphore>,
    artifacts: Arc<Semaphore>,
    inputs: Mutex<HashMap<String, (PathBuf, String, Instant)>>,
}
type Result<T> = std::result::Result<T, String>;
async fn helper(app: &tauri::AppHandle, args: &[&str], input: Option<Value>) -> Result<Value> {
    let executable = app
        .path()
        .resource_dir()
        .map_err(|_| "Cannot locate app resources.")?
        .join("host/counterpart-host");
    if !executable.is_file() {
        return Err("The Linux host is missing from this installation. Install a Counterpart package with host/counterpart-host and Payload, then try again.".into());
    }
    let mut child = tokio::process::Command::new(executable)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Could not start the bundled Linux host.")?;
    let mut stdin = child.stdin.take().ok_or("Cannot open helper input.")?;
    let stdout = child.stdout.take().ok_or("Cannot read helper output.")?;
    let stderr = child.stderr.take().ok_or("Cannot read helper error.")?;
    let work = async {
        if let Some(value) = input {
            let mut bytes = serde_json::to_vec(&value).map_err(|_| "Invalid helper input.")?;
            if bytes.len() > 65536 {
                return Err("Helper input is too large.".into());
            }
            bytes.push(b'\n');
            stdin
                .write_all(&bytes)
                .await
                .map_err(|_| "Could not send to the host.")?;
            bytes.fill(0);
        }
        drop(stdin);
        let output = async {
            let mut data = Vec::new();
            stdout
                .take(65537)
                .read_to_end(&mut data)
                .await
                .map_err(|_| "Cannot read host reply.")?;
            Ok::<_, String>(data)
        };
        let errors = async {
            let mut data = Vec::new();
            stderr
                .take(8193)
                .read_to_end(&mut data)
                .await
                .map_err(|_| "Cannot read host status.")?;
            Ok::<_, String>(data)
        };
        let (out, err) = tokio::try_join!(output, errors)?;
        if out.len() > 65536 || err.len() > 8192 {
            return Err("The host reply exceeded the size limit.".into());
        }
        let status = child.wait().await.map_err(|_| "Cannot read host status.")?;
        if !status.success() {
            // Contract promises non-secret, actionable errors. Never display credential payloads.
            let message = String::from_utf8_lossy(&err)
                .trim()
                .chars()
                .take(1500)
                .collect::<String>();
            return Err(if message.is_empty() {
                "The Linux host could not complete this action. Check your desktop session and Secret Service.".into()
            } else {
                message
            });
        }
        serde_json::from_slice(&out).map_err(|_| "The host returned an invalid reply.".into())
    };
    timeout(
        Duration::from_secs(if args == ["setup"] { 120 } else { 30 }),
        work,
    )
    .await
    .map_err(|_| {
        "The host did not reply in time. Refresh status before trying again.".to_string()
    })?
}
async fn socket(app: &tauri::AppHandle) -> Result<PathBuf> {
    let status = helper(app, &["status"], None).await?;
    let path = PathBuf::from(
        status["controlSocket"]
            .as_str()
            .ok_or("The host did not provide its control socket.")?,
    );
    if !path.is_absolute() {
        return Err("Invalid host socket path.".into());
    }
    Ok(path)
}
async fn request(app: &tauri::AppHandle, method: &str, params: Value) -> Result<Value> {
    protocol::request(&socket(app).await?, method, params).await
}
#[tauri::command]
async fn host_action(app: tauri::AppHandle, action: String) -> Result<Value> {
    match action.as_str() {
        "status" => helper(&app, &["status"], None).await,
        "setup" => helper(&app, &["setup"], None).await,
        "start" => helper(&app, &["service", "start"], None).await,
        "stop" => helper(&app, &["service", "stop"], None).await,
        _ => Err("Unknown host action.".into()),
    }
}
#[tauri::command]
async fn control(
    app: tauri::AppHandle,
    state: State<'_, Bridge>,
    method: String,
    params: Value,
) -> Result<Value> {
    protocol::validate(&method, &params)?;
    // Reserve capacity for answers. No mutex is held while waiting for an MCP's question.
    let pool = if matches!(
        method.as_str(),
        "confirmations.answer"
            | "objects.answerPrintConfirmation"
            | "objects.answerReconstruction"
            | "confirmations.list"
    ) {
        &state.answers
    } else {
        &state.regular
    };
    let _permit = pool
        .try_acquire()
        .map_err(|_| "Several requests are already in progress. Wait a moment.")?;
    request(&app, &method, params).await
}
#[tauri::command]
async fn store_credential(
    app: tauri::AppHandle,
    choice: Value,
    mut secret: String,
) -> Result<Value> {
    if !matches!(choice["kind"].as_str(), Some("api" | "endpoint"))
        || secret.is_empty()
        || secret.len() > 16384
    {
        return Err("Enter a key for an API provider or endpoint.".into());
    }
    let input = json!({"choice":choice,"secret":secret});
    secret.clear();
    helper(&app, &["credentials", "store"], Some(input)).await
}
fn relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains('\\')
        && !path.contains('\0')
        && Path::new(path)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
}
fn referenced(o: &Value, path: &str) -> bool {
    if !relative(path) {
        return false;
    }
    let pointers = ["/current/model", "/credit/thumbnail", "/ask/photo"];
    if pointers
        .iter()
        .any(|p| o.pointer(p).and_then(Value::as_str) == Some(path))
    {
        return true;
    }
    for pointer in ["/current/renders", "/photos", "/requestPhotos"] {
        if let Some(list) = o.pointer(pointer).and_then(Value::as_array) {
            if list.iter().any(|v| {
                v.as_str()
                    .is_some_and(|s| s == path || format!("photos/{s}") == path)
            }) {
                return true;
            }
        }
    }
    if o.pointer("/ask/options")
        .and_then(Value::as_array)
        .is_some_and(|options| {
            options
                .iter()
                .any(|option| option["thumbnail"].as_str() == Some(path))
        })
    {
        return true;
    }
    for list in ["plates", "passes", "messages"] {
        if let Some(items) = o[list].as_array() {
            for item in items {
                if item["thumbnail"].as_str() == Some(path) {
                    return true;
                }
                if let Some(photos) = item["photos"].as_array() {
                    if photos
                        .iter()
                        .any(|v| v.as_str().is_some_and(|s| format!("photos/{s}") == path))
                    {
                        return true;
                    }
                }
            }
        }
    }
    false
}
fn read_scoped(root: &Path, path: &str) -> Result<Vec<u8>> {
    use std::os::unix::fs::OpenOptionsExt;
    if !relative(path) {
        return Err("Invalid artifact path.".into());
    }
    let root = root
        .canonicalize()
        .map_err(|_| "Project files are unavailable.")?;
    let target = root
        .join(path)
        .canonicalize()
        .map_err(|_| "This artifact is not available yet.")?;
    if !target.starts_with(&root) {
        return Err("This artifact is outside the project.".into());
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&target)
        .map_err(|_| "Cannot open this artifact.")?;
    // Check the opened descriptor, too: reject symlink/ancestor swaps between canonicalize and open.
    let opened = std::fs::read_link(format!(
        "/proc/self/fd/{}",
        std::os::fd::AsRawFd::as_raw_fd(&file)
    ))
    .map_err(|_| "Cannot verify artifact location.")?;
    if !opened.starts_with(&root) {
        return Err("Artifact location changed. Refresh the project.".into());
    }
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect this artifact.")?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
        return Err(
            "This preview is not a regular file under 64 MB. Open it in your modeling app.".into(),
        );
    }
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(file, 64 * 1024 * 1024 + 1),
        &mut bytes,
    )
    .map_err(|_| "Cannot read this artifact.")?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("This artifact grew beyond the preview limit.".into());
    }
    Ok(bytes)
}
async fn project_file(app: &tauri::AppHandle, id: &str, path: &str) -> Result<(PathBuf, Vec<u8>)> {
    let value = request(app, "objects.get", json!({"id":id})).await?;
    let o = &value["object"];
    if !referenced(o, path) {
        return Err("This file is not a preview belonging to this project.".into());
    }
    let ext = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["stl", "png", "jpg", "jpeg", "webp"].contains(&ext.as_str()) {
        return Err("Use a still preview or open this model in a modeling app. Interactive preview supports STL.".into());
    }
    let root = PathBuf::from(
        o["directory"]
            .as_str()
            .ok_or("Missing project directory.")?,
    );
    let p = root.clone();
    let s = path.to_owned();
    let bytes = tauri::async_runtime::spawn_blocking(move || read_scoped(&p, &s))
        .await
        .map_err(|_| "Preview reader stopped.")??;
    Ok((root, bytes))
}
#[tauri::command]
async fn read_artifact(
    app: tauri::AppHandle,
    state: State<'_, Bridge>,
    id: String,
    path: String,
) -> Result<tauri::ipc::Response> {
    let _permit = state
        .artifacts
        .acquire()
        .await
        .map_err(|_| "Preview reader stopped.")?;
    Ok(tauri::ipc::Response::new(
        project_file(&app, &id, &path).await?.1,
    ))
}
/// The only reconstruction preview path this window can read: derived here from
/// the review id the companion currently publishes for this object. The caller
/// supplies ids only, never a path.
fn reconstruction_preview_path(object: &Value, review_id: &str) -> Result<String> {
    let parsed = uuid::Uuid::parse_str(review_id)
        .map_err(|_| "That review is no longer current. Refresh the project.")?;
    let canonical = parsed.to_string();
    let review = object.get("reconstructionReview");
    let current = review.and_then(|r| r.get("id")).and_then(Value::as_str);
    if current != Some(canonical.as_str()) {
        return Err("That review has been answered or replaced. Refresh the project.".into());
    }
    let expected = format!("reconstruction-preview.stl?reviewId={canonical}");
    if review.and_then(|r| r.get("preview")).and_then(Value::as_str) != Some(expected.as_str()) {
        return Err("This review preview does not match the current review. Refresh the project.".into());
    }
    Ok(format!("reconstruction/preview-{canonical}.stl"))
}
#[tauri::command]
async fn read_reconstruction_preview(
    app: tauri::AppHandle,
    state: State<'_, Bridge>,
    id: String,
    review_id: String,
) -> Result<tauri::ipc::Response> {
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err("Invalid project.".into());
    }
    let _permit = state
        .artifacts
        .acquire()
        .await
        .map_err(|_| "Preview reader stopped.")?;
    // Fresh companion state decides what may be read; a stale review id serves nothing.
    let value = request(&app, "objects.get", json!({"id":id})).await?;
    let object = &value["object"];
    let path = reconstruction_preview_path(object, &review_id)?;
    let root = PathBuf::from(
        object["directory"]
            .as_str()
            .ok_or("Missing project directory.")?,
    );
    let bytes = tauri::async_runtime::spawn_blocking(move || read_scoped(&root, &path))
        .await
        .map_err(|_| "Preview reader stopped.")??;
    Ok(tauri::ipc::Response::new(bytes))
}
#[tauri::command]
async fn preview_file() -> Result<tauri::ipc::Response> {
    let file = rfd::AsyncFileDialog::new()
        .set_title("Preview an STL model")
        .add_filter("STL model", &["stl"])
        .pick_file()
        .await;
    let Some(file) = file else {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    };
    let path = file.path().to_owned();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        read_scoped(
            path.parent().ok_or("Invalid file.")?,
            path.file_name()
                .and_then(|n| n.to_str())
                .ok_or("Invalid filename.")?,
        )
    })
    .await
    .map_err(|_| "Preview reader stopped.")??;
    Ok(tauri::ipc::Response::new(bytes))
}
#[tauri::command]
async fn pick_inputs(state: State<'_, Bridge>, kind: String) -> Result<Value> {
    let extensions = match kind.as_str() {
        "model" => vec!["3mf", "stl"],
        "photos" => vec!["jpg", "jpeg", "png", "heic", "webp"],
        "scan" => vec!["stl", "obj", "usdz"],
        _ => return Err("Unsupported input kind.".into()),
    };
    let files = rfd::AsyncFileDialog::new()
        .set_title("Add files to your new project")
        .add_filter("Project files", &extensions)
        .pick_files()
        .await
        .unwrap_or_default();
    if files.len() > 24 {
        return Err("Choose at most 24 files at a time.".into());
    }
    let mut grants = state.inputs.lock().map_err(|_| "File picker stopped.")?;
    grants.retain(|_, (_, _, at)| at.elapsed().as_secs() < 3600);
    if grants.len() + files.len() > 100 {
        return Err("Too many pending files. Finish or close this project first.".into());
    }
    let mut result = Vec::new();
    for file in files {
        let token = uuid::Uuid::new_v4().to_string();
        result.push(json!({"token":token,"name":file.file_name(),"kind":kind}));
        grants.insert(
            token,
            (file.path().to_owned(), kind.clone(), Instant::now()),
        );
    }
    Ok(json!(result))
}
#[tauri::command]
async fn release_inputs(state: State<'_, Bridge>, tokens: Vec<String>) -> Result<()> {
    let mut grants = state.inputs.lock().map_err(|_| "File picker stopped.")?;
    for token in tokens.into_iter().take(100) {
        grants.remove(&token);
    }
    Ok(())
}
#[tauri::command]
async fn import_selected(
    app: tauri::AppHandle,
    state: State<'_, Bridge>,
    id: String,
    tokens: Vec<String>,
) -> Result<Value> {
    if uuid::Uuid::parse_str(&id).is_err() || tokens.len() > 100 {
        return Err("Invalid project import.".into());
    }
    let selected = {
        let mut grants = state.inputs.lock().map_err(|_| "File picker stopped.")?;
        if tokens.iter().any(|t| {
            !grants
                .get(t)
                .is_some_and(|(_, _, at)| at.elapsed().as_secs() < 3600)
        }) {
            return Err("The selected files expired. Choose them again.".into());
        }
        tokens
            .into_iter()
            .filter_map(|t| grants.remove(&t))
            .collect::<Vec<_>>()
    };
    let mut imported = 0;
    let mut object = Value::Null;
    let mut errors = Vec::new();
    for (path, kind, _) in selected {
        match request(
            &app,
            "objects.addFile",
            json!({"id":id,"kind":kind,"path":path.to_string_lossy()}),
        )
        .await
        {
            Ok(r) => {
                imported += 1;
                object = r["object"].clone()
            }
            Err(e) => {
                errors.push(format!("Import stopped after {imported} files. {e} Check the project before selecting the remaining files again."));
                break;
            }
        }
    }
    Ok(json!({"object":object,"imported":imported,"errors":errors}))
}
#[tauri::command]
async fn import_files(
    app: tauri::AppHandle,
    id: String,
    kind: String,
    for_message: bool,
) -> Result<Value> {
    let extensions = match kind.as_str() {
        "model" => vec!["3mf", "stl"],
        "photos" => vec!["jpg", "jpeg", "png", "heic", "webp"],
        "scan" => vec!["stl", "obj", "usdz"],
        _ => return Err("Unsupported input kind.".into()),
    };
    let files = rfd::AsyncFileDialog::new()
        .set_title("Add files to this project")
        .add_filter("Project files", &extensions)
        .pick_files()
        .await;
    let mut names = Vec::<Value>::new();
    let mut imported = 0;
    let mut errors = Vec::new();
    let mut object = Value::Null;
    let files = files.unwrap_or_default();
    if files.len() > 24 {
        return Err("Choose at most 24 files at a time. No files were imported.".into());
    }
    for file in files {
        let path = file.path().to_string_lossy().to_string();
        let result = request(
            &app,
            "objects.addFile",
            json!({"id":id,"kind":kind,"path":path,"forMessage":for_message}),
        )
        .await;
        match result {
            Ok(reply) => {
                imported += 1;
                object = reply["object"].clone();
                if let Some(name) = reply.get("photoName").or_else(|| reply.get("name")) {
                    names.push(name.clone())
                }
            }
            Err(e) => {
                errors.push(format!("{}: {e}", file.file_name()));
                break;
            }
        }
    }
    Ok(json!({"object":object,"photoNames":names,"imported":imported,"errors":errors}))
}
fn valid_queue(queue: &Value) -> bool {
    let Some(items) = queue.as_array() else {
        return false;
    };
    items.len() <= 100
        && items.iter().all(|q| {
            q["id"]
                .as_str()
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
                && q["projectId"]
                    .as_str()
                    .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
                && q["note"]
                    .as_str()
                    .is_some_and(|n| !n.trim().is_empty() && n.len() <= 16000)
                && matches!(
                    q["state"].as_str(),
                    Some("queued" | "sending" | "uncertain")
                )
                && q["photos"].as_array().is_some_and(|p| {
                    p.len() <= 100
                        && p.iter().all(|n| {
                            n.as_str().is_some_and(|n| {
                                n.len() <= 128 && !n.contains('/') && !n.contains('\\')
                            })
                        })
                })
        })
}
#[tauri::command]
async fn load_change_queue(app: tauri::AppHandle) -> Result<Value> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot locate saved changes.")?
        .join("changes.json");
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            if bytes.len() > 2 * 1024 * 1024 {
                return Err("Saved changes exceed the limit.".into());
            }
            let queue: Value = serde_json::from_slice(&bytes)
                .map_err(|_| "Saved changes could not be read. They have not been removed.")?;
            if !valid_queue(&queue) {
                return Err("Saved changes are invalid. They have not been removed.".into());
            }
            Ok(queue)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!([])),
        Err(_) => Err("Could not read saved changes.".into()),
    }
}
#[tauri::command]
async fn save_change_queue(app: tauri::AppHandle, queue: Value) -> Result<()> {
    if !valid_queue(&queue) {
        return Err("The saved change queue is invalid or full (100 requests).".into());
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot locate saved changes.")?;
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| "Cannot save changes.")?;
    let bytes = serde_json::to_vec(&queue).map_err(|_| "Invalid saved changes.")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Saved changes exceed the size limit.".into());
    }
    let temporary = directory.join(format!("changes-{}.tmp", uuid::Uuid::new_v4()));
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| "Cannot save changes.")?;
    std::io::Write::write_all(&mut file, &bytes).map_err(|_| "Cannot save changes.")?;
    file.sync_all().map_err(|_| "Cannot save changes.")?;
    tokio::fs::rename(&temporary, directory.join("changes.json"))
        .await
        .map_err(|_| "Cannot save changes.")?;
    Ok(())
}
/// Adds a found MCP folder as it is. `model` is the person's choice when its MCP needs one Counterpart couldn't tell
/// (the companion checks it against that MCP's own list); otherwise the model discovery found.
#[tauri::command]
async fn add_discovered_printer(app: tauri::AppHandle, id: String, model: Option<String>) -> Result<Value> {
    let discovery = request(&app, "printers.discover", json!({})).await?;
    let candidate = discovery["found"]
        .as_array()
        .and_then(|list| list.iter().find(|p| p["id"].as_str() == Some(&id)))
        .ok_or("That printer is no longer discoverable. Find printers again.")?;
    let folder = candidate["folder"]
        .as_str()
        .ok_or("Enter this printer’s connection settings.")?;
    let mut printer = json!({"folder":folder});
    if let Some(model) = model.as_deref().or(candidate["model"].as_str()) {
        printer["model"] = json!(model)
    }
    request(&app, "printers.add", json!({"printer":printer})).await
}
#[tauri::command]
async fn open_link(url: String) -> Result<()> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid link.")?;
    if !["https", "http"].contains(&parsed.scheme())
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || url.len() > 4096
    {
        return Err("Only web links can be opened.".into());
    }
    launch("xdg-open", &[parsed.as_str()]).await
}
async fn launch(command: &str, args: &[&str]) -> Result<()> {
    let mut child = tokio::process::Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| format!("Install {command} to open this file."))?;
    tauri::async_runtime::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}
#[tauri::command]
async fn open_project(app: tauri::AppHandle, id: String, application: String) -> Result<()> {
    let value = request(&app, "objects.get", json!({"id":id})).await?;
    let o = &value["object"];
    let root = PathBuf::from(
        o["directory"]
            .as_str()
            .ok_or("Missing project directory.")?,
    )
    .canonicalize()
    .map_err(|_| "Project files unavailable.")?;
    if application == "folder" {
        return launch("xdg-open", &[root.to_str().ok_or("Invalid project path.")?]).await;
    }
    let command = match application.as_str() {
        "blender" => "blender",
        "bambu-studio" => "bambu-studio",
        "orca" => "orca-slicer",
        _ => return Err("Unsupported editor.".into()),
    };
    let path = o
        .pointer("/current/model")
        .and_then(Value::as_str)
        .ok_or("There is no model yet.")?;
    if !relative(path) {
        return Err("Invalid model path.".into());
    }
    let name = Path::new(path)
        .file_name()
        .ok_or("Invalid model name.")?
        .to_owned();
    let selected = path.to_owned();
    let bytes = tauri::async_runtime::spawn_blocking(move || read_scoped(&root, &selected))
        .await
        .map_err(|_| "Model reader stopped.")??;
    // Editors receive a separate copy, never the retained original.
    let copies = app
        .path()
        .app_cache_dir()
        .map_err(|_| "Cannot create editable copy.")?
        .join("editor-copies")
        .join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&copies)
        .await
        .map_err(|_| "Cannot create editable copy.")?;
    let destination = copies.join(name);
    tokio::fs::write(&destination, bytes)
        .await
        .map_err(|_| "Cannot copy model for editor.")?;
    launch(
        command,
        &[destination.to_str().ok_or("Invalid model path.")?],
    )
    .await
}
fn main() {
    tauri::Builder::default()
        .manage(Bridge {
            regular: Arc::new(Semaphore::new(8)),
            answers: Arc::new(Semaphore::new(3)),
            artifacts: Arc::new(Semaphore::new(2)),
            inputs: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            host_action,
            control,
            load_change_queue,
            save_change_queue,
            add_discovered_printer,
            store_credential,
            read_artifact,
            read_reconstruction_preview,
            preview_file,
            import_files,
            pick_inputs,
            import_selected,
            release_inputs,
            open_link,
            open_project
        ])
        .run(tauri::generate_context!())
        .expect("Counterpart could not start");
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scope_rejects_traversal_and_unreferenced_files() {
        let o = json!({"current":{"model":"current/model.stl","renders":["current/front.png"]},"photos":["one.jpg"]});
        assert!(referenced(&o, "photos/one.jpg"));
        assert!(referenced(&o, "current/model.stl"));
        for p in [
            "../x",
            "/etc/passwd",
            "current/../../secret",
            "object.json",
            "photos/other.jpg",
        ] {
            assert!(!referenced(&o, p));
        }
    }
    #[test]
    fn reconstruction_preview_is_derived_from_current_review_only() {
        let id = "123e4567-e89b-42d3-a456-426614174000";
        let o = json!({"reconstructionReview":{"id":id,"preview":format!("reconstruction-preview.stl?reviewId={id}")}});
        assert_eq!(
            reconstruction_preview_path(&o, id).unwrap(),
            format!("reconstruction/preview-{id}.stl")
        );
        // Stale, missing, malformed, or mismatched reviews serve nothing.
        assert!(reconstruction_preview_path(&o, "123e4567-e89b-42d3-a456-426614174999").is_err());
        assert!(reconstruction_preview_path(&o, "../secret").is_err());
        assert!(reconstruction_preview_path(&json!({}), id).is_err());
        let wrong_preview = json!({"reconstructionReview":{"id":id,"preview":"reconstruction-preview.stl?reviewId=123e4567-e89b-42d3-a456-426614174999"}});
        assert!(reconstruction_preview_path(&wrong_preview, id).is_err());
        // The private preview is not a generally referenced artifact either.
        assert!(!referenced(&o, &format!("reconstruction/preview-{id}.stl")));
    }
}
#[cfg(test)]
mod filesystem_tests {
    use super::*;
    #[test]
    fn rejects_symlinks_escaping_project() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&dir).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", dir.join("render.png")).unwrap();
        assert!(read_scoped(&dir, "render.png").is_err());
        std::fs::write(dir.join("real.stl"), b"solid test").unwrap();
        assert_eq!(read_scoped(&dir, "real.stl").unwrap(), b"solid test");
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_unsafe_persisted_correction_queue() {
        assert!(!valid_queue(&json!([{"id":"not-a-uuid"}])));
        assert!(valid_queue(&json!([])));
    }
}
