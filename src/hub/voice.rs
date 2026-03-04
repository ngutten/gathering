use super::Hub;
use crate::protocol::ServerMsg;

impl Hub {
    pub(super) async fn handle_create_voice_channel(&self, id: usize, channel: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        // Check channel creation permission
        let creation_mode = self.db.get_setting("channel_creation").unwrap_or_else(|| "all".to_string());
        if creation_mode == "admin" && !self.db.user_has_permission(&username, "create_channel") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Only admins can create channels")) {
                    eprintln!("[hub::voice] send channel creation denied error failed: {e:?}");
                }
            }
            return;
        }

        if self.db.channel_exists(&channel) {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Channel already exists")) {
                    eprintln!("[hub::voice] send channel exists error failed: {e:?}");
                }
            }
            return;
        }

        self.db.create_channel_with_type(&channel, "voice");

        // Update channel list for everyone (per-user filtering)
        self.broadcast_channel_lists(&clients);
    }

    pub(super) async fn handle_voice_join(&self, id: usize, channel: String) {
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

        let old_vc = clients.get(&id).and_then(|c| c.voice_channel.clone());

        // Set new voice channel
        if let Some(client) = clients.get_mut(&id) {
            client.voice_channel = Some(channel.clone());
        }

        // Mark new channel as occupied
        self.db.mark_voice_channel_occupied(&channel);

        // Check if old voice channel is now empty
        if let Some(ref old_ch) = old_vc {
            let old_count = Self::voice_channel_user_count(&clients, old_ch);
            if old_count == 0 {
                self.db.mark_voice_channel_empty(old_ch);
            }
            Self::broadcast_voice_occupancy(&clients, old_ch);
        }

        // Collect current voice members for this channel
        let members: Vec<String> = Self::voice_channel_users(&clients, &channel);

        // Send VoiceMembers to the joiner
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::VoiceMembers {
                channel: channel.clone(),
                users: members,
            }) {
                eprintln!("[hub::voice] send voice members failed: {e:?}");
            }

            // Send video states of other users who have video/screen on
            let video_states: Vec<_> = clients.values()
                .filter(|c| c.voice_channel.as_deref() == Some(&channel) && c.username != client.username && (c.video_on || c.screen_share_on))
                .map(|c| ServerMsg::UserVideoState {
                    channel: channel.clone(),
                    username: c.username.clone(),
                    video_on: c.video_on,
                    screen_share_on: c.screen_share_on,
                })
                .collect();
            for vs in video_states {
                if let Err(e) = Self::send_to(&client.tx, &vs) {
                    eprintln!("[hub::voice] send video state failed: {e:?}");
                }
            }
        }

        // Broadcast VoiceUserJoined to others in the voice channel
        let join_msg = ServerMsg::VoiceUserJoined {
            channel: channel.clone(),
            username,
        };
        Self::broadcast_to_voice_channel_inner(&clients, &channel, &join_msg, Some(id));

        // Broadcast occupancy to all
        Self::broadcast_voice_occupancy(&clients, &channel);
    }

    pub(super) async fn handle_voice_leave(&self, id: usize, channel: String) {
        let mut clients = self.clients.lock().await;
        let username = match clients.get_mut(&id) {
            Some(c) if !c.username.is_empty() && c.voice_channel.as_deref() == Some(&channel) => {
                c.voice_channel = None;
                c.video_on = false;
                c.screen_share_on = false;
                c.username.clone()
            }
            _ => return,
        };

        let msg = ServerMsg::VoiceUserLeft {
            channel: channel.clone(),
            username,
        };
        Self::broadcast_to_voice_channel_inner(&clients, &channel, &msg, Some(id));

        // Check if voice channel is now empty
        let count = Self::voice_channel_user_count(&clients, &channel);
        if count == 0 {
            self.db.mark_voice_channel_empty(&channel);
        }
        Self::broadcast_voice_occupancy(&clients, &channel);
    }

    pub(super) async fn handle_voice_signal(&self, id: usize, target_user: String, signal_data: serde_json::Value) {
        let clients = self.clients.lock().await;
        let from_user = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        // Find target user and relay
        for client in clients.values() {
            if client.username == target_user {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::VoiceSignal {
                    from_user: from_user.clone(),
                    signal_data: signal_data.clone(),
                }) {
                    eprintln!("[hub::voice] relay voice signal to target failed: {e:?}");
                }
            }
        }
    }

    pub(super) async fn handle_video_state_change(&self, id: usize, channel: String, video_on: bool, screen_share_on: bool) {
        let mut clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() && c.voice_channel.as_deref() == Some(&channel) => c.username.clone(),
            _ => return,
        };
        if let Some(client) = clients.get_mut(&id) {
            client.video_on = video_on;
            client.screen_share_on = screen_share_on;
        }
        let msg = ServerMsg::UserVideoState {
            channel: channel.clone(),
            username,
            video_on,
            screen_share_on,
        };
        Self::broadcast_to_voice_channel_inner(&clients, &channel, &msg, None);
    }
}
