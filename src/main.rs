mod db;
mod hub;
mod protocol;
mod tls;

use axum::{
    Extension, Router,
    extract::WebSocketUpgrade,
    extract::ws::{Message, WebSocket},
    http::{self, StatusCode},
    response::{IntoResponse, Redirect},
    routing::{get, post},
    Json,
};
use futures::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;
use tower_http::services::ServeDir;

use crate::db::Db;
use crate::hub::Hub;
use crate::protocol::*;

struct AppState {
    hub: Hub,
    db: Arc<Db>,
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
    let hub = Hub::new(db.clone());
    let state = Arc::new(AppState { hub, db: db.clone() });

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
        .route("/ws", get(ws_upgrade))
        .fallback_service(ServeDir::new(&static_dir).append_index_html_on_directories(true))
        .layer(Extension(state));

    let port: u16 = std::env::var("GATHERING_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(9123);

    let http_port: u16 = std::env::var("GATHERING_HTTP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(port + 1);

    // HTTP redirect router: sends all requests to HTTPS on the main port
    let redirect_port = port;
    let redirect_app = Router::new().fallback(
        move |headers: http::HeaderMap, uri: http::Uri| async move {
            let host = headers
                .get(http::header::HOST)
                .and_then(|h| h.to_str().ok())
                .unwrap_or("localhost");
            let host_name = host.split(':').next().unwrap_or(host);
            let path = uri
                .path_and_query()
                .map(|pq| pq.as_str())
                .unwrap_or("/");
            Redirect::temporary(&format!("https://{}:{}{}", host_name, redirect_port, path))
        },
    );

    let tls_addr = SocketAddr::from(([0, 0, 0, 0], port));
    let http_addr = SocketAddr::from(([0, 0, 0, 0], http_port));

    tracing::info!("Gathering HTTPS (app)      on https://{}", tls_addr);
    tracing::info!("Gathering HTTP  (redirect) on http://{}", http_addr);

    // Spawn HTTP redirect server on secondary port
    tokio::spawn(async move {
        axum::Server::bind(&http_addr)
            .serve(redirect_app.into_make_service())
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

    match state.db.register(&req.username, &req.password) {
        Ok(()) => {
            tracing::info!("Registered user: {}", req.username);
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
