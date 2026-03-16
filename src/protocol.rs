use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde::de;
use std::collections::{HashMap, BTreeMap};
use std::fmt;
use uuid::Uuid;

// ── Protocol versioning ─────────────────────────────────────────────

/// Increment when adding new message types or changing existing ones.
pub const PROTOCOL_VERSION: u32 = 1;

/// Coarse-grained feature areas this server supports.
/// Clients can check these to hide UI for unsupported features.
/// Base capabilities always advertised.
pub const SERVER_CAPABILITIES: &[&str] = &[
    "chat", "voice", "topics", "reactions", "pins", "search",
    "e2e", "files", "roles", "dms", "profiles", "widgets",
    "channel_access",
];

/// Build the capabilities list, conditionally including optional features.
pub fn build_capabilities(config: &ServerConfig) -> Vec<String> {
    let mut caps: Vec<String> = SERVER_CAPABILITIES.iter().map(|s| s.to_string()).collect();
    if config.allow_key_backup {
        caps.push("key_backup".to_string());
    }
    if config.public_address.is_some() {
        caps.push("embedded_turn".to_string());
    }
    // Advertise which widgets are enabled. `None` = all (blanket "widgets" already in base caps).
    // `Some(list)` = replace blanket with specific `widget:<id>` entries.
    if let Some(ref enabled) = config.enabled_widgets {
        caps.retain(|c| c != "widgets");
        for wid in enabled {
            caps.push(format!("widget:{wid}"));
        }
    }
    caps
}

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
    Auth {
        token: String,
        #[serde(default)]
        protocol_version: Option<u32>,
    },
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

    // ── Reactions ──
    AddReaction { message_id: String, emoji: String },
    RemoveReaction { message_id: String, emoji: String },

    // ── Message Pinning ──
    PinMessage { message_id: String, pinned: bool },
    GetPinnedMessages { channel: String },

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
    SearchMessages {
        query: String,
        channel: Option<String>,
        #[serde(default)]
        from: Option<String>,
        #[serde(default)]
        date_start: Option<String>,
        #[serde(default)]
        date_end: Option<String>,
        #[serde(default)]
        mentions: Option<String>,
    },

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

    // ── E2E Key Backup ──
    SetKeyBackup { encrypted_key: String, salt: String, nonce: String, ops_limit: u32, mem_limit: u32 },
    GetKeyBackup,
    DeleteKeyBackup,

    // ── Preferences ──
    GetPreferences,
    SetPreference { key: String, value: String },

    // ── Profiles ──
    GetProfile { username: String },
    GetProfiles { usernames: Vec<String> },
    UpdateProfile { field: String, value: String },

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
        #[serde(skip_serializing_if = "Option::is_none")]
        protocol_version: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        capabilities: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ice_servers: Option<Vec<IceServer>>,
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

    // ── Reactions ──
    ReactionUpdated { message_id: String, channel: String, emoji: String, username: String, added: bool },

    // ── Message Pinning ──
    MessagePinned { message_id: String, channel: String, pinned: bool, pinned_by: String },
    PinnedMessages { channel: String, messages: Vec<HistoryMessage> },

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

    // ── E2E Key Backup ──
    KeyBackupData { encrypted_key: String, salt: String, nonce: String, ops_limit: u32, mem_limit: u32 },
    KeyBackupStored,
    KeyBackupDeleted,
    NoKeyBackup,

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

    // ── Profiles ──
    UserProfile { username: String, profile: HashMap<String, String> },
    UserProfiles { profiles: HashMap<String, HashMap<String, String>> },
    ProfileUpdated { username: String, field: String, value: String },

    // ── Server lifecycle ──
    /// Sent to all clients when the server is shutting down gracefully
    ServerShutdown { reason: String },
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reactions: Option<BTreeMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
}

fn is_false(v: &bool) -> bool { !v }

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
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

// ── ICE server config (sent to clients for WebRTC) ──────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
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
    #[serde(default)]
    pub server_name: Option<String>,
    #[serde(default)]
    pub server_icon: Option<String>,
    #[serde(default = "ServerConfig::default_allow_key_backup")]
    pub allow_key_backup: bool,
    #[serde(default = "ServerConfig::default_registration_mode")]
    pub registration_mode: String,
    #[serde(default = "ServerConfig::default_channel_creation")]
    pub channel_creation: String,
    /// Which widgets are enabled. `null` (default) = all widgets allowed.
    /// An empty list disables all widgets. A non-empty list enables only those widget IDs.
    #[serde(default)]
    pub enabled_widgets: Option<Vec<String>>,
    /// Public IP or hostname for embedded STUN/TURN. `null` = disabled (LAN voice only).
    /// Accepts both quoted strings ("192.168.1.1") and unquoted numbers in JSON.
    #[serde(default, deserialize_with = "deserialize_string_or_number")]
    pub public_address: Option<String>,
    /// UDP port for embedded STUN/TURN server. Default 3478.
    #[serde(default = "ServerConfig::default_turn_port")]
    pub turn_port: u16,
}

/// Deserialize a value that could be a JSON string, number, or null into Option<String>.
/// This lets users write `"public_address": 192.168.1.1` (unquoted) without a parse error.
fn deserialize_string_or_number<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: de::Deserializer<'de>,
{
    struct StringOrNumber;

    impl<'de> de::Visitor<'de> for StringOrNumber {
        type Value = Option<String>;

        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a string, number, or null")
        }

        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }

        fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
            if v.is_empty() { Ok(None) } else { Ok(Some(v.to_string())) }
        }

        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
            // A bare IP like 10.0 gets parsed as a float
            Ok(Some(v.to_string()))
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(Some(v.to_string()))
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(Some(v.to_string()))
        }
    }

    deserializer.deserialize_any(StringOrNumber)
}

impl ServerConfig {
    fn default_port() -> u16 { 9123 }
    fn default_allow_key_backup() -> bool { true }
    fn default_registration_mode() -> String { "open".to_string() }
    fn default_channel_creation() -> String { "all".to_string() }
    fn default_turn_port() -> u16 { 3478 }
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
            server_name: None,
            server_icon: None,
            allow_key_backup: Self::default_allow_key_backup(),
            registration_mode: Self::default_registration_mode(),
            channel_creation: Self::default_channel_creation(),
            enabled_widgets: None,
            public_address: None,
            turn_port: Self::default_turn_port(),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_icon: Option<String>,
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
