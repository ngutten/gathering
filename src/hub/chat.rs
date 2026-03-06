use chrono::{Duration, Utc};
use regex::Regex;

use super::Hub;
use crate::db::Db;
use crate::protocol::{ReplyRef, ServerMsg};

const MAX_MESSAGE_SIZE: usize = 32 * 1024; // 32KB
const MAX_CHANNEL_NAME_LEN: usize = 64;
const DEFAULT_HISTORY_LIMIT: u32 = 100;
const MAX_HISTORY_LIMIT: u32 = 100;

impl Hub {
    pub(super) async fn handle_send(
        &self,
        id: usize,
        channel: String,
        content: String,
        ttl_secs: Option<u64>,
        attachments: Option<Vec<String>>,
        encrypted: bool,
        reply_to: Option<ReplyRef>,
    ) {
        // Input validation (S11)
        if content.len() > MAX_MESSAGE_SIZE {
            self.send_error(id, "Message too long (max 32KB)").await;
            return;
        }

        let clients = self.clients.lock().await;
        let (username, in_channel) = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => (c.username.clone(), c.channels.contains(&channel)),
            _ => return,
        };

        // Channel membership check (S7)
        if !in_channel {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Not a member of this channel")) {
                    eprintln!("[hub::chat] send membership error failed: {e:?}");
                }
            }
            return;
        }

        // Permission check (S8)
        if !self.db.user_has_permission(&username, "send_message") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied: send_message")) {
                    eprintln!("[hub::chat] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        let expires_at = ttl_secs.map(|s| Utc::now() + Duration::seconds(s as i64));

        // Parse @mentions from content
        let mentions = Self::parse_mentions(&content, &username, &channel, &clients, &self.db);

        // Check permissions for @channel/@server mentions
        if !encrypted {
            let mention_re = Regex::new(r"@(channel|server)\b").unwrap();
            for cap in mention_re.captures_iter(&content) {
                let kind = &cap[1];
                let perm = format!("mention_{}", kind);
                if !self.db.user_has_permission(&username, &perm) {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error(
                            &format!("Permission denied: @{kind} mentions require '{perm}' permission")
                        ));
                    }
                    return;
                }
            }
        }

        // Resolve attachment file IDs to FileInfo
        let file_infos = attachments.as_ref().map(|ids| {
            ids.iter()
                .filter_map(|fid| self.db.get_file(fid))
                .collect::<Vec<_>>()
        }).filter(|v| !v.is_empty());

        let mentions_opt = if mentions.is_empty() { None } else { Some(mentions.clone()) };

        let msg = ServerMsg::message(&channel, &username, &content, expires_at, file_infos, encrypted, reply_to.clone(), mentions_opt.clone());

        // Store in database
        if let ServerMsg::Message {
            ref id, ref timestamp, ref expires_at, ..
        } = msg
        {
            self.db.store_message(
                id, &channel, &username, &content,
                timestamp, expires_at.as_ref(),
                attachments.as_ref(),
                encrypted,
                reply_to.as_ref(),
                mentions_opt.as_ref(),
            );
        }

        // Broadcast to everyone in the channel
        Self::broadcast_to_channel_inner(&clients, &channel, &msg, None);
    }

    fn parse_mentions(
        content: &str,
        author: &str,
        channel: &str,
        clients: &std::collections::HashMap<usize, super::Client>,
        db: &std::sync::Arc<crate::db::Db>,
    ) -> Vec<String> {
        let mention_re = Regex::new(r"@(\w+)").unwrap();
        let mut mentioned = std::collections::HashSet::new();

        for cap in mention_re.captures_iter(content) {
            let name = &cap[1];
            match name {
                "channel" => {
                    // Expand to all users in this channel (except author)
                    for client in clients.values() {
                        if !client.username.is_empty() && client.username != author && client.channels.contains(channel) {
                            mentioned.insert(client.username.clone());
                        }
                    }
                }
                "server" => {
                    // Expand to all online users (except author)
                    for client in clients.values() {
                        if !client.username.is_empty() && client.username != author {
                            mentioned.insert(client.username.clone());
                        }
                    }
                }
                _ => {
                    if name != author && db.user_exists(name) {
                        mentioned.insert(name.to_string());
                    }
                }
            }
        }

        mentioned.into_iter().collect()
    }

    pub(super) async fn handle_join(&self, id: usize, channel: String) {
        // Input validation (S11)
        if channel.len() > MAX_CHANNEL_NAME_LEN || (!Db::is_dm_channel(&channel) && !channel.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-')) {
            self.send_error(id, "Invalid channel name (max 64 chars, alphanumeric/_/- only)").await;
            return;
        }

        // Single lock acquisition for all pre-join checks
        {
            let clients = self.clients.lock().await;
            let username = match clients.get(&id) {
                Some(c) if !c.username.is_empty() => c.username.clone(),
                _ => return,
            };

            if Db::is_dm_channel(&channel) {
                // DM channels: only members can join, no creation via Join
                if !self.db.is_dm_member(&channel, &username) {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Cannot join this DM channel"));
                    }
                    return;
                }
            } else if self.db.channel_exists(&channel) {
                // Existing channel: check access for restricted channels
                if !self.db.can_access_channel(&channel, &username) {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Access denied: channel is restricted"));
                    }
                    return;
                }
            } else {
                // New channel: check channel creation permission
                let creation_mode = self.db.get_setting("channel_creation").unwrap_or_else(|| "all".to_string());
                if creation_mode == "admin" && !self.db.user_has_permission(&username, "create_channel") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Only admins can create channels"));
                    }
                    return;
                }
            }

            // Create channel if needed (still under same logical flow, DB has its own lock)
            if !self.db.channel_exists(&channel) {
                self.db.ensure_channel_with_creator(&channel, &username);
            } else {
                self.db.ensure_channel(&channel);
            }
        }

        let mut clients = self.clients.lock().await;
        let (username, already_joined) = match clients.get_mut(&id) {
            Some(c) if !c.username.is_empty() => {
                let was_new = c.channels.insert(channel.clone());
                (c.username.clone(), !was_new)
            }
            _ => return,
        };

        // Send history
        let history = self.db.get_history(&channel, DEFAULT_HISTORY_LIMIT);
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(
                &client.tx,
                &ServerMsg::History {
                    channel: channel.clone(),
                    messages: history,
                },
            ) {
                eprintln!("[hub::chat] send channel history on join failed: {e:?}");
            }
        }

        // If channel is encrypted, deliver channel key or request it
        if self.db.is_channel_encrypted(&channel) {
            if let Some((encrypted_key, key_version)) = self.db.get_channel_key(&channel, &username) {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::ChannelKeyData {
                        channel: channel.clone(),
                        encrypted_key,
                        key_version,
                    }) {
                        eprintln!("[hub::chat] send channel key on join failed: {e:?}");
                    }
                }
            } else if let Some(pub_key) = self.db.get_public_key(&username) {
                // Broadcast key request to online channel members
                let req_msg = ServerMsg::ChannelKeyRequest {
                    channel: channel.clone(),
                    requesting_user: username.clone(),
                    public_key: pub_key,
                };
                Self::broadcast_to_channel_inner(&clients, &channel, &req_msg, Some(id));
            }
        }

        // Only broadcast join notification and update channel lists for new joins
        if !already_joined {
            let join_msg = ServerMsg::UserJoined {
                channel: channel.clone(),
                username,
            };
            Self::broadcast_to_channel_inner(&clients, &channel, &join_msg, Some(id));

            // Update channel list for everyone (per-user filtering)
            self.broadcast_channel_lists(&clients);
        }
    }

    pub(super) async fn handle_leave(&self, id: usize, channel: String) {
        let mut clients = self.clients.lock().await;
        let username = match clients.get_mut(&id) {
            Some(c) if !c.username.is_empty() => {
                c.channels.remove(&channel);
                c.username.clone()
            }
            _ => return,
        };

        let msg = ServerMsg::UserLeft {
            channel: channel.clone(),
            username,
        };
        Self::broadcast_to_channel_inner(&clients, &channel, &msg, None);
    }

    pub(super) async fn handle_history(&self, id: usize, channel: String, limit: Option<u32>) {
        let clamped_limit = limit.unwrap_or(DEFAULT_HISTORY_LIMIT).min(MAX_HISTORY_LIMIT); // S11: clamp
        let clients = self.clients.lock().await;
        let (_username, in_channel) = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => (c.username.clone(), c.channels.contains(&channel)),
            _ => return,
        };
        // S7: membership check
        if !in_channel {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Not a member of this channel")) {
                    eprintln!("[hub::chat] send membership error failed: {e:?}");
                }
            }
            return;
        }
        drop(clients);
        let history = self.db.get_history(&channel, clamped_limit);
        let clients = self.clients.lock().await;
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(
                &client.tx,
                &ServerMsg::History { channel, messages: history },
            ) {
                eprintln!("[hub::chat] send history failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_typing(&self, id: usize, channel: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        let msg = ServerMsg::UserTyping { channel: channel.clone(), username };
        Self::broadcast_to_channel_inner(&clients, &channel, &msg, Some(id));
    }
}
