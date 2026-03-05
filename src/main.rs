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
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Instant;

use crate::db::Db;
use crate::hub::Hub;
use crate::protocol::*;

const RATE_LIMIT_MAX_REQUESTS: u32 = 10;
const RATE_LIMIT_WINDOW_SECS: u64 = 60;
const EXPIRY_PURGE_INTERVAL_SECS: u64 = 60;
const MIN_USERNAME_LEN: usize = 2;
const MAX_USERNAME_LEN: usize = 32;
const MIN_PASSWORD_LEN: usize = 6;

struct AppState {
    hub: Hub,
    db: Arc<Db>,
    data_dir: PathBuf,
    config: ServerConfig,
    rate_limiter: tokio::sync::Mutex<HashMap<IpAddr, (u32, Instant)>>,
}

impl AppState {
    /// Check rate limit for an IP. Returns true if request should be allowed.
    async fn check_rate_limit(&self, ip: IpAddr, max_requests: u32, window_secs: u64) -> bool {
        let mut limiter = self.rate_limiter.lock().await;
        let now = Instant::now();
        let entry = limiter.entry(ip).or_insert((0, now));

        if now.duration_since(entry.1).as_secs() >= window_secs {
            // Reset window
            *entry = (1, now);
            true
        } else if entry.0 >= max_requests {
            false
        } else {
            entry.0 += 1;
            true
        }
    }
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
    std::fs::create_dir_all(data_dir.join("music")).ok();

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
        if let Err(e) = db.assign_role(admin_name, "admin") {
            eprintln!("[main] auto-assign admin role to {admin_name} failed: {e}");
        }
    }

    let config_port = config.port;
    let config_http_port = config.http_port;

    let hub = Hub::new(db.clone(), data_dir.clone());
    let state = Arc::new(AppState {
        hub,
        db: db.clone(),
        data_dir: data_dir.clone(),
        config,
        rate_limiter: tokio::sync::Mutex::new(HashMap::new()),
    });

    tls::ensure_tls(&data_dir);

    // Spawn message expiry task
    let expiry_db = db.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(EXPIRY_PURGE_INTERVAL_SECS)).await;
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
        .route("/api/logout", post(handle_logout))
        .route("/api/server-info", get(handle_server_info))
        .route("/api/upload", post(handle_upload).layer(DefaultBodyLimit::max(MAX_UPLOAD_SIZE)))
        .route("/api/files/:id", get(handle_download))
        .route("/api/music", get(handle_music_list))
        .route("/api/music/*path", get(handle_music_download))
        .route("/ws", get(ws_upgrade))
        .fallback_service(ServeDir::new(&static_dir).append_index_html_on_directories(true))
        .layer(CorsLayer::new()) // S3: same-origin only (no permissive CORS)
        .layer(Extension(state));

    let port: u16 = std::env::var("GATHERING_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(config_port);

    let http_port: u16 = std::env::var("GATHERING_HTTP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or_else(|| config_http_port.unwrap_or(port + 1));

    let tls_addr = SocketAddr::from(([0, 0, 0, 0], port));
    let http_addr = SocketAddr::from(([0, 0, 0, 0], http_port));

    tracing::info!("Gathering HTTPS on https://{}", tls_addr);
    tracing::info!("Gathering HTTP  on http://{}", http_addr);

    // S6: HTTP server only redirects to HTTPS (no auth/upload/ws endpoints)
    let https_port = port;
    let http_redirect = Router::new()
        .fallback(move |req: http::Request<axum::body::Body>| async move {
            let host = req.headers()
                .get(http::header::HOST)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("localhost")
                .split(':')
                .next()
                .unwrap_or("localhost");
            let path = req.uri().path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
            let redirect_url = format!("https://{}:{}{}", host, https_port, path);
            Redirect::permanent(&redirect_url)
        });
    tokio::spawn(async move {
        axum::Server::bind(&http_addr)
            .serve(http_redirect.into_make_service())
            .await
            .unwrap();
    });

    // Run HTTPS server on main port
    let tls_config = tls::load_rustls_config(&data_dir).await;
    axum_server::bind_rustls(tls_addr, tls_config)
        .serve(app.into_make_service_with_connect_info::<SocketAddr>())
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
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<SocketAddr>,
    Json(req): Json<RegisterRequest>,
) -> impl IntoResponse {
    // S5: Rate limiting
    if !state.check_rate_limit(addr.ip(), RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECS).await {
        return (StatusCode::TOO_MANY_REQUESTS, Json(AuthResponse {
            ok: false, token: None,
            error: Some("Too many requests. Try again later.".into()),
        }));
    }
    if req.username.len() < MIN_USERNAME_LEN || req.username.len() > MAX_USERNAME_LEN {
        return (StatusCode::BAD_REQUEST, Json(AuthResponse {
            ok: false, token: None,
            error: Some("Username must be 2-32 characters".into()),
        }));
    }
    if req.password.len() < MIN_PASSWORD_LEN {
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
            if let Err(e) = state.db.assign_role(&req.username, "user") {
                eprintln!("[main] assign default user role failed: {e}");
            }

            // Check if this user is in the config admins list
            if state.config.admins.contains(&req.username) {
                if let Err(e) = state.db.assign_role(&req.username, "admin") {
                    eprintln!("[main] auto-assign admin role on register failed: {e}");
                }
                tracing::info!("Auto-assigned admin role to: {}", req.username);
            }

            // Mark invite code as used
            if reg_mode == "invite" {
                if let Some(code) = &req.invite_code {
                    if let Err(e) = state.db.use_invite(code, &req.username) {
                        eprintln!("[main] mark invite code as used failed: {e}");
                    }
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
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<SocketAddr>,
    Json(req): Json<LoginRequest>,
) -> impl IntoResponse {
    // S5: Rate limiting
    if !state.check_rate_limit(addr.ip(), RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECS).await {
        return (StatusCode::TOO_MANY_REQUESTS, Json(AuthResponse {
            ok: false, token: None,
            error: Some("Too many requests. Try again later.".into()),
        }));
    }

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

async fn handle_logout(
    Extension(state): Extension<Arc<AppState>>,
    headers: http::HeaderMap,
) -> impl IntoResponse {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");

    if !token.is_empty() {
        state.db.delete_session(token);
    }

    StatusCode::OK
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

    // S8: Check upload_file permission
    if !state.db.user_has_permission(&username, "upload_file") {
        return (StatusCode::FORBIDDEN, Json(UploadResponse {
            ok: false, file: None, error: Some("Permission denied: upload_file".into()),
        }));
    }

    let mut file_data: Option<(String, Vec<u8>)> = None;
    let mut channel = String::new();
    let mut encrypted = false;

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
            "encrypted" => {
                if let Ok(bytes) = field.bytes().await {
                    let val = String::from_utf8_lossy(&bytes);
                    encrypted = val == "true" || val == "1";
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

    // Check channel access for restricted channels
    if !state.db.can_access_channel(&channel, &username) {
        return (StatusCode::FORBIDDEN, Json(UploadResponse {
            ok: false, file: None, error: Some("Access denied: channel is restricted".into()),
        }));
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
                if let Err(e) = tokio::fs::remove_file(&fpath).await {
                    eprintln!("[main] remove file during quota cleanup failed: {e}");
                }
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
    state.db.store_file(&file_id, &filename, size, &mime_type, &username, &channel, encrypted);

    let info = FileInfo {
        id: file_id,
        filename,
        size,
        mime_type,
        url: format!("/api/files/{}", disk_name.split('.').next().unwrap_or("")),
        encrypted,
    };

    tracing::info!("File uploaded: {} by {}", info.filename, username);

    (StatusCode::OK, Json(UploadResponse {
        ok: true, file: Some(info), error: None,
    }))
}

async fn handle_download(
    Extension(state): Extension<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>,
    headers: http::HeaderMap,
) -> impl IntoResponse {
    // S2: Authenticate downloads (Bearer header or ?token= query param for media elements)
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
        .or_else(|| query.get("token").cloned());

    let username = match token.as_deref().and_then(|t| state.db.validate_token(t)) {
        Some(u) => u,
        None => return Err(StatusCode::UNAUTHORIZED),
    };

    let file_info = match state.db.get_file(&id) {
        Some(f) => f,
        None => return Err(StatusCode::NOT_FOUND),
    };

    // Check channel access for restricted channels
    if let Some(channel) = state.db.get_file_channel(&id) {
        if !state.db.can_access_channel(&channel, &username) {
            return Err(StatusCode::FORBIDDEN);
        }
    }

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
    // S9: Sanitize filename for Content-Disposition
    let safe_filename: String = file_info.filename
        .chars()
        .filter(|c| *c != '"' && *c != '\\' && *c != '\n' && *c != '\r' && !c.is_control())
        .collect();
    let content_disposition = format!("inline; filename=\"{}\"", safe_filename);

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

// ── Music library ───────────────────────────────────────────────────

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "ogg", "wav", "flac", "m4a", "aac", "opus", "wma", "webm"];

#[derive(Debug, serde::Serialize)]
struct MusicNode {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<MusicNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

fn scan_music_dir(base: &std::path::Path, dir: &std::path::Path) -> Vec<MusicNode> {
    let mut nodes = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return nodes,
    };
    let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden files/dirs
        if name.starts_with('.') { continue; }

        if ft.is_dir() {
            let children = scan_music_dir(base, &entry.path());
            if !children.is_empty() {
                nodes.push(MusicNode {
                    name,
                    children: Some(children),
                    path: None,
                    mime: None,
                    size: None,
                });
            }
        } else if ft.is_file() {
            let ext = std::path::Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if AUDIO_EXTENSIONS.contains(&ext.as_str()) {
                let rel_path = entry.path().strip_prefix(base)
                    .unwrap_or(&entry.path())
                    .to_string_lossy()
                    .to_string();
                let size = entry.metadata().ok().map(|m| m.len());
                nodes.push(MusicNode {
                    name,
                    children: None,
                    path: Some(rel_path),
                    mime: Some(mime_from_ext(&ext)),
                    size,
                });
            }
        }
    }
    nodes
}

async fn handle_music_list(
    Extension(state): Extension<Arc<AppState>>,
    headers: http::HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
    // Auth check
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string());

    match token.as_deref().and_then(|t| state.db.validate_token(t)) {
        Some(_) => {}
        None => return Err(StatusCode::UNAUTHORIZED),
    }

    let music_dir = state.data_dir.join("music");
    let tree = scan_music_dir(&music_dir, &music_dir);
    Ok(Json(tree))
}

async fn handle_music_download(
    Extension(state): Extension<Arc<AppState>>,
    headers: http::HeaderMap,
    axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>,
    AxumPath(path): AxumPath<String>,
) -> Result<impl IntoResponse, StatusCode> {
    // Auth check (Bearer or ?token=)
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
        .or_else(|| query.get("token").cloned());

    match token.as_deref().and_then(|t| state.db.validate_token(t)) {
        Some(_) => {}
        None => return Err(StatusCode::UNAUTHORIZED),
    }

    // Sanitize path — no ".." or absolute paths
    if path.contains("..") || path.starts_with('/') {
        return Err(StatusCode::BAD_REQUEST);
    }

    let file_path = state.data_dir.join("music").join(&path);
    if !file_path.exists() || !file_path.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }

    // Verify it's still under the music directory (prevent symlink escape)
    let canonical = file_path.canonicalize().map_err(|_| StatusCode::NOT_FOUND)?;
    let music_canonical = state.data_dir.join("music").canonicalize().map_err(|_| StatusCode::NOT_FOUND)?;
    if !canonical.starts_with(&music_canonical) {
        return Err(StatusCode::FORBIDDEN);
    }

    let data = tokio::fs::read(&file_path).await.map_err(|_| StatusCode::NOT_FOUND)?;
    let total = data.len();
    let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let mime = mime_from_ext(ext);
    let filename = file_path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let safe_filename: String = filename.chars()
        .filter(|c| *c != '"' && *c != '\\' && !c.is_control())
        .collect();

    // Range request support for seeking
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
                    return Ok((
                        StatusCode::PARTIAL_CONTENT,
                        [
                            (header::CONTENT_TYPE, mime),
                            (header::CONTENT_DISPOSITION, format!("inline; filename=\"{}\"", safe_filename)),
                            (header::ACCEPT_RANGES, "bytes".to_string()),
                            (header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, end, total)),
                            (header::CONTENT_LENGTH, slice.len().to_string()),
                        ],
                        slice,
                    ));
                }
            }
        }
    }

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            (header::CONTENT_DISPOSITION, format!("inline; filename=\"{}\"", safe_filename)),
            (header::ACCEPT_RANGES, "bytes".to_string()),
            (header::CONTENT_RANGE, String::new()),
            (header::CONTENT_LENGTH, total.to_string()),
        ],
        data,
    ))
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
