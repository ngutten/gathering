use chrono::Utc;

use super::Hub;
use crate::protocol::ServerMsg;

impl Hub {
    pub(super) async fn handle_edit_message(&self, id: usize, message_id: String, content: String) {
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
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Message not found")) {
                        eprintln!("[hub::messages] send message not found error failed: {e:?}");
                    }
                }
                return;
            }
        };
        let (ref msg_channel, ref author) = info;
        // Anonymous channels: always reject edits
        if self.db.is_channel_anonymous(msg_channel) {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Cannot edit messages in anonymous channels"));
            }
            return;
        }
        if *author != username {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Can only edit your own messages")) {
                    eprintln!("[hub::messages] send edit ownership error failed: {e:?}");
                }
            }
            return;
        }
        if !self.db.user_has_permission(&username, "edit_own_message") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::messages] send permission denied error failed: {e:?}");
                }
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
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                        eprintln!("[hub::messages] send edit_message error failed: {e:?}");
                    }
                }
            }
        }
    }

    pub(super) async fn handle_delete_message(&self, id: usize, message_id: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        let info = match self.db.get_message_info(&message_id) {
            Some(i) => i,
            None => {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Message not found")) {
                        eprintln!("[hub::messages] send message not found error failed: {e:?}");
                    }
                }
                return;
            }
        };
        let (ref msg_channel, ref author) = info;
        // Anonymous channels: only admin with delete_any_message can delete
        if self.db.is_channel_anonymous(msg_channel) {
            if !self.db.user_has_permission(&username, "delete_any_message") {
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::error("Cannot delete messages in anonymous channels (admin only)"));
                }
                return;
            }
        } else if *author == username {
            if !self.db.user_has_permission(&username, "delete_own_message") {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                        eprintln!("[hub::messages] send permission denied error failed: {e:?}");
                    }
                }
                return;
            }
        } else {
            if !self.db.user_has_permission(&username, "delete_any_message") {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                        eprintln!("[hub::messages] send permission denied error failed: {e:?}");
                    }
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
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                        eprintln!("[hub::messages] send delete_message error failed: {e:?}");
                    }
                }
            }
        }
    }
}
