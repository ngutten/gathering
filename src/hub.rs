use axum::extract::ws::Message;
use chrono::{Duration, Utc};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{Mutex, mpsc};

use crate::db::Db;
use crate::protocol::{ChannelInfo, ClientMsg, ServerMsg};

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
                        Ok(ref u) => ServerMsg::AuthResult {
                            ok: true,
                            username: Some(u.clone()),
                            error: None,
                        },
                        Err(ref e) => ServerMsg::AuthResult {
                            ok: false,
                            username: None,
                            error: Some(e.clone()),
                        },
                    };
                    let _ = Self::send_to(&client.tx, &resp);
                }
            }

            ClientMsg::Send { channel, content, ttl_secs } => {
                let clients = self.clients.lock().await;
                let username = match clients.get(&id) {
                    Some(c) if !c.username.is_empty() => c.username.clone(),
                    _ => return,
                };

                let expires_at = ttl_secs.map(|s| Utc::now() + Duration::seconds(s as i64));
                let msg = ServerMsg::message(&channel, &username, &content, expires_at);

                // Store in database
                if let ServerMsg::Message {
                    ref id, ref timestamp, ref expires_at, ..
                } = msg
                {
                    self.db.store_message(
                        id, &channel, &username, &content,
                        timestamp, expires_at.as_ref(),
                    );
                }

                // Broadcast to everyone in the channel
                Self::broadcast_to_channel_inner(&clients, &channel, &msg, None);
            }

            ClientMsg::Join { channel } => {
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
                ChannelInfo { name, user_count }
            })
            .collect()
    }
}
