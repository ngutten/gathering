use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

// ── Reply-to reference ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplyRef {
    pub message_id: String,
    pub author: String,
    pub snippet: String,
}

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
        #[serde(default)]
        encrypted: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply_to: Option<ReplyRef>,
    },
    /// Join a channel (creates it if it doesn't exist)
    Join { channel: String },
    /// Leave a channel
    Leave { channel: String },
    /// Request message history for a channel
    History { channel: String, limit: Option<u32> },
    /// Typing indicator
    Typing { channel: String },
    /// Create a voice channel
    CreateVoiceChannel { channel: String },
    /// Join a voice channel
    VoiceJoin { channel: String },
    /// Leave voice channel
    VoiceLeave { channel: String },
    /// Relay WebRTC signaling data to a specific user
    VoiceSignal { target_user: String, signal_data: serde_json::Value },
    /// Notify server of video/screen share state change
    VideoStateChange { channel: String, video_on: bool, screen_share_on: bool },
    /// Create a new topic in a channel
    CreateTopic {
        channel: String,
        title: String,
        body: String,
        ttl_secs: Option<u64>,
        attachments: Option<Vec<String>>,
        #[serde(default)]
        encrypted: bool,
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
        #[serde(default)]
        encrypted: bool,
    },
    /// Pin/unpin a topic
    PinTopic { topic_id: String, pinned: bool },

    // ── Edit/Delete ──
    EditMessage { message_id: String, content: String },
    DeleteMessage { message_id: String },
    EditTopic { topic_id: String, title: Option<String>, body: Option<String>, #[serde(default)] encrypted: bool },
    DeleteTopic { topic_id: String },
    EditTopicReply { reply_id: String, content: String, #[serde(default)] encrypted: bool },
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

    // ── File Management ──
    ListMyFiles,
    SetFilePinned { file_id: String, pinned: bool },
    DeleteFile { file_id: String },

    // ── Search ──
    SearchMessages { query: String, channel: Option<String> },

    // ── Direct Messages ──
    StartDM { target_user: String },
    ListDMs,

    // ── Channel Access Control ──
    SetChannelRestricted { channel: String, restricted: bool },
    AddChannelMember { channel: String, username: String },
    RemoveChannelMember { channel: String, username: String },
    GetChannelMembers { channel: String },

    // ── E2E Encryption ──
    UploadPublicKey { public_key: String },
    GetPublicKeys { usernames: Vec<String> },
    CreateEncryptedChannel { channel: String, encrypted_channel_key: String },
    RequestChannelKey { channel: String },
    ProvideChannelKey { channel: String, target_user: String, encrypted_key: String },
    RotateChannelKey { channel: String, new_keys: HashMap<String, String> },

    // ── Preferences ──
    GetPreferences,
    SetPreference { key: String, value: String },

    // ── Widgets ──
    WidgetMessage {
        channel: String,
        widget_id: String,
        action: String,
        data: serde_json::Value,
    },
    SaveWidgetState {
        channel: String,
        widget_id: String,
        state: serde_json::Value,
    },
    LoadWidgetState {
        channel: String,
        widget_id: String,
    },
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
        #[serde(default)]
        encrypted: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply_to: Option<ReplyRef>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mentions: Option<Vec<String>>,
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
    /// Voice channel occupancy update (broadcast to all)
    VoiceChannelOccupancy { channel: String, users: Vec<String> },
    /// A user's video/screen share state changed
    UserVideoState { channel: String, username: String, video_on: bool, screen_share_on: bool },
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
    TopicEdited { topic_id: String, channel: String, title: Option<String>, body: Option<String>, edited_at: String, #[serde(default)] encrypted: bool },
    TopicDeleted { topic_id: String, channel: String },
    TopicReplyEdited { reply_id: String, topic_id: String, content: String, edited_at: String, #[serde(default)] encrypted: bool },
    TopicReplyDeleted { reply_id: String, topic_id: String },

    // ── Admin responses ──
    ChannelDeleted { channel: String },
    Settings { settings: HashMap<String, String> },
    InviteCreated { code: String },
    InviteList { invites: Vec<InviteInfo> },
    RoleList { roles: Vec<RoleInfo> },
    UserRoles { username: String, roles: Vec<String> },

    // ── Channel Access Control ──
    ChannelRestricted { channel: String, restricted: bool },
    ChannelMemberList { channel: String, members: Vec<String>, restricted: bool },
    ChannelMemberAdded { channel: String, username: String },
    ChannelMemberRemoved { channel: String, username: String },

    // ── File Management ──
    MyFileList { files: Vec<UserFileInfo>, used_bytes: i64, quota_bytes: i64 },
    FilePinned { file_id: String, pinned: bool },
    FileDeleted { file_id: String },

    // ── Search ──
    SearchResults { query: String, results: Vec<SearchResult> },

    // ── Direct Messages ──
    DMStarted { channel: String, other_user: String, #[serde(default)] initiated: bool },
    DMList { dms: Vec<DMInfo> },

    // ── E2E Encryption ──
    PublicKeys { keys: HashMap<String, String> },
    PublicKeyStored { username: String },
    ChannelKeyData { channel: String, encrypted_key: String, key_version: i32 },
    ChannelKeyRequest { channel: String, requesting_user: String, public_key: String },
    ChannelEncrypted { channel: String },
    ChannelKeyRotated { channel: String, key_version: i32 },

    // ── Preferences ──
    Preferences { prefs: HashMap<String, String> },

    // ── Widgets ──
    WidgetBroadcast {
        channel: String,
        widget_id: String,
        from_user: String,
        action: String,
        data: serde_json::Value,
    },
    WidgetStateLoaded {
        channel: String,
        widget_id: String,
        state: Option<serde_json::Value>,
    },
    WidgetStateSaved {
        channel: String,
        widget_id: String,
    },
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
    #[serde(default)]
    pub encrypted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<ReplyRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelInfo {
    pub name: String,
    pub user_count: usize,
    #[serde(default)]
    pub encrypted: bool,
    #[serde(default)]
    pub channel_type: String,
    #[serde(default)]
    pub restricted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub id: String,
    pub filename: String,
    pub size: i64,
    pub mime_type: String,
    pub url: String,
    #[serde(default)]
    pub encrypted: bool,
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
    #[serde(default)]
    pub encrypted: bool,
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
    #[serde(default)]
    pub encrypted: bool,
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
    #[serde(default)]
    pub encrypted: bool,
}

// ── DM types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DMInfo {
    pub channel: String,
    pub other_user: String,
    pub encrypted: bool,
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
    #[serde(default)]
    pub disk_quota_mb: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserFileInfo {
    pub id: String,
    pub filename: String,
    pub size: i64,
    pub mime_type: String,
    pub channel: String,
    pub created_at: String,
    pub pinned: bool,
    #[serde(default)]
    pub encrypted: bool,
}

// ── Search types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: String,
    pub channel: String,
    pub author: String,
    pub content: String,
    pub timestamp: String,
}

// ── Config ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "ServerConfig::default_port")]
    pub port: u16,
    #[serde(default)]
    pub http_port: Option<u16>,
    #[serde(default)]
    pub admins: Vec<String>,
    #[serde(default)]
    pub default_roles: HashMap<String, Vec<String>>,
}

impl ServerConfig {
    fn default_port() -> u16 { 9123 }
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
            port: Self::default_port(),
            http_port: None,
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

    pub fn message(
        channel: &str, author: &str, content: &str,
        expires_at: Option<DateTime<Utc>>,
        attachments: Option<Vec<FileInfo>>,
        encrypted: bool,
        reply_to: Option<ReplyRef>,
        mentions: Option<Vec<String>>,
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
            encrypted,
            reply_to,
            mentions,
        }
    }
}
