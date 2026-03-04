use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── Client → Server messages ────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMsg {
    /// Authenticate with token (obtained via HTTP login)
    Auth { token: String },
    /// Send a chat message to a channel
    Send {
        channel: String,
        content: String,
        /// Message time-to-live in seconds (None = permanent)
        ttl_secs: Option<u64>,
    },
    /// Join a channel (creates it if it doesn't exist)
    Join { channel: String },
    /// Leave a channel
    Leave { channel: String },
    /// Request message history for a channel
    History { channel: String, limit: Option<u32> },
    /// Typing indicator
    Typing { channel: String },
    /// Join a voice channel
    VoiceJoin { channel: String },
    /// Leave voice channel
    VoiceLeave { channel: String },
    /// Relay WebRTC signaling data to a specific user
    VoiceSignal { target_user: String, signal_data: serde_json::Value },
}

// ── Server → Client messages ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMsg {
    /// Authentication result
    AuthResult { ok: bool, username: Option<String>, error: Option<String> },
    /// A chat message (new or historical)
    Message {
        id: String,
        channel: String,
        author: String,
        content: String,
        timestamp: DateTime<Utc>,
        expires_at: Option<DateTime<Utc>>,
    },
    /// Channel history batch
    History { channel: String, messages: Vec<HistoryMessage> },
    /// Someone joined a channel
    UserJoined { channel: String, username: String },
    /// Someone left a channel
    UserLeft { channel: String, username: String },
    /// Typing indicator
    UserTyping { channel: String, username: String },
    /// Channel list update
    ChannelList { channels: Vec<ChannelInfo> },
    /// Online users update
    OnlineUsers { users: Vec<String> },
    /// Error from the server
    Error { message: String },
    /// System announcement
    System { content: String },
    /// A user joined a voice channel
    VoiceUserJoined { channel: String, username: String },
    /// A user left a voice channel
    VoiceUserLeft { channel: String, username: String },
    /// Relayed WebRTC signaling data
    VoiceSignal { from_user: String, signal_data: serde_json::Value },
    /// Current voice channel members
    VoiceMembers { channel: String, users: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryMessage {
    pub id: String,
    pub author: String,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelInfo {
    pub name: String,
    pub user_count: usize,
}

// ── HTTP API types ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub ok: bool,
    pub token: Option<String>,
    pub error: Option<String>,
}

// ── Helper constructors ─────────────────────────────────────────────

impl ServerMsg {
    pub fn error(msg: impl Into<String>) -> Self {
        ServerMsg::Error { message: msg.into() }
    }

    pub fn system(msg: impl Into<String>) -> Self {
        ServerMsg::System { content: msg.into() }
    }

    pub fn message(
        channel: &str, author: &str, content: &str,
        expires_at: Option<DateTime<Utc>>,
    ) -> Self {
        ServerMsg::Message {
            id: Uuid::new_v4().to_string(),
            channel: channel.to_string(),
            author: author.to_string(),
            content: content.to_string(),
            timestamp: Utc::now(),
            expires_at,
        }
    }
}
