use super::Hub;
use crate::protocol::ServerMsg;

const MAX_WIDGET_ID_LEN: usize = 64;
const MAX_WIDGET_ACTION_LEN: usize = 128;
const MAX_WIDGET_DATA_SIZE: usize = 64 * 1024; // 64KB

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
}
