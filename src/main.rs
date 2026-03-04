mod db;
mod hub;
mod protocol;
mod tls;

use axum::{
    Extension, Router,
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, WebSocketUpgrade},
    extract::ws::{Message, WebSocket},
    http::{self, StatusCode, header},
    response::{IntoResponse, Redirect},
    routing::{get, post},
    Json,
};
use futures::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

use crate::db::Db;
use crate::hub::Hub;
use crate::protocol::*;

struct AppState {
    hub: Hub,
    db: Arc<Db>,
    data_dir: PathBuf,
    config: ServerConfig,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "gathering=info".into()),
        )
        .init();

    let data_dir = std::env::var("GATHERING_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("gathering-data"));
    std::fs::create_dir_all(&data_dir).expect("Failed to create data directory");
    std::fs::create_dir_all(data_dir.join("uploads")).ok();

    let db_path = data_dir.join("gathering.db");
    tracing::info!("Database: {:?}", db_path);

    let db = Arc::new(Db::open(&db_path).expect("Failed to open database"));

    // Load config
    let config_path = data_dir.join("config.json");
    let config: ServerConfig = if config_path.exists() {
        match std::fs::read_to_string(&config_path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|e| {
                tracing::warn!("Failed to parse config.json: {}, using defaults", e);
                ServerConfig::default()
            }),
            Err(e) => {
                tracing::warn!("Failed to read config.json: {}, using defaults", e);
                ServerConfig::default()
            }
        }
    } else {
        tracing::info!("No config.json found, using defaults");
        ServerConfig::default()
    };

    // Seed default roles from config
    for (role_name, permissions) in &config.default_roles {
        db.upsert_role(role_name, permissions);
    }
    tracing::info!("Seeded {} default roles", config.default_roles.len());

    // Backfill existing users who have no roles
    db.backfill_user_roles();

    // Auto-assign admin role to config-listed admins
    for admin_name in &config.admins {
        let _ = db.assign_role(admin_name, "admin");
    }

    let hub = Hub::new(db.clone(), data_dir.clone());
    let state = Arc::new(AppState { hub, db: db.clone(), data_dir: data_dir.clone(), config });

    tls::ensure_tls(&data_dir);

    // Spawn message expiry task
    let expiry_db = db.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
            let n = expiry_db.purge_expired();
            if n > 0 {
                tracing::info!("Purged {} expired messages", n);
            }
            // Voice channel TTL: expire messages in voice channels that have been empty long enough
            let pending = expiry_db.get_voice_channels_pending_expiry();
            for (channel, _ttl_secs) in pending {
                let expired = expiry_db.expire_voice_channel_messages(&channel);
                if expired > 0 {
                    tracing::info!("Voice TTL: expired {} messages in #{}", expired, channel);
                }
            }
        }
    });

    let static_dir = if PathBuf::from("static").exists() {
        "static".to_string()
    } else if PathBuf::from("../static").exists() {
        "../static".to_string()
    } else {
        "static".to_string()
    };

    let app = Router::new()
        .route("/api/register", post(handle_register))
        .route("/api/login", post(handle_login))
        .route("/api/server-info", get(handle_server_info))
        .route("/api/upload", post(handle_upload).layer(DefaultBodyLimit::max(50 * 1024 * 1024)))
        .route("/api/files/:id", get(handle_download))
        .route("/ws", get(ws_upgrade))
        .fallback_service(ServeDir::new(&static_dir).append_index_html_on_directories(true))
        .layer(CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any))
        .layer(Extension(state));

    let port: u16 = std::env::var("GATHERING_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(9123);

    let http_port: u16 = std::env::var("GATHERING_HTTP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(port + 1);

    let tls_addr = SocketAddr::from(([0, 0, 0, 0], port));
    let http_addr = SocketAddr::from(([0, 0, 0, 0], http_port));

    tracing::info!("Gathering HTTPS on https://{}", tls_addr);
    tracing::info!("Gathering HTTP  on http://{}", http_addr);

    // Spawn HTTP server on secondary port (full app, for native clients)
    let http_app = app.clone();
    tokio::spawn(async move {
        axum::Server::bind(&http_addr)
            .serve(http_app.into_make_service())
            .await
            .unwrap();
    });

    // Run HTTPS server on main port
    let tls_config = tls::load_rustls_config(&data_dir).await;
    axum_server::bind_rustls(tls_addr, tls_config)
        .serve(app.into_make_service())
        .await
        .unwrap();
}

// ── HTTP Handlers ───────────────────────────────────────────────────

async fn handle_server_info(
    Extension(state): Extension<Arc<AppState>>,
) -> impl IntoResponse {
    let mode = state.db.get_setting("registration_mode").unwrap_or_else(|| "open".to_string());
    Json(ServerInfoResponse {
        registration_mode: mode,
    })
}

async fn handle_register(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> impl IntoResponse {
    if req.username.len() < 2 || req.username.len() > 32 {
        return (StatusCode::BAD_REQUEST, Json(AuthResponse {
            ok: false, token: None,
            error: Some("Username must be 2-32 characters".into()),
        }));
    }
    if req.password.len() < 6 {
        return (StatusCode::BAD_REQUEST, Json(AuthResponse {
            ok: false, token: None,
            error: Some("Password must be at least 6 characters".into()),
        }));
    }
    if !req.username.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return (StatusCode::BAD_REQUEST, Json(AuthResponse {
            ok: false, token: None,
            error: Some("Username: only letters, numbers, underscores".into()),
        }));
    }

    // Check registration mode
    let reg_mode = state.db.get_setting("registration_mode").unwrap_or_else(|| "open".to_string());
    match reg_mode.as_str() {
        "closed" => {
            return (StatusCode::FORBIDDEN, Json(AuthResponse {
                ok: false, token: None,
                error: Some("Registration is closed".into()),
            }));
        }
        "invite" => {
            match &req.invite_code {
                Some(code) if !code.is_empty() => {
                    if let Err(e) = state.db.validate_invite(code) {
                        return (StatusCode::FORBIDDEN, Json(AuthResponse {
                            ok: false, token: None,
                            error: Some(e),
                        }));
                    }
                }
                _ => {
                    return (StatusCode::FORBIDDEN, Json(AuthResponse {
                        ok: false, token: None,
                        error: Some("Invite code required".into()),
                    }));
                }
            }
        }
        _ => {} // "open" - allow
    }

    match state.db.register(&req.username, &req.password) {
        Ok(()) => {
            tracing::info!("Registered user: {}", req.username);

            // Assign default "user" role
            let _ = state.db.assign_role(&req.username, "user");

            // Check if this user is in the config admins list
            if state.config.admins.contains(&req.username) {
                let _ = state.db.assign_role(&req.username, "admin");
                tracing::info!("Auto-assigned admin role to: {}", req.username);
            }

            // Mark invite code as used
            if reg_mode == "invite" {
                if let Some(code) = &req.invite_code {
                    let _ = state.db.use_invite(code, &req.username);
                }
            }

            match state.db.login(&req.username, &req.password) {
                Ok(token) => (StatusCode::OK, Json(AuthResponse {
                    ok: true, token: Some(token), error: None,
                })),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(AuthResponse {
                    ok: false, token: None, error: Some(e),
                })),
            }
        }
        Err(e) => (StatusCode::CONFLICT, Json(AuthResponse {
            ok: false, token: None, error: Some(e),
        })),
    }
}

async fn handle_login(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> impl IntoResponse {
    match state.db.login(&req.username, &req.password) {
        Ok(token) => {
            tracing::info!("Login: {}", req.username);
            (StatusCode::OK, Json(AuthResponse {
                ok: true, token: Some(token), error: None,
            }))
        }
        Err(e) => (StatusCode::UNAUTHORIZED, Json(AuthResponse {
            ok: false, token: None, error: Some(e),
        })),
    }
}

// ── File upload ─────────────────────────────────────────────────────

const MAX_UPLOAD_SIZE: usize = 50 * 1024 * 1024; // 50MB

async fn handle_upload(
    Extension(state): Extension<Arc<AppState>>,
    headers: http::HeaderMap,
    mut multipart: Multipart,
) -> impl IntoResponse {
    // Auth via Bearer token
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");

    let username = match state.db.validate_token(token) {
        Some(u) => u,
        None => {
            return (StatusCode::UNAUTHORIZED, Json(UploadResponse {
                ok: false, file: None, error: Some("Invalid token".into()),
            }));
        }
    };

    let mut file_data: Option<(String, Vec<u8>)> = None;
    let mut channel = String::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                let filename = field.file_name().unwrap_or("upload").to_string();
                match field.bytes().await {
                    Ok(bytes) => {
                        if bytes.len() > MAX_UPLOAD_SIZE {
                            return (StatusCode::BAD_REQUEST, Json(UploadResponse {
                                ok: false, file: None,
                                error: Some("File too large (max 50MB)".into()),
                            }));
                        }
                        file_data = Some((filename, bytes.to_vec()));
                    }
                    Err(_) => {
                        return (StatusCode::BAD_REQUEST, Json(UploadResponse {
                            ok: false, file: None, error: Some("Failed to read file".into()),
                        }));
                    }
                }
            }
            "channel" => {
                if let Ok(bytes) = field.bytes().await {
                    channel = String::from_utf8_lossy(&bytes).to_string();
                }
            }
            _ => {}
        }
    }

    let (filename, data) = match file_data {
        Some(d) => d,
        None => {
            return (StatusCode::BAD_REQUEST, Json(UploadResponse {
                ok: false, file: None, error: Some("No file provided".into()),
            }));
        }
    };

    if channel.is_empty() {
        channel = "general".to_string();
    }

    // Check disk quota
    let new_size = data.len() as i64;
    let quota_bytes = state.db.get_user_quota(&username);
    if quota_bytes > 0 {
        let mut used_bytes = state.db.get_user_disk_usage(&username);
        if used_bytes + new_size > quota_bytes {
            // Auto-delete oldest released (unpinned) files to make room
            let released = state.db.get_released_files_for_user(&username);
            for (fid, fname, fsize) in released {
                if used_bytes + new_size <= quota_bytes { break; }
                let ext = std::path::Path::new(&fname)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("bin");
                let disk_name = format!("{}.{}", fid, ext);
                let fpath = state.data_dir.join("uploads").join(&disk_name);
                let _ = tokio::fs::remove_file(&fpath).await;
                state.db.delete_file_record(&fid);
                used_bytes -= fsize;
            }
            // If still over quota, reject
            if used_bytes + new_size > quota_bytes {
                let used_mb = used_bytes as f64 / (1024.0 * 1024.0);
                let quota_mb = quota_bytes as f64 / (1024.0 * 1024.0);
                return (StatusCode::BAD_REQUEST, Json(UploadResponse {
                    ok: false, file: None,
                    error: Some(format!("Disk quota exceeded: {:.1}/{:.0} MB used. Pin fewer files or delete some.", used_mb, quota_mb)),
                }));
            }
        }
    }

    let file_id = uuid::Uuid::new_v4().to_string();
    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let mime_type = mime_from_ext(ext);
    let disk_name = format!("{}.{}", file_id, ext);
    let file_path = state.data_dir.join("uploads").join(&disk_name);

    if let Err(_) = tokio::fs::write(&file_path, &data).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(UploadResponse {
            ok: false, file: None, error: Some("Failed to save file".into()),
        }));
    }

    let size = data.len() as i64;
    state.db.store_file(&file_id, &filename, size, &mime_type, &username, &channel);

    let info = FileInfo {
        id: file_id,
        filename,
        size,
        mime_type,
        url: format!("/api/files/{}", disk_name.split('.').next().unwrap_or("")),
    };

    tracing::info!("File uploaded: {} by {}", info.filename, username);

    (StatusCode::OK, Json(UploadResponse {
        ok: true, file: Some(info), error: None,
    }))
}

async fn handle_download(
    Extension(state): Extension<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    headers: http::HeaderMap,
) -> impl IntoResponse {
    let file_info = match state.db.get_file(&id) {
        Some(f) => f,
        None => return Err(StatusCode::NOT_FOUND),
    };

    // Find the file on disk
    let uploads_dir = state.data_dir.join("uploads");
    let ext = std::path::Path::new(&file_info.filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let disk_path = uploads_dir.join(format!("{}.{}", id, ext));

    let data = match tokio::fs::read(&disk_path).await {
        Ok(d) => d,
        Err(_) => return Err(StatusCode::NOT_FOUND),
    };

    let total = data.len();
    let content_disposition = format!("inline; filename=\"{}\"", file_info.filename);

    // Parse Range header for audio/video seek support
    if let Some(range_val) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        if let Some(range) = range_val.strip_prefix("bytes=") {
            let parts: Vec<&str> = range.splitn(2, '-').collect();
            if parts.len() == 2 {
                let start: usize = parts[0].parse().unwrap_or(0);
                let end: usize = if parts[1].is_empty() {
                    total - 1
                } else {
                    parts[1].parse().unwrap_or(total - 1).min(total - 1)
                };

                if start <= end && start < total {
                    let slice = data[start..=end].to_vec();
                    let content_range = format!("bytes {}-{}/{}", start, end, total);

                    return Ok((
                        StatusCode::PARTIAL_CONTENT,
                        [
                            (header::CONTENT_TYPE, file_info.mime_type),
                            (header::CONTENT_DISPOSITION, content_disposition),
                            (header::ACCEPT_RANGES, "bytes".to_string()),
                            (header::CONTENT_RANGE, content_range),
                            (header::CONTENT_LENGTH, slice.len().to_string()),
                        ],
                        slice,
                    ));
                }
            }
        }
    }

    // Full response
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, file_info.mime_type),
            (header::CONTENT_DISPOSITION, content_disposition),
            (header::ACCEPT_RANGES, "bytes".to_string()),
            (header::CONTENT_RANGE, String::new()),
            (header::CONTENT_LENGTH, total.to_string()),
        ],
        data,
    ))
}

fn mime_from_ext(ext: &str) -> String {
    match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "application/javascript",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "tar" => "application/x-tar",
        "gz" => "application/gzip",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "md" => "text/markdown",
        "rs" => "text/x-rust",
        "py" => "text/x-python",
        "ts" => "text/typescript",
        "toml" => "application/toml",
        "yaml" | "yml" => "application/yaml",
        _ => "application/octet-stream",
    }
    .to_string()
}

// ── WebSocket ───────────────────────────────────────────────────────

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    Extension(state): Extension<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(socket: WebSocket, state: Arc<AppState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let client_id = state.hub.connect(tx).await;
    tracing::debug!("WebSocket connected: id={}", client_id);

    // Forward hub messages to WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Receive from WebSocket, route to hub
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                match serde_json::from_str::<ClientMsg>(&text) {
                    Ok(client_msg) => {
                        state.hub.handle_message(client_id, client_msg).await;
                    }
                    Err(e) => {
                        tracing::warn!("Bad message from {}: {}", client_id, e);
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    state.hub.disconnect(client_id).await;
    send_task.abort();
    tracing::debug!("WebSocket disconnected: id={}", client_id);
}
