use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
        /// Attached file IDs
        attachments: Option<Vec<String>>,
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
    /// Create a new topic in a channel
    CreateTopic {
        channel: String,
        title: String,
        body: String,
        ttl_secs: Option<u64>,
        attachments: Option<Vec<String>>,
    },
    /// List topics for a channel
    ListTopics { channel: String, limit: Option<u32> },
    /// Get a topic and its replies
    GetTopic { topic_id: String },
    /// Reply to a topic
    TopicReply {
        topic_id: String,
        content: String,
        ttl_secs: Option<u64>,
        attachments: Option<Vec<String>>,
    },
    /// Pin/unpin a topic
    PinTopic { topic_id: String, pinned: bool },

    // ── Edit/Delete ──
    EditMessage { message_id: String, content: String },
    DeleteMessage { message_id: String },
    EditTopic { topic_id: String, title: Option<String>, body: Option<String> },
    DeleteTopic { topic_id: String },
    EditTopicReply { reply_id: String, content: String },
    DeleteTopicReply { reply_id: String },

    // ── Admin ──
    DeleteChannel { channel: String },
    GetSettings,
    UpdateSetting { key: String, value: String },
    CreateInvite,
    ListInvites,
    ListRoles,
    CreateRole { name: String, permissions: Vec<String> },
    UpdateRole { name: String, permissions: Vec<String> },
    DeleteRole { name: String },
    AssignRole { username: String, role_name: String },
    RemoveRole { username: String, role_name: String },
    GetUserRoles { username: String },
}

// ── Server → Client messages ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMsg {
    /// Authentication result
    AuthResult {
        ok: bool,
        username: Option<String>,
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        roles: Option<Vec<String>>,
    },
    /// A chat message (new or historical)
    Message {
        id: String,
        channel: String,
        author: String,
        content: String,
        timestamp: DateTime<Utc>,
        expires_at: Option<DateTime<Utc>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attachments: Option<Vec<FileInfo>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        edited_at: Option<DateTime<Utc>>,
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
    /// List of topics for a channel
    TopicList { channel: String, topics: Vec<TopicSummary> },
    /// Full topic with replies
    TopicDetail { topic: TopicDetailData, replies: Vec<TopicReplyData> },
    /// A new topic was created (broadcast)
    TopicCreated { topic: TopicSummary },
    /// A new reply was added to a topic (broadcast)
    TopicReplyAdded { topic_id: String, reply: TopicReplyData },
    /// Topic pin status changed (broadcast)
    TopicPinned { topic_id: String, channel: String, pinned: bool },

    // ── Edit/Delete broadcasts ──
    MessageEdited { id: String, channel: String, content: String, edited_at: String },
    MessageDeleted { id: String, channel: String },
    TopicEdited { topic_id: String, channel: String, title: Option<String>, body: Option<String>, edited_at: String },
    TopicDeleted { topic_id: String, channel: String },
    TopicReplyEdited { reply_id: String, topic_id: String, content: String, edited_at: String },
    TopicReplyDeleted { reply_id: String, topic_id: String },

    // ── Admin responses ──
    ChannelDeleted { channel: String },
    Settings { settings: HashMap<String, String> },
    InviteCreated { code: String },
    InviteList { invites: Vec<InviteInfo> },
    RoleList { roles: Vec<RoleInfo> },
    UserRoles { username: String, roles: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryMessage {
    pub id: String,
    pub author: String,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<FileInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelInfo {
    pub name: String,
    pub user_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub id: String,
    pub filename: String,
    pub size: i64,
    pub mime_type: String,
    pub url: String,
}

// ── Topic types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicSummary {
    pub id: String,
    pub channel: String,
    pub title: String,
    pub author: String,
    pub created_at: String,
    pub pinned: bool,
    pub reply_count: u32,
    pub last_activity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicDetailData {
    pub id: String,
    pub channel: String,
    pub title: String,
    pub body: String,
    pub author: String,
    pub created_at: String,
    pub pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<FileInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicReplyData {
    pub id: String,
    pub topic_id: String,
    pub author: String,
    pub content: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<FileInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
}

// ── Admin data types ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InviteInfo {
    pub code: String,
    pub created_by: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleInfo {
    pub name: String,
    pub permissions: Vec<String>,
}

// ── Config ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    #[serde(default)]
    pub admins: Vec<String>,
    #[serde(default)]
    pub default_roles: HashMap<String, Vec<String>>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        let mut default_roles = HashMap::new();
        default_roles.insert("user".to_string(), vec![
            "send_message".to_string(),
            "edit_own_message".to_string(),
            "delete_own_message".to_string(),
            "create_topic".to_string(),
            "edit_own_topic".to_string(),
            "delete_own_topic".to_string(),
            "create_channel".to_string(),
            "upload_file".to_string(),
        ]);
        default_roles.insert("admin".to_string(), vec!["*".to_string()]);
        ServerConfig {
            admins: vec![],
            default_roles,
        }
    }
}

// ── HTTP API types ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
    pub invite_code: Option<String>,
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

#[derive(Debug, Serialize)]
pub struct UploadResponse {
    pub ok: bool,
    pub file: Option<FileInfo>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ServerInfoResponse {
    pub registration_mode: String,
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
        attachments: Option<Vec<FileInfo>>,
    ) -> Self {
        ServerMsg::Message {
            id: Uuid::new_v4().to_string(),
            channel: channel.to_string(),
            author: author.to_string(),
            content: content.to_string(),
            timestamp: Utc::now(),
            expires_at,
            attachments,
            edited_at: None,
        }
    }
}
