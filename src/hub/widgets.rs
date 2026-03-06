use super::Hub;
use crate::protocol::ServerMsg;

const MAX_WIDGET_ID_LEN: usize = 64;
const MAX_WIDGET_ACTION_LEN: usize = 128;
const MAX_WIDGET_DATA_SIZE: usize = 64 * 1024; // 64KB
const MAX_WIDGET_STATE_SIZE: usize = 512 * 1024; // 512KB for persisted state

impl Hub {
    pub(super) async fn handle_widget_message(
        &self,
        id: usize,
        channel: String,
        widget_id: String,
        action: String,
        data: serde_json::Value,
    ) {
        // Input validation
        if widget_id.len() > MAX_WIDGET_ID_LEN {
            self.send_error(id, "Widget ID too long").await;
            return;
        }
        if action.len() > MAX_WIDGET_ACTION_LEN {
            self.send_error(id, "Widget action too long").await;
            return;
        }
        if serde_json::to_string(&data).map_or(true, |s| s.len() > MAX_WIDGET_DATA_SIZE) {
            self.send_error(id, "Widget data too large (max 64KB)").await;
            return;
        }

        // Widgets disabled on encrypted channels (data leak risk)
        if self.db.is_channel_encrypted(&channel) {
            self.send_error(id, "Widgets are not supported on encrypted channels").await;
            return;
        }

        let clients = self.clients.lock().await;
        let (username, in_channel) = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => (c.username.clone(), c.channels.contains(&channel)),
            _ => return,
        };

        if !in_channel {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Not a member of this channel"));
            }
            return;
        }

        // Broadcast to all channel members (including sender)
        let broadcast = ServerMsg::WidgetBroadcast {
            channel: channel.clone(),
            widget_id,
            from_user: username,
            action,
            data,
        };
        Self::broadcast_to_channel_inner(&clients, &channel, &broadcast, None);
    }

    pub(super) async fn handle_save_widget_state(
        &self,
        id: usize,
        channel: String,
        widget_id: String,
        state: serde_json::Value,
    ) {
        if widget_id.len() > MAX_WIDGET_ID_LEN {
            self.send_error(id, "Widget ID too long").await;
            return;
        }

        if self.db.is_channel_encrypted(&channel) {
            self.send_error(id, "Widgets are not supported on encrypted channels").await;
            return;
        }

        let state_json = match serde_json::to_string(&state) {
            Ok(s) if s.len() <= MAX_WIDGET_STATE_SIZE => s,
            Ok(_) => {
                self.send_error(id, "Widget state too large (max 512KB)").await;
                return;
            }
            Err(_) => return,
        };

        let clients = self.clients.lock().await;
        let (username, in_channel) = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => (c.username.clone(), c.channels.contains(&channel)),
            _ => return,
        };
        drop(clients);

        if !in_channel {
            self.send_error(id, "Not a member of this channel").await;
            return;
        }

        self.db.save_widget_state(&channel, &widget_id, &state_json, &username);
        self.send_msg(id, &ServerMsg::WidgetStateSaved {
            channel,
            widget_id,
        }).await;
    }

    pub(super) async fn handle_load_widget_state(
        &self,
        id: usize,
        channel: String,
        widget_id: String,
    ) {
        if widget_id.len() > MAX_WIDGET_ID_LEN {
            self.send_error(id, "Widget ID too long").await;
            return;
        }

        if self.db.is_channel_encrypted(&channel) {
            self.send_error(id, "Widgets are not supported on encrypted channels").await;
            return;
        }

        let clients = self.clients.lock().await;
        let in_channel = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.channels.contains(&channel),
            _ => return,
        };
        drop(clients);

        if !in_channel {
            self.send_error(id, "Not a member of this channel").await;
            return;
        }

        let state = self.db.load_widget_state(&channel, &widget_id)
            .and_then(|s| serde_json::from_str(&s).ok());

        self.send_msg(id, &ServerMsg::WidgetStateLoaded {
            channel,
            widget_id,
            state,
        }).await;
    }
}
