use axum::extract::ws::Message;
use chrono::{Duration, Utc};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{Mutex, mpsc};

use crate::db::Db;
use crate::protocol::{ChannelInfo, ClientMsg, ServerMsg, TopicSummary, TopicReplyData};

/// A connected user's handle
struct Client {
    username: String,
    /// Channels this client has joined
    channels: HashSet<String>,
    /// Voice channel this client is in (at most one)
    voice_channel: Option<String>,
    /// Sender to push messages to their WebSocket
    tx: mpsc::UnboundedSender<Message>,
}

/// Central message hub - owns all connected clients and routes messages
pub struct Hub {
    clients: Mutex<HashMap<usize, Client>>,
    db: Arc<Db>,
    next_id: Mutex<usize>,
}

impl Hub {
    pub fn new(db: Arc<Db>) -> Self {
        Hub {
            clients: Mutex::new(HashMap::new()),
            db,
            next_id: Mutex::new(0),
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
            tx,
        };
        self.clients.lock().await.insert(id, client);
        id
    }

    /// Remove a client connection
    pub async fn disconnect(&self, id: usize) {
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

        let mut clients = self.clients.lock().await;
        if let Some(client) = clients.get_mut(&id) {
            client.username = username.clone();
            // Auto-join general
            client.channels.insert("general".to_string());
        }

        // Send channel list
        let channels = self.channel_list_inner(&clients);
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::ChannelList { channels });
        }

        // Broadcast updated online users
        let online = Self::online_users_inner(&clients);
        let msg = ServerMsg::OnlineUsers { users: online };
        Self::broadcast_all_inner(&clients, &msg, None);

        // Send history for general
        let history = self.db.get_history("general", 100);
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(
                &client.tx,
                &ServerMsg::History {
                    channel: "general".to_string(),
                    messages: history,
                },
            );
        }

        Ok(username)
    }

    /// Handle an incoming message from an authenticated client
    pub async fn handle_message(&self, id: usize, msg: ClientMsg) {
        match msg {
            ClientMsg::Auth { token } => {
                let result = self.authenticate(id, &token).await;
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
                            }
                        }
                        Err(ref e) => ServerMsg::AuthResult {
                            ok: false,
                            username: None,
                            error: Some(e.clone()),
                            roles: None,
                        },
                    };
                    let _ = Self::send_to(&client.tx, &resp);
                }
            }

            ClientMsg::Send { channel, content, ttl_secs, attachments, encrypted } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                let expires_at = ttl_secs.map(|s| Utc::now() + Duration::seconds(s as i64));

                // Resolve attachment file IDs to FileInfo
                let file_infos = attachments.as_ref().map(|ids| {
                    ids.iter()
                        .filter_map(|fid| self.db.get_file(fid))
                        .collect::<Vec<_>>()
                }).filter(|v| !v.is_empty());

                let msg = ServerMsg::message(&channel, &username, &content, expires_at, file_infos, encrypted);

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
                    );
                }

                // Broadcast to everyone in the channel
                Self::broadcast_to_channel_inner(&clients, &channel, &msg, None);
            }

            ClientMsg::Join { channel } => {
                // Check channel creation permission
                if !self.db.channel_exists(&channel) {
                    let clients = self.clients.lock().await;
                    let username = match clients.get(&id) {
                        Some(c) if !c.username.is_empty() => c.username.clone(),
                        _ => return,
                    };
                    let creation_mode = self.db.get_setting("channel_creation").unwrap_or_else(|| "all".to_string());
                    if creation_mode == "admin" && !self.db.user_has_permission(&username, "create_channel") {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Only admins can create channels"));
                        }
                        return;
                    }
                    drop(clients);
                }

                self.db.ensure_channel(&channel);
                let mut clients = self.clients.lock().await;
                let username = match clients.get_mut(&id) {
                    Some(c) if !c.username.is_empty() => {
                        c.channels.insert(channel.clone());
                        c.username.clone()
                    }
                    _ => return,
                };

                // Send history
                let history = self.db.get_history(&channel, 100);
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(
                        &client.tx,
                        &ServerMsg::History {
                            channel: channel.clone(),
                            messages: history,
                        },
                    );
                }

                // If channel is encrypted, deliver channel key or request it
                if self.db.is_channel_encrypted(&channel) {
                    if let Some((encrypted_key, key_version)) = self.db.get_channel_key(&channel, &username) {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::ChannelKeyData {
                                channel: channel.clone(),
                                encrypted_key,
                                key_version,
                            });
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

                // Notify channel
                let join_msg = ServerMsg::UserJoined {
                    channel: channel.clone(),
                    username,
                };
                Self::broadcast_to_channel_inner(&clients, &channel, &join_msg, Some(id));

                // Update channel list for everyone
                let channels = self.channel_list_inner(&clients);
                let list_msg = ServerMsg::ChannelList { channels };
                Self::broadcast_all_inner(&clients, &list_msg, None);
            }

            ClientMsg::Leave { channel } => {
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

            ClientMsg::History { channel, limit } => {
                let history = self.db.get_history(&channel, limit.unwrap_or(100));
                let clients = self.clients.lock().await;
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(
                        &client.tx,
                        &ServerMsg::History { channel, messages: history },
                    );
                }
            }

            ClientMsg::Typing { channel } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };
                let msg = ServerMsg::UserTyping { channel: channel.clone(), username };
                Self::broadcast_to_channel_inner(&clients, &channel, &msg, Some(id));
            }

            ClientMsg::VoiceJoin { channel } => {
                let mut clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                // Auto-leave previous voice channel
                if let Some(old_vc) = clients.get(&id).and_then(|c| c.voice_channel.clone()) {
                    let leave_msg = ServerMsg::VoiceUserLeft {
                        channel: old_vc.clone(),
                        username: username.clone(),
                    };
                    Self::broadcast_to_voice_channel_inner(&clients, &old_vc, &leave_msg, Some(id));
                }

                // Set new voice channel
                if let Some(client) = clients.get_mut(&id) {
                    client.voice_channel = Some(channel.clone());
                }

                // Collect current voice members for this channel
                let members: Vec<String> = clients.values()
                    .filter(|c| c.voice_channel.as_deref() == Some(&channel) && !c.username.is_empty())
                    .map(|c| c.username.clone())
                    .collect();

                // Send VoiceMembers to the joiner
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::VoiceMembers {
                        channel: channel.clone(),
                        users: members,
                    });
                }

                // Broadcast VoiceUserJoined to others in the voice channel
                let join_msg = ServerMsg::VoiceUserJoined {
                    channel: channel.clone(),
                    username,
                };
                Self::broadcast_to_voice_channel_inner(&clients, &channel, &join_msg, Some(id));
            }

            ClientMsg::VoiceLeave { channel } => {
                let mut clients = self.clients.lock().await;
                let username = match clients.get_mut(&id) {
                    Some(c) if !c.username.is_empty() && c.voice_channel.as_deref() == Some(&channel) => {
                        c.voice_channel = None;
                        c.username.clone()
                    }
                    _ => return,
                };

                let msg = ServerMsg::VoiceUserLeft {
                    channel: channel.clone(),
                    username,
                };
                Self::broadcast_to_voice_channel_inner(&clients, &channel, &msg, Some(id));
            }

            ClientMsg::VoiceSignal { target_user, signal_data } => {
                let clients = self.clients.lock().await;
                let from_user = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                // Find target user and relay
                for client in clients.values() {
                    if client.username == target_user {
                        let _ = Self::send_to(&client.tx, &ServerMsg::VoiceSignal {
                            from_user: from_user.clone(),
                            signal_data: signal_data.clone(),
                        });
                    }
                }
            }

            ClientMsg::CreateTopic { channel, title, body, ttl_secs, attachments } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                let topic_id = uuid::Uuid::new_v4().to_string();
                let now = chrono::Utc::now();
                let now_str = now.to_rfc3339();
                let expires_at = ttl_secs.map(|s| (now + Duration::seconds(s as i64)).to_rfc3339());
                if let Err(e) = self.db.create_topic(
                    &topic_id, &channel, &title, &body, &username,
                    expires_at.as_deref(), attachments.as_ref(),
                ) {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                    }
                    return;
                }

                let summary = TopicSummary {
                    id: topic_id,
                    channel: channel.clone(),
                    title,
                    author: username,
                    created_at: now_str.clone(),
                    pinned: false,
                    reply_count: 0,
                    last_activity: now_str,
                    expires_at,
                };
                Self::broadcast_to_channel_inner(&clients, &channel, &ServerMsg::TopicCreated { topic: summary }, None);
            }

            ClientMsg::ListTopics { channel, limit } => {
                let topics = self.db.list_topics(&channel, limit.unwrap_or(50));
                let clients = self.clients.lock().await;
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::TopicList { channel, topics });
                }
            }

            ClientMsg::GetTopic { topic_id } => {
                let topic = self.db.get_topic(&topic_id);
                let clients = self.clients.lock().await;
                if let Some(client) = clients.get(&id) {
                    match topic {
                        Some(t) => {
                            let replies = self.db.get_topic_replies(&topic_id, 500);
                            let _ = Self::send_to(&client.tx, &ServerMsg::TopicDetail { topic: t, replies });
                        }
                        None => {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Topic not found"));
                        }
                    }
                }
            }

            ClientMsg::TopicReply { topic_id, content, ttl_secs, attachments } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                let reply_id = uuid::Uuid::new_v4().to_string();
                let now = chrono::Utc::now();
                let now_str = now.to_rfc3339();
                let expires_at = ttl_secs.map(|s| (now + Duration::seconds(s as i64)).to_rfc3339());
                if let Err(e) = self.db.create_topic_reply(
                    &reply_id, &topic_id, &username, &content,
                    expires_at.as_deref(), attachments.as_ref(),
                ) {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                    }
                    return;
                }

                // Look up topic's channel
                let channel = match self.db.get_topic(&topic_id) {
                    Some(t) => t.channel,
                    None => return,
                };

                // Resolve attachment file IDs to FileInfo
                let file_infos = attachments.as_ref().map(|ids| {
                    ids.iter()
                        .filter_map(|fid| self.db.get_file(fid))
                        .collect::<Vec<_>>()
                }).filter(|v| !v.is_empty());

                let reply = TopicReplyData {
                    id: reply_id,
                    topic_id: topic_id.clone(),
                    author: username,
                    content,
                    created_at: now_str,
                    expires_at,
                    attachments: file_infos,
                    edited_at: None,
                };
                Self::broadcast_to_channel_inner(&clients, &channel, &ServerMsg::TopicReplyAdded { topic_id, reply }, None);
            }

            ClientMsg::PinTopic { topic_id, pinned } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                // Check pin_topic permission
                if !self.db.user_has_permission(&username, "pin_topic") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied: pin_topic"));
                    }
                    return;
                }

                if let Err(e) = self.db.pin_topic(&topic_id, pinned) {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                    }
                    return;
                }

                let channel = match self.db.get_topic(&topic_id) {
                    Some(t) => t.channel,
                    None => return,
                };

                Self::broadcast_to_channel_inner(&clients, &channel, &ServerMsg::TopicPinned { topic_id, channel: channel.clone(), pinned }, None);
            }

            // ── Edit/Delete messages ────────────────────────────────

            ClientMsg::EditMessage { message_id, content } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                // Check ownership
                let info = match self.db.get_message_info(&message_id) {
                    Some(i) => i,
                    None => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Message not found"));
                        }
                        return;
                    }
                };
                let (_channel, author) = info;
                if author != username {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Can only edit your own messages"));
                    }
                    return;
                }
                if !self.db.user_has_permission(&username, "edit_own_message") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                match self.db.edit_message(&message_id, &content) {
                    Ok((ch, _)) => {
                        let now = Utc::now().to_rfc3339();
                        Self::broadcast_to_channel_inner(&clients, &ch, &ServerMsg::MessageEdited {
                            id: message_id, channel: ch.clone(), content, edited_at: now,
                        }, None);
                    }
                    Err(e) => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                        }
                    }
                }
            }

            ClientMsg::DeleteMessage { message_id } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                let info = match self.db.get_message_info(&message_id) {
                    Some(i) => i,
                    None => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Message not found"));
                        }
                        return;
                    }
                };
                let (_channel, author) = info;
                if author == username {
                    if !self.db.user_has_permission(&username, "delete_own_message") {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                        }
                        return;
                    }
                } else {
                    if !self.db.user_has_permission(&username, "delete_any_message") {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                        }
                        return;
                    }
                }

                match self.db.delete_message(&message_id) {
                    Ok((ch, _)) => {
                        Self::broadcast_to_channel_inner(&clients, &ch, &ServerMsg::MessageDeleted {
                            id: message_id, channel: ch.clone(),
                        }, None);
                    }
                    Err(e) => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                        }
                    }
                }
            }

            ClientMsg::EditTopic { topic_id, title, body } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                let info = match self.db.get_topic_author(&topic_id) {
                    Some(i) => i,
                    None => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Topic not found"));
                        }
                        return;
                    }
                };
                let (author, _channel) = info;
                if author != username {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Can only edit your own topics"));
                    }
                    return;
                }
                if !self.db.user_has_permission(&username, "edit_own_topic") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                match self.db.edit_topic(&topic_id, title.as_deref(), body.as_deref()) {
                    Ok(ch) => {
                        let now = Utc::now().to_rfc3339();
                        Self::broadcast_to_channel_inner(&clients, &ch, &ServerMsg::TopicEdited {
                            topic_id, channel: ch.clone(), title, body, edited_at: now,
                        }, None);
                    }
                    Err(e) => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                        }
                    }
                }
            }

            ClientMsg::DeleteTopic { topic_id } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                let info = match self.db.get_topic_author(&topic_id) {
                    Some(i) => i,
                    None => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Topic not found"));
                        }
                        return;
                    }
                };
                let (author, _channel) = info;
                if author == username {
                    if !self.db.user_has_permission(&username, "delete_own_topic") {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                        }
                        return;
                    }
                } else {
                    if !self.db.user_has_permission(&username, "delete_any_message") {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                        }
                        return;
                    }
                }

                match self.db.delete_topic(&topic_id) {
                    Ok(ch) => {
                        Self::broadcast_to_channel_inner(&clients, &ch, &ServerMsg::TopicDeleted {
                            topic_id, channel: ch.clone(),
                        }, None);
                    }
                    Err(e) => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                        }
                    }
                }
            }

            ClientMsg::EditTopicReply { reply_id, content } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                let info = match self.db.get_reply_author(&reply_id) {
                    Some(i) => i,
                    None => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Reply not found"));
                        }
                        return;
                    }
                };
                let (author, _topic_id) = info;
                if author != username {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Can only edit your own replies"));
                    }
                    return;
                }
                if !self.db.user_has_permission(&username, "edit_own_message") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                match self.db.edit_topic_reply(&reply_id, &content) {
                    Ok((topic_id, _)) => {
                        let now = Utc::now().to_rfc3339();
                        // Broadcast to the topic's channel
                        if let Some(topic) = self.db.get_topic(&topic_id) {
                            Self::broadcast_to_channel_inner(&clients, &topic.channel, &ServerMsg::TopicReplyEdited {
                                reply_id, topic_id, content, edited_at: now,
                            }, None);
                        }
                    }
                    Err(e) => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                        }
                    }
                }
            }

            ClientMsg::DeleteTopicReply { reply_id } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                let info = match self.db.get_reply_author(&reply_id) {
                    Some(i) => i,
                    None => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Reply not found"));
                        }
                        return;
                    }
                };
                let (author, _topic_id) = info;
                if author == username {
                    if !self.db.user_has_permission(&username, "delete_own_message") {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                        }
                        return;
                    }
                } else {
                    if !self.db.user_has_permission(&username, "delete_any_message") {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                        }
                        return;
                    }
                }

                match self.db.delete_topic_reply(&reply_id) {
                    Ok((topic_id, _)) => {
                        if let Some(topic) = self.db.get_topic(&topic_id) {
                            Self::broadcast_to_channel_inner(&clients, &topic.channel, &ServerMsg::TopicReplyDeleted {
                                reply_id, topic_id,
                            }, None);
                        }
                    }
                    Err(e) => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                        }
                    }
                }
            }

            // ── Admin: Channel deletion ─────────────────────────────

            ClientMsg::DeleteChannel { channel } => {
                let mut clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                if !self.db.user_has_permission(&username, "delete_channel") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied: delete_channel"));
                    }
                    return;
                }

                match self.db.delete_channel(&channel) {
                    Ok(()) => {
                        // Remove channel from all clients' channel sets
                        for client in clients.values_mut() {
                            client.channels.remove(&channel);
                        }
                        // Broadcast ChannelDeleted
                        Self::broadcast_all_inner(&clients, &ServerMsg::ChannelDeleted {
                            channel: channel.clone(),
                        }, None);
                        // Broadcast updated channel list
                        let ch_list = self.channel_list_inner(&clients);
                        Self::broadcast_all_inner(&clients, &ServerMsg::ChannelList { channels: ch_list }, None);
                    }
                    Err(e) => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                        }
                    }
                }
            }

            // ── Admin: Settings ─────────────────────────────────────

            ClientMsg::GetSettings => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                if !self.db.user_has_permission(&username, "manage_settings") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                let settings = self.db.get_settings();
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::Settings { settings });
                }
            }

            ClientMsg::UpdateSetting { key, value } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                if !self.db.user_has_permission(&username, "manage_settings") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                // Validate known keys/values
                let valid = match key.as_str() {
                    "registration_mode" => ["open", "closed", "invite"].contains(&value.as_str()),
                    "channel_creation" => ["all", "admin"].contains(&value.as_str()),
                    _ => false,
                };
                if !valid {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Invalid setting key or value"));
                    }
                    return;
                }

                if let Err(e) = self.db.set_setting(&key, &value) {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                    }
                    return;
                }

                let settings = self.db.get_settings();
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::Settings { settings });
                }
            }

            // ── Admin: Invites ──────────────────────────────────────

            ClientMsg::CreateInvite => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                if !self.db.user_has_permission(&username, "manage_invites") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                let code = self.db.create_invite(&username);
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::InviteCreated { code });
                }
            }

            ClientMsg::ListInvites => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                if !self.db.user_has_permission(&username, "manage_invites") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                let invites = self.db.list_invites();
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::InviteList { invites });
                }
            }

            // ── Admin: Roles ────────────────────────────────────────

            ClientMsg::ListRoles => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                if !self.db.user_has_permission(&username, "manage_roles") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                let roles = self.db.list_roles();
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::RoleList { roles });
                }
            }

            ClientMsg::CreateRole { name, permissions } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                if !self.db.user_has_permission(&username, "manage_roles") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                self.db.upsert_role(&name, &permissions);
                let roles = self.db.list_roles();
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::RoleList { roles });
                }
            }

            ClientMsg::UpdateRole { name, permissions } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                if !self.db.user_has_permission(&username, "manage_roles") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                self.db.upsert_role(&name, &permissions);
                let roles = self.db.list_roles();
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::RoleList { roles });
                }
            }

            ClientMsg::DeleteRole { name } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                if !self.db.user_has_permission(&username, "manage_roles") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                match self.db.delete_role(&name) {
                    Ok(()) => {
                        let roles = self.db.list_roles();
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::RoleList { roles });
                        }
                    }
                    Err(e) => {
                        if let Some(client) = clients.get(&id) {
                            let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                        }
                    }
                }
            }

            ClientMsg::AssignRole { username: target_user, role_name } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                if !self.db.user_has_permission(&username, "manage_roles") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                if let Err(e) = self.db.assign_role(&target_user, &role_name) {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                    }
                    return;
                }

                let roles = self.db.get_user_roles(&target_user);
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::UserRoles { username: target_user, roles });
                }
            }

            ClientMsg::RemoveRole { username: target_user, role_name } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                if !self.db.user_has_permission(&username, "manage_roles") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                if let Err(e) = self.db.remove_role(&target_user, &role_name) {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
                    }
                    return;
                }

                let roles = self.db.get_user_roles(&target_user);
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::UserRoles { username: target_user, roles });
                }
            }

            ClientMsg::GetUserRoles { username: target_user } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                if !self.db.user_has_permission(&username, "manage_roles") {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
                    }
                    return;
                }

                let roles = self.db.get_user_roles(&target_user);
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::UserRoles { username: target_user, roles });
                }
            }

            // ── E2E Encryption ─────────────────────────────────────

            ClientMsg::UploadPublicKey { public_key } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };
                self.db.store_public_key(&username, &public_key);
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::PublicKeyStored { username });
                }
            }

            ClientMsg::GetPublicKeys { usernames } => {
                let keys = self.db.get_public_keys(&usernames);
                let clients = self.clients.lock().await;
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::PublicKeys { keys });
                }
            }

            ClientMsg::CreateEncryptedChannel { channel, encrypted_channel_key } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                self.db.ensure_channel(&channel);
                self.db.set_channel_encrypted(&channel, &username);
                self.db.store_channel_key(&channel, &username, &encrypted_channel_key, 1);

                // Broadcast ChannelEncrypted
                Self::broadcast_all_inner(&clients, &ServerMsg::ChannelEncrypted {
                    channel: channel.clone(),
                }, None);

                // Update channel list for everyone
                let ch_list = self.channel_list_inner(&clients);
                Self::broadcast_all_inner(&clients, &ServerMsg::ChannelList { channels: ch_list }, None);
            }

            ClientMsg::RequestChannelKey { channel } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                // If we have a stored key for this user, send it directly
                if let Some((encrypted_key, key_version)) = self.db.get_channel_key(&channel, &username) {
                    if let Some(client) = clients.get(&id) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::ChannelKeyData {
                            channel, encrypted_key, key_version,
                        });
                    }
                } else if let Some(pub_key) = self.db.get_public_key(&username) {
                    // Broadcast request to online channel members
                    let req_msg = ServerMsg::ChannelKeyRequest {
                        channel: channel.clone(),
                        requesting_user: username,
                        public_key: pub_key,
                    };
                    Self::broadcast_to_channel_inner(&clients, &channel, &req_msg, Some(id));
                }
            }

            ClientMsg::ProvideChannelKey { channel, target_user, encrypted_key } => {
                let clients = self.clients.lock().await;
                let _username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                let key_version = self.db.get_channel_key_version(&channel);
                self.db.store_channel_key(&channel, &target_user, &encrypted_key, key_version);

                // Forward to target user if online
                for client in clients.values() {
                    if client.username == target_user {
                        let _ = Self::send_to(&client.tx, &ServerMsg::ChannelKeyData {
                            channel: channel.clone(),
                            encrypted_key: encrypted_key.clone(),
                            key_version,
                        });
                    }
                }
            }

            ClientMsg::RotateChannelKey { channel, new_keys } => {
                let clients = self.clients.lock().await;
                let _username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                let new_version = self.db.increment_channel_key_version(&channel);

                // Store all new sealed keys
                for (user, enc_key) in &new_keys {
                    self.db.store_channel_key(&channel, user, enc_key, new_version);
                }

                // Broadcast key rotation to channel
                Self::broadcast_to_channel_inner(&clients, &channel, &ServerMsg::ChannelKeyRotated {
                    channel: channel.clone(),
                    key_version: new_version,
                }, None);
            }
        }
    }

    // ── Internal helpers (take &HashMap to avoid deadlocks) ─────────

    fn send_to(tx: &mpsc::UnboundedSender<Message>, msg: &ServerMsg) -> Result<(), ()> {
        let json = serde_json::to_string(msg).map_err(|_| ())?;
        tx.send(Message::Text(json)).map_err(|_| ())
    }

    fn broadcast_to_channel_inner(
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
                let _ = client.tx.send(Message::Text(json.clone()));
            }
        }
    }

    fn broadcast_to_voice_channel_inner(
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
                let _ = client.tx.send(Message::Text(json.clone()));
            }
        }
    }

    fn broadcast_all_inner(
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
                let _ = client.tx.send(Message::Text(json.clone()));
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

    fn channel_list_inner(&self, clients: &HashMap<usize, Client>) -> Vec<ChannelInfo> {
        let db_channels = self.db.list_channels();
        db_channels
            .into_iter()
            .map(|name| {
                let user_count = clients
                    .values()
                    .filter(|c| c.channels.contains(&name))
                    .count();
                let encrypted = self.db.is_channel_encrypted(&name);
                ChannelInfo { name, user_count, encrypted }
            })
            .collect()
    }
}
