mod access;
mod admin;
mod chat;
mod dms;
mod encryption;
mod files;
mod messages;
mod profiles;
mod reactions;
mod topics;
mod voice;
mod widgets;

use axum::extract::ws::Message;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use tokio::sync::{Mutex, mpsc};

/// Lightweight voice routing table — separate from the main clients lock
/// so audio forwarding never blocks on chat/channel operations.
struct VoiceRoute {
    tx: mpsc::UnboundedSender<Message>,
    channel: String,
    username: String,
}

/// Lock-free-ish voice routing: std::sync::Mutex held for microseconds only.
/// Audio frames use this instead of the main clients lock, so forwarding
/// never blocks on chat/channel operations.
struct VoiceRouter {
    routes: std::sync::Mutex<HashMap<usize, VoiceRoute>>,
}

impl VoiceRouter {
    fn join(&self, id: usize, tx: mpsc::UnboundedSender<Message>, channel: String, username: String) {
        self.routes.lock().unwrap_or_else(|e| e.into_inner())
            .insert(id, VoiceRoute { tx, channel, username });
    }

    fn leave(&self, id: usize) {
        self.routes.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }

    /// Forward an audio frame to all other clients in the same voice channel.
    /// Returns quickly — the std::sync::Mutex is held only for the iteration.
    fn forward_audio(&self, sender_id: usize, data: &[u8]) {
        if data.len() < 8 { return; }
        let routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
        let sender_channel = match routes.get(&sender_id) {
            Some(r) if !r.username.is_empty() => &r.channel,
            _ => return,
        };

        // Build forwarded frame: [type(1), sender_id(2), seq + timestamp + flags + payload]
        let sid_bytes = (sender_id as u16).to_be_bytes();
        let mut forwarded = Vec::with_capacity(data.len() + 2);
        forwarded.push(0x01);
        forwarded.extend_from_slice(&sid_bytes);
        forwarded.extend_from_slice(&data[1..]);
        let msg = Message::Binary(forwarded);

        for (cid, route) in routes.iter() {
            if *cid == sender_id { continue; }
            if route.channel == *sender_channel && !route.username.is_empty() {
                let _ = route.tx.send(msg.clone());
            }
        }
    }

    /// Forward a video frame to all other clients in the same voice channel.
    fn forward_video(&self, sender_id: usize, data: &[u8]) {
        if data.len() < 12 { return; }
        let routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
        let sender_channel = match routes.get(&sender_id) {
            Some(r) if !r.username.is_empty() => &r.channel,
            _ => return,
        };

        let sid_bytes = (sender_id as u16).to_be_bytes();
        let mut forwarded = Vec::with_capacity(data.len() + 2);
        forwarded.push(0x04);
        forwarded.extend_from_slice(&sid_bytes);
        forwarded.extend_from_slice(&data[1..]);
        let msg = Message::Binary(forwarded);

        for (cid, route) in routes.iter() {
            if *cid == sender_id { continue; }
            if route.channel == *sender_channel && !route.username.is_empty() {
                let _ = route.tx.send(msg.clone());
            }
        }
    }
}

use crate::db::Db;
use crate::protocol::{ChannelInfo, ClientMsg, ServerConfig, ServerMsg, PROTOCOL_VERSION, build_capabilities};
use std::path::PathBuf;

const DEFAULT_HISTORY_LIMIT: u32 = 100;

/// Rolling quality stats report from a client (for bandwidth detection)
struct QualityReport {
    loss_percent: f64,
    jitter_ms: u16,
}

/// A connected user's handle
pub(super) struct Client {
    pub(super) username: String,
    /// Channels this client has joined
    pub(super) channels: HashSet<String>,
    /// Voice channel this client is in (at most one)
    pub(super) voice_channel: Option<String>,
    /// Whether camera video is on
    pub(super) video_on: bool,
    /// Whether screen sharing is on
    pub(super) screen_share_on: bool,
    /// Protocol version the client announced (None = pre-negotiation client)
    pub(super) protocol_version: Option<u32>,
    /// Sender to push messages to their WebSocket
    pub(super) tx: mpsc::UnboundedSender<Message>,
    /// Rolling window of quality reports (last 3) for bandwidth detection
    quality_stats: Vec<QualityReport>,
    /// Whether this client is allowed to receive video frames
    video_allowed: bool,
    /// Consecutive "good" quality reports (for hysteresis on resume)
    good_report_streak: u32,
}

/// Central message hub - owns all connected clients and routes messages
pub struct Hub {
    pub(super) clients: Mutex<HashMap<usize, Client>>,
    pub(super) db: Arc<Db>,
    next_id: Mutex<usize>,
    pub(super) data_dir: PathBuf,
    pub(super) config: RwLock<ServerConfig>,
    /// Shared secret for generating TURN credentials (None if TURN is disabled)
    turn_secret: Option<String>,
    /// Server's LAN IP for hairpin NAT workaround
    lan_ip: Option<std::net::IpAddr>,
    /// Fast voice routing table — never blocks on the main clients lock
    voice_router: VoiceRouter,
}

impl Hub {
    pub fn new(db: Arc<Db>, data_dir: PathBuf, config: ServerConfig, turn_secret: Option<String>) -> Self {
        let lan_ip = if turn_secret.is_some() {
            crate::turn::detect_lan_ip()
        } else {
            None
        };
        Hub {
            clients: Mutex::new(HashMap::new()),
            db,
            next_id: Mutex::new(0),
            data_dir,
            config: RwLock::new(config),
            turn_secret,
            lan_ip,
            voice_router: VoiceRouter { routes: std::sync::Mutex::new(HashMap::new()) },
        }
    }

    /// Register a new WebSocket connection, returns its ID
    pub async fn connect(&self, tx: mpsc::UnboundedSender<Message>) -> usize {
        let mut next = self.next_id.lock().await;
        let id = *next;
        *next += 1;

        let client = Client {
            username: String::new(), // set after auth
            channels: HashSet::new(),
            voice_channel: None,
            video_on: false,
            screen_share_on: false,
            protocol_version: None,
            tx,
            quality_stats: Vec::new(),
            video_allowed: true,
            good_report_streak: 0,
        };
        self.clients.lock().await.insert(id, client);
        id
    }

    /// Remove a client connection
    pub async fn disconnect(&self, id: usize) {
        self.voice_router.leave(id);
        let mut clients = self.clients.lock().await;
        if let Some(client) = clients.remove(&id) {
            if !client.username.is_empty() {
                // Notify voice channel if in one
                if let Some(ref vc) = client.voice_channel {
                    let voice_leave = ServerMsg::VoiceUserLeft {
                        channel: vc.clone(),
                        username: client.username.clone(),
                    };
                    Self::broadcast_to_voice_channel_inner(&clients, vc, &voice_leave, Some(id));

                    // Check if voice channel is now empty
                    let count = Self::voice_channel_user_count(&clients, vc);
                    if count == 0 {
                        self.db.mark_voice_channel_empty(vc);
                    }
                    Self::broadcast_voice_occupancy(&clients, vc);
                }
                // Notify text channels this user was in
                for ch in &client.channels {
                    let leave_msg = ServerMsg::UserLeft {
                        channel: ch.clone(),
                        username: client.username.clone(),
                    };
                    Self::broadcast_to_channel_inner(&clients, ch, &leave_msg, Some(id));
                }
                // Broadcast updated online users
                let online = Self::online_users_inner(&clients);
                let msg = ServerMsg::OnlineUsers { users: online };
                Self::broadcast_all_inner(&clients, &msg, None);
            }
        }
    }

    /// Authenticate a connected client
    pub async fn authenticate(&self, id: usize, token: &str) -> Result<String, String> {
        let username = self.db.validate_token(token).ok_or("Invalid token")?;

        // Get user's DM channels before locking clients
        let user_dms = self.db.list_user_dms(&username);

        let mut clients = self.clients.lock().await;
        if let Some(client) = clients.get_mut(&id) {
            client.username = username.clone();
            // Auto-join general
            client.channels.insert("general".to_string());
            // Auto-join all DM channels
            for dm in &user_dms {
                client.channels.insert(dm.channel.clone());
            }
        }

        // Send channel list (filtered for this user)
        let channels = self.channel_list_for_user(&clients, Some(&username));
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::ChannelList { channels }) {
                eprintln!("[hub] send channel list on auth failed: {e:?}");
            }
        }

        // Send DM list
        if !user_dms.is_empty() {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::DMList { dms: user_dms.clone() }) {
                    eprintln!("[hub] send DM list on auth failed: {e:?}");
                }
                // Send channel keys for DM channels
                for dm in &user_dms {
                    if let Some((encrypted_key, key_version)) = self.db.get_channel_key(&dm.channel, &username) {
                        if let Err(e) = Self::send_to(&client.tx, &ServerMsg::ChannelKeyData {
                            channel: dm.channel.clone(),
                            encrypted_key,
                            key_version,
                        }) {
                            eprintln!("[hub] send DM channel key on auth failed: {e:?}");
                        }
                    }
                }
            }
        }

        // Broadcast updated online users
        let online = Self::online_users_inner(&clients);
        let msg = ServerMsg::OnlineUsers { users: online };
        Self::broadcast_all_inner(&clients, &msg, None);

        // Send history for general
        let mut history = self.db.get_history("general", DEFAULT_HISTORY_LIMIT);
        Self::attach_reactions(&self.db, &mut history);
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(
                &client.tx,
                &ServerMsg::History {
                    channel: "general".to_string(),
                    messages: history,
                },
            ) {
                eprintln!("[hub] send general history on auth failed: {e:?}");
            }
        }

        Ok(username)
    }

    /// Handle an incoming message from an authenticated client
    pub async fn handle_message(&self, id: usize, msg: ClientMsg) {
        // Auth messages are always allowed (that's how clients authenticate)
        // All other messages require authentication
        if !matches!(msg, ClientMsg::Auth { .. }) {
            let clients = self.clients.lock().await;
            let is_authed = clients.get(&id).map_or(false, |c| !c.username.is_empty());
            drop(clients);
            if !is_authed {
                self.send_error(id, "Not authenticated").await;
                return;
            }
        }

        match msg {
            ClientMsg::Auth { token, protocol_version } => {
                // Store client's protocol version
                {
                    let mut clients = self.clients.lock().await;
                    if let Some(client) = clients.get_mut(&id) {
                        client.protocol_version = protocol_version;
                    }
                }

                let result = self.authenticate(id, &token).await;
                let config = self.config.read().unwrap_or_else(|e| e.into_inner()).clone();
                let capabilities = build_capabilities(&config);

                // Generate ICE servers if TURN is configured
                let ice_servers = match (&config.public_address, &self.turn_secret) {
                    (Some(ref addr), Some(ref secret)) => {
                        let (username, credential) = crate::turn::generate_credentials(secret);
                        Some(crate::turn::build_ice_servers(addr, config.turn_port, config.turn_port_alt, config.turn_tcp_port, &username, &credential, self.lan_ip))
                    }
                    _ => None,
                };

                let clients = self.clients.lock().await;
                if let Some(client) = clients.get(&id) {
                    let resp = match result {
                        Ok(ref u) => {
                            let roles = self.db.get_user_roles(u);
                            ServerMsg::AuthResult {
                                ok: true,
                                username: Some(u.clone()),
                                error: None,
                                roles: Some(roles),
                                protocol_version: Some(PROTOCOL_VERSION),
                                capabilities: Some(capabilities),
                                ice_servers,
                            }
                        }
                        Err(ref e) => ServerMsg::AuthResult {
                            ok: false,
                            username: None,
                            error: Some(e.clone()),
                            roles: None,
                            protocol_version: Some(PROTOCOL_VERSION),
                            capabilities: None,
                            ice_servers: None,
                        },
                    };
                    if let Err(e) = Self::send_to(&client.tx, &resp) {
                        eprintln!("[hub] send auth result failed: {e:?}");
                    }
                }
            }

            ClientMsg::Send { channel, content, ttl_secs, attachments, encrypted, reply_to } => {
                self.handle_send(id, channel, content, ttl_secs, attachments, encrypted, reply_to).await;
            }

            ClientMsg::Join { channel } => {
                self.handle_join(id, channel).await;
            }

            ClientMsg::Leave { channel } => {
                self.handle_leave(id, channel).await;
            }

            ClientMsg::History { channel, limit } => {
                self.handle_history(id, channel, limit).await;
            }

            ClientMsg::Typing { channel } => {
                self.handle_typing(id, channel).await;
            }

            ClientMsg::CreateVoiceChannel { channel } => {
                self.handle_create_voice_channel(id, channel).await;
            }

            ClientMsg::VoiceJoin { channel } => {
                self.handle_voice_join(id, channel).await;
            }

            ClientMsg::VoiceLeave { channel } => {
                self.handle_voice_leave(id, channel).await;
            }

            ClientMsg::VoiceSignal { target_user, signal_data } => {
                self.handle_voice_signal(id, target_user, signal_data).await;
            }

            ClientMsg::VideoStateChange { channel, video_on, screen_share_on } => {
                self.handle_video_state_change(id, channel, video_on, screen_share_on).await;
            }

            ClientMsg::CreateTopic { channel, title, body, ttl_secs, attachments, encrypted } => {
                self.handle_create_topic(id, channel, title, body, ttl_secs, attachments, encrypted).await;
            }

            ClientMsg::ListTopics { channel, limit } => {
                self.handle_list_topics(id, channel, limit).await;
            }

            ClientMsg::GetTopic { topic_id } => {
                self.handle_get_topic(id, topic_id).await;
            }

            ClientMsg::TopicReply { topic_id, content, ttl_secs, attachments, encrypted } => {
                self.handle_topic_reply(id, topic_id, content, ttl_secs, attachments, encrypted).await;
            }

            ClientMsg::PinTopic { topic_id, pinned } => {
                self.handle_pin_topic(id, topic_id, pinned).await;
            }

            ClientMsg::AddReaction { message_id, emoji } => {
                self.handle_add_reaction(id, message_id, emoji).await;
            }

            ClientMsg::RemoveReaction { message_id, emoji } => {
                self.handle_remove_reaction(id, message_id, emoji).await;
            }

            ClientMsg::PinMessage { message_id, pinned } => {
                self.handle_pin_message(id, message_id, pinned).await;
            }

            ClientMsg::GetPinnedMessages { channel } => {
                self.handle_get_pinned_messages(id, channel).await;
            }

            ClientMsg::EditMessage { message_id, content } => {
                self.handle_edit_message(id, message_id, content).await;
            }

            ClientMsg::DeleteMessage { message_id } => {
                self.handle_delete_message(id, message_id).await;
            }

            ClientMsg::EditTopic { topic_id, title, body, encrypted } => {
                self.handle_edit_topic(id, topic_id, title, body, encrypted).await;
            }

            ClientMsg::DeleteTopic { topic_id } => {
                self.handle_delete_topic(id, topic_id).await;
            }

            ClientMsg::EditTopicReply { reply_id, content, encrypted } => {
                self.handle_edit_topic_reply(id, reply_id, content, encrypted).await;
            }

            ClientMsg::DeleteTopicReply { reply_id } => {
                self.handle_delete_topic_reply(id, reply_id).await;
            }

            ClientMsg::DeleteChannel { channel } => {
                self.handle_delete_channel(id, channel).await;
            }

            ClientMsg::GetSettings => {
                self.handle_get_settings(id).await;
            }

            ClientMsg::UpdateSetting { key, value } => {
                self.handle_update_setting(id, key, value).await;
            }

            ClientMsg::CreateInvite => {
                self.handle_create_invite(id).await;
            }

            ClientMsg::ListInvites => {
                self.handle_list_invites(id).await;
            }

            ClientMsg::ListRoles => {
                self.handle_list_roles(id).await;
            }

            ClientMsg::CreateRole { name, permissions } => {
                self.handle_create_role(id, name, permissions).await;
            }

            ClientMsg::UpdateRole { name, permissions } => {
                self.handle_update_role(id, name, permissions).await;
            }

            ClientMsg::DeleteRole { name } => {
                self.handle_delete_role(id, name).await;
            }

            ClientMsg::AssignRole { username: target_user, role_name } => {
                self.handle_assign_role(id, target_user, role_name).await;
            }

            ClientMsg::RemoveRole { username: target_user, role_name } => {
                self.handle_remove_role(id, target_user, role_name).await;
            }

            ClientMsg::GetUserRoles { username: target_user } => {
                self.handle_get_user_roles(id, target_user).await;
            }

            ClientMsg::SetChannelRestricted { channel, restricted } => {
                self.handle_set_channel_restricted(id, channel, restricted).await;
            }

            ClientMsg::AddChannelMember { channel, username: target_user } => {
                self.handle_add_channel_member(id, channel, target_user).await;
            }

            ClientMsg::RemoveChannelMember { channel, username: target_user } => {
                self.handle_remove_channel_member(id, channel, target_user).await;
            }

            ClientMsg::GetChannelMembers { channel } => {
                self.handle_get_channel_members(id, channel).await;
            }

            ClientMsg::SetChannelAnonymous { channel, anonymous } => {
                self.handle_set_channel_anonymous(id, channel, anonymous).await;
            }

            ClientMsg::SetChannelGhost { channel, force_ghost } => {
                self.handle_set_channel_ghost(id, channel, force_ghost).await;
            }

            ClientMsg::SetChannelMaxTtl { channel, max_ttl_secs } => {
                self.handle_set_channel_max_ttl(id, channel, max_ttl_secs).await;
            }

            ClientMsg::UploadPublicKey { public_key } => {
                self.handle_upload_public_key(id, public_key).await;
            }

            ClientMsg::GetPublicKeys { usernames } => {
                self.handle_get_public_keys(id, usernames).await;
            }

            ClientMsg::CreateEncryptedChannel { channel, encrypted_channel_key } => {
                self.handle_create_encrypted_channel(id, channel, encrypted_channel_key).await;
            }

            ClientMsg::RequestChannelKey { channel } => {
                self.handle_request_channel_key(id, channel).await;
            }

            ClientMsg::ProvideChannelKey { channel, target_user, encrypted_key } => {
                self.handle_provide_channel_key(id, channel, target_user, encrypted_key).await;
            }

            ClientMsg::RotateChannelKey { channel, new_keys } => {
                self.handle_rotate_channel_key(id, channel, new_keys).await;
            }

            ClientMsg::SetKeyBackup { encrypted_key, salt, nonce, ops_limit, mem_limit } => {
                let allowed = self.config.read().unwrap_or_else(|e| e.into_inner()).allow_key_backup;
                if !allowed {
                    self.send_error(id, "Key backup is disabled on this server").await;
                } else {
                    self.handle_set_key_backup(id, encrypted_key, salt, nonce, ops_limit, mem_limit).await;
                }
            }
            ClientMsg::GetKeyBackup => {
                let allowed = self.config.read().unwrap_or_else(|e| e.into_inner()).allow_key_backup;
                if !allowed {
                    self.send_msg(id, &ServerMsg::NoKeyBackup).await;
                } else {
                    self.handle_get_key_backup(id).await;
                }
            }
            ClientMsg::DeleteKeyBackup => {
                let allowed = self.config.read().unwrap_or_else(|e| e.into_inner()).allow_key_backup;
                if !allowed {
                    self.send_error(id, "Key backup is disabled on this server").await;
                } else {
                    self.handle_delete_key_backup(id).await;
                }
            }

            ClientMsg::SearchMessages { query, channel, from, date_start, date_end, mentions } => {
                self.handle_search_messages(id, query, channel, from, date_start, date_end, mentions).await;
            }

            ClientMsg::ListMyFiles => {
                self.handle_list_my_files(id).await;
            }

            ClientMsg::SetFilePinned { file_id, pinned } => {
                self.handle_set_file_pinned(id, file_id, pinned).await;
            }

            ClientMsg::DeleteFile { file_id } => {
                self.handle_delete_file(id, file_id).await;
            }

            ClientMsg::StartDM { target_user } => {
                self.handle_start_dm(id, target_user).await;
            }

            ClientMsg::ListDMs => {
                self.handle_list_dms(id).await;
            }

            ClientMsg::GetProfile { username: target_user } => {
                self.handle_get_profile(id, target_user).await;
            }

            ClientMsg::GetProfiles { usernames } => {
                self.handle_get_profiles(id, usernames).await;
            }

            ClientMsg::UpdateProfile { field, value } => {
                self.handle_update_profile(id, field, value).await;
            }

            ClientMsg::GetPreferences => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };
                drop(clients);
                let prefs = self.db.get_user_preferences(&username);
                self.send_msg(id, &ServerMsg::Preferences { prefs }).await;
            }

            ClientMsg::SetPreference { key, value } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };
                drop(clients);
                // Validate preference keys and their allowed values
                let valid = match key.as_str() {
                    "notify_mention" | "notify_channel_mention" | "notify_server_mention" => {
                        ["window", "system", "none"].contains(&value.as_str())
                    }
                    "notify_sound" => {
                        ["on", "off"].contains(&value.as_str())
                    }
                    "allow_dms" => {
                        ["everyone", "none"].contains(&value.as_str())
                    }
                    "ghost_ttl" => {
                        value.parse::<u64>().is_ok()
                    }
                    _ => {
                        self.send_error(id, "Invalid preference key").await;
                        return;
                    }
                };
                if !valid {
                    self.send_error(id, "Invalid preference value").await;
                    return;
                }
                self.db.set_user_preference(&username, &key, &value);
                let prefs = self.db.get_user_preferences(&username);
                self.send_msg(id, &ServerMsg::Preferences { prefs }).await;
            }

            ClientMsg::WidgetMessage { channel, widget_id, action, data } => {
                self.handle_widget_message(id, channel, widget_id, action, data).await;
            }

            ClientMsg::SaveWidgetState { channel, widget_id, state } => {
                self.handle_save_widget_state(id, channel, widget_id, state).await;
            }

            ClientMsg::LoadWidgetState { channel, widget_id } => {
                self.handle_load_widget_state(id, channel, widget_id).await;
            }
        }
    }

    // ── Internal helpers (take &HashMap to avoid deadlocks) ─────────

    pub(super) fn send_to(tx: &mpsc::UnboundedSender<Message>, msg: &ServerMsg) -> Result<(), ()> {
        let json = serde_json::to_string(msg).map_err(|_| ())?;
        tx.send(Message::Text(json)).map_err(|_| ())
    }

    pub(super) fn broadcast_to_channel_inner(
        clients: &HashMap<usize, Client>,
        channel: &str,
        msg: &ServerMsg,
        exclude: Option<usize>,
    ) {
        let json = match serde_json::to_string(msg) {
            Ok(j) => j,
            Err(_) => return,
        };
        for (cid, client) in clients {
            if exclude == Some(*cid) { continue; }
            if client.channels.contains(channel) {
                if let Err(e) = client.tx.send(Message::Text(json.clone())) {
                    eprintln!("[hub] broadcast to channel failed for client {cid}: {e}");
                }
            }
        }
    }

    pub(super) fn broadcast_to_voice_channel_inner(
        clients: &HashMap<usize, Client>,
        channel: &str,
        msg: &ServerMsg,
        exclude: Option<usize>,
    ) {
        let json = match serde_json::to_string(msg) {
            Ok(j) => j,
            Err(_) => return,
        };
        for (cid, client) in clients {
            if exclude == Some(*cid) { continue; }
            if client.voice_channel.as_deref() == Some(channel) {
                if let Err(e) = client.tx.send(Message::Text(json.clone())) {
                    eprintln!("[hub] broadcast to voice channel failed for client {cid}: {e}");
                }
            }
        }
    }

    /// Broadcast per-user filtered channel lists to all authenticated clients
    pub(super) fn broadcast_channel_lists(&self, clients: &HashMap<usize, Client>) {
        for (&cid, client) in clients {
            if client.username.is_empty() { continue; }
            let channels = self.channel_list_for_user(clients, Some(&client.username));
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::ChannelList { channels }) {
                eprintln!("[hub] broadcast channel list to client {} failed: {e:?}", cid);
            }
        }
    }

    pub(super) fn broadcast_all_inner(
        clients: &HashMap<usize, Client>,
        msg: &ServerMsg,
        exclude: Option<usize>,
    ) {
        let json = match serde_json::to_string(msg) {
            Ok(j) => j,
            Err(_) => return,
        };
        for (cid, client) in clients {
            if exclude == Some(*cid) { continue; }
            if !client.username.is_empty() {
                if let Err(e) = client.tx.send(Message::Text(json.clone())) {
                    eprintln!("[hub] broadcast to all failed for client {cid}: {e}");
                }
            }
        }
    }

    fn online_users_inner(clients: &HashMap<usize, Client>) -> Vec<String> {
        let mut users: Vec<String> = clients
            .values()
            .filter(|c| !c.username.is_empty())
            .map(|c| c.username.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        users.sort();
        users
    }

    fn channel_list_for_user(&self, clients: &HashMap<usize, Client>, username: Option<&str>) -> Vec<ChannelInfo> {
        let db_channels = self.db.list_channels_with_type();
        db_channels
            .into_iter()
            .filter(|(name, _)| !Db::is_dm_channel(name))
            .filter(|(name, _)| {
                // Filter out restricted channels the user can't access
                if let Some(user) = username {
                    self.db.can_access_channel(name, user)
                } else {
                    true
                }
            })
            .map(|(name, channel_type)| {
                let user_count = clients
                    .values()
                    .filter(|c| c.channels.contains(&name))
                    .count();
                let encrypted = self.db.is_channel_encrypted(&name);
                let restricted = self.db.is_channel_restricted(&name);
                let created_by = self.db.get_channel_creator(&name);
                let has_key = if encrypted {
                    username.map(|u| self.db.user_has_channel_key(&name, u))
                } else {
                    None
                };
                let anonymous = self.db.is_channel_anonymous(&name);
                let force_ghost = self.db.is_channel_force_ghost(&name);
                let max_ttl_secs = self.db.get_channel_max_ttl(&name);
                ChannelInfo { name, user_count, encrypted, channel_type, restricted, created_by, has_key, anonymous, force_ghost, max_ttl_secs }
            })
            .collect()
    }

    /// Count voice users in a channel
    pub(super) fn voice_channel_user_count(clients: &HashMap<usize, Client>, channel: &str) -> usize {
        clients.values()
            .filter(|c| c.voice_channel.as_deref() == Some(channel) && !c.username.is_empty())
            .count()
    }

    /// Get voice users in a channel
    pub(super) fn voice_channel_users(clients: &HashMap<usize, Client>, channel: &str) -> Vec<String> {
        clients.values()
            .filter(|c| c.voice_channel.as_deref() == Some(channel) && !c.username.is_empty())
            .map(|c| c.username.clone())
            .collect()
    }

    /// Broadcast voice channel occupancy to all clients
    pub(super) fn broadcast_voice_occupancy(clients: &HashMap<usize, Client>, channel: &str) {
        let users = Self::voice_channel_users(clients, channel);
        let msg = ServerMsg::VoiceChannelOccupancy {
            channel: channel.to_string(),
            users,
        };
        Self::broadcast_all_inner(clients, &msg, None);
    }

    /// Send an error message to a client
    pub(super) async fn send_error(&self, id: usize, msg: &str) {
        let clients = self.clients.lock().await;
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(msg)) {
                eprintln!("[hub] send error to client {id} failed: {e:?}");
            }
        }
    }

    /// Send a message to a client
    pub(super) async fn send_msg(&self, id: usize, msg: &ServerMsg) {
        let clients = self.clients.lock().await;
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, msg) {
                eprintln!("[hub] send message to client {id} failed: {e:?}");
            }
        }
    }

    /// Send an error to a client (public, for use by the WS handler on parse failures)
    pub async fn send_client_error(&self, id: usize, msg: &str) {
        self.send_error(id, msg).await;
    }

    /// Handle a binary WebSocket frame (SFU audio, quality stats, or video).
    ///
    /// Frame type byte:
    ///   0x01 = audio frame (8-byte header + Opus payload)
    ///   0x02 = quality stats report (5+ bytes)
    ///   0x04 = video frame (12-byte header + VP8 payload)
    ///
    /// Audio and video frames use the fast VoiceRouter (std::sync::Mutex held
    /// for microseconds) so they never block on the main clients lock.
    /// Quality stats are infrequent and still use the main lock.
    pub async fn handle_audio_binary(&self, id: usize, data: Vec<u8>) {
        if data.is_empty() { return; }

        match data[0] {
            0x01 => {
                // Audio frame — fast path, no async lock
                self.voice_router.forward_audio(id, &data);
            }
            0x04 => {
                // Video frame — fast path, no async lock
                self.voice_router.forward_video(id, &data);
            }
            0x02 => {
                // Quality stats report (infrequent) — uses main lock
                if data.len() < 5 { return; }
                let packets_received = u16::from_be_bytes([data[1], data[2]]) as f64;
                let packets_lost = u16::from_be_bytes([data[3], data[4]]) as f64;
                let jitter_ms = if data.len() >= 7 {
                    u16::from_be_bytes([data[5], data[6]])
                } else {
                    0
                };

                let total = packets_received + packets_lost;
                let loss_percent = if total > 0.0 { packets_lost / total * 100.0 } else { 0.0 };

                let mut clients = self.clients.lock().await;
                if let Some(client) = clients.get_mut(&id) {
                    client.quality_stats.push(QualityReport { loss_percent, jitter_ms });
                    if client.quality_stats.len() > 3 {
                        client.quality_stats.remove(0);
                    }
                    Self::evaluate_bandwidth(client);
                }
            }
            _ => {}
        }
    }

    /// Evaluate bandwidth quality for a client and toggle video_allowed.
    /// Thresholds: pause video if loss > 5% or jitter > 100ms across the rolling window.
    /// Resume only after 2 consecutive "good" reports (hysteresis).
    fn evaluate_bandwidth(client: &mut Client) {
        if client.quality_stats.is_empty() { return; }

        let max_loss = client.quality_stats.iter().map(|r| r.loss_percent).fold(0.0_f64, f64::max);
        let max_jitter = client.quality_stats.iter().map(|r| r.jitter_ms).max().unwrap_or(0);

        let is_degraded = max_loss > 5.0 || max_jitter > 100;

        if is_degraded {
            client.good_report_streak = 0;
            if client.video_allowed {
                client.video_allowed = false;
                let reason = if max_loss > 5.0 {
                    format!("packet loss {:.1}%", max_loss)
                } else {
                    format!("jitter {}ms", max_jitter)
                };
                let msg = ServerMsg::VideoPaused { reason };
                let _ = Self::send_to(&client.tx, &msg);
            }
        } else {
            client.good_report_streak += 1;
            // Require 2 consecutive good reports before resuming
            if !client.video_allowed && client.good_report_streak >= 2 {
                client.video_allowed = true;
                let _ = Self::send_to(&client.tx, &ServerMsg::VideoResumed);
            }
        }
    }

    /// Graceful shutdown: notify all clients and drop their senders
    pub async fn shutdown(&self, reason: &str) {
        let mut clients = self.clients.lock().await;
        let msg = ServerMsg::ServerShutdown { reason: reason.to_string() };
        for (_, client) in clients.iter() {
            let _ = Self::send_to(&client.tx, &msg);
        }
        clients.clear();
        tracing::info!("Hub shutdown complete: all clients notified and removed");
    }
}
