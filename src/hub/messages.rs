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
}
