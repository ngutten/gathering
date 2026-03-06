use super::Hub;
use crate::protocol::ServerMsg;

const MAX_EMOJI_LEN: usize = 32;
const MAX_REACTIONS_PER_MESSAGE: usize = 20;

impl Hub {
    pub(super) async fn handle_add_reaction(&self, id: usize, message_id: String, emoji: String) {
        if emoji.is_empty() || emoji.len() > MAX_EMOJI_LEN {
            self.send_error(id, "Invalid emoji").await;
            return;
        }

        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        drop(clients);

        // Check the message exists and get its channel
        let (channel, _author) = match self.db.get_message_info(&message_id) {
            Some(info) => info,
            None => { self.send_error(id, "Message not found").await; return; }
        };

        // Reactions disabled on encrypted channels (metadata leak)
        if self.db.is_channel_encrypted(&channel) {
            self.send_error(id, "Reactions are not supported on encrypted channels").await;
            return;
        }

        // Check channel membership
        let clients = self.clients.lock().await;
        let in_channel = clients.get(&id).map_or(false, |c| c.channels.contains(&channel));
        if !in_channel {
            drop(clients);
            self.send_error(id, "Not a member of this channel").await;
            return;
        }

        // Check reaction limit
        let existing = self.db.get_reactions_batch(&[message_id.clone()]);
        if let Some(msg_reactions) = existing.get(&message_id) {
            let unique_emoji: usize = msg_reactions.len();
            if unique_emoji >= MAX_REACTIONS_PER_MESSAGE && !msg_reactions.contains_key(&emoji) {
                drop(clients);
                self.send_error(id, "Too many different reactions on this message").await;
                return;
            }
        }

        if let Err(e) = self.db.add_reaction(&message_id, &username, &emoji) {
            drop(clients);
            self.send_error(id, &format!("Failed to add reaction: {e}")).await;
            return;
        }

        let msg = ServerMsg::ReactionUpdated {
            message_id,
            channel: channel.clone(),
            emoji,
            username,
            added: true,
        };
        Self::broadcast_to_channel_inner(&clients, &channel, &msg, None);
    }

    pub(super) async fn handle_remove_reaction(&self, id: usize, message_id: String, emoji: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        drop(clients);

        let (channel, _author) = match self.db.get_message_info(&message_id) {
            Some(info) => info,
            None => { self.send_error(id, "Message not found").await; return; }
        };

        if self.db.is_channel_encrypted(&channel) {
            self.send_error(id, "Reactions are not supported on encrypted channels").await;
            return;
        }

        if let Err(e) = self.db.remove_reaction(&message_id, &username, &emoji) {
            self.send_error(id, &format!("Failed to remove reaction: {e}")).await;
            return;
        }

        let clients = self.clients.lock().await;
        let msg = ServerMsg::ReactionUpdated {
            message_id,
            channel: channel.clone(),
            emoji,
            username,
            added: false,
        };
        Self::broadcast_to_channel_inner(&clients, &channel, &msg, None);
    }

    pub(super) async fn handle_pin_message(&self, id: usize, message_id: String, pinned: bool) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        drop(clients);

        // Only admins and channel creators can pin
        let (channel, _author) = match self.db.get_message_info(&message_id) {
            Some(info) => info,
            None => { self.send_error(id, "Message not found").await; return; }
        };

        let is_admin = self.db.user_has_permission(&username, "pin_message");
        let is_creator = self.db.get_channel_creator(&channel).as_deref() == Some(&username);
        if !is_admin && !is_creator {
            self.send_error(id, "Permission denied: only admins or channel creator can pin messages").await;
            return;
        }

        if let Err(e) = self.db.pin_message(&message_id, pinned) {
            self.send_error(id, &format!("Failed to pin message: {e}")).await;
            return;
        }

        let clients = self.clients.lock().await;
        let msg = ServerMsg::MessagePinned {
            message_id,
            channel: channel.clone(),
            pinned,
            pinned_by: username,
        };
        Self::broadcast_to_channel_inner(&clients, &channel, &msg, None);
    }

    pub(super) async fn handle_get_pinned_messages(&self, id: usize, channel: String) {
        let clients = self.clients.lock().await;
        let in_channel = clients.get(&id).map_or(false, |c| c.channels.contains(&channel));
        if !in_channel {
            drop(clients);
            self.send_error(id, "Not a member of this channel").await;
            return;
        }
        drop(clients);

        let mut messages = self.db.get_pinned_messages(&channel);

        // Attach reactions to pinned messages
        let msg_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
        if !msg_ids.is_empty() {
            let reactions_map = self.db.get_reactions_batch(&msg_ids);
            for msg in &mut messages {
                if let Some(reactions) = reactions_map.get(&msg.id) {
                    let btree: std::collections::BTreeMap<String, Vec<String>> = reactions.iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    msg.reactions = Some(btree);
                }
            }
        }

        self.send_msg(id, &ServerMsg::PinnedMessages { channel, messages }).await;
    }
}
