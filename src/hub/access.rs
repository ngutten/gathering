use super::Hub;
use crate::protocol::ServerMsg;

impl Hub {
    pub(super) async fn handle_set_channel_restricted(&self, id: usize, channel: String, restricted: bool) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        // Only channel creator or admin can change restriction
        let is_creator = self.db.get_channel_creator(&channel).as_deref() == Some(&username);
        let is_admin = self.db.user_has_permission(&username, "manage_settings");
        if !is_creator && !is_admin {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Only the channel creator or an admin can change channel restrictions"));
            }
            return;
        }

        self.db.set_channel_restricted(&channel, restricted);
        if restricted {
            // When restricting, auto-add all currently joined users as members
            for client in clients.values() {
                if client.channels.contains(&channel) && !client.username.is_empty() {
                    self.db.add_channel_member(&channel, &client.username);
                }
            }
            // Also add the creator
            self.db.add_channel_member(&channel, &username);
        }

        // Broadcast restriction change to channel members
        Self::broadcast_to_channel_inner(&clients, &channel, &ServerMsg::ChannelRestricted {
            channel: channel.clone(),
            restricted,
        }, None);

        // Update channel lists for everyone (restricted channels may appear/disappear)
        self.broadcast_channel_lists(&clients);
    }

    pub(super) async fn handle_add_channel_member(&self, id: usize, channel: String, target_user: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        let is_creator = self.db.get_channel_creator(&channel).as_deref() == Some(&username);
        let is_admin = self.db.user_has_permission(&username, "manage_settings");
        if !is_creator && !is_admin {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Only the channel creator or an admin can manage members"));
            }
            return;
        }

        self.db.add_channel_member(&channel, &target_user);

        // Notify channel members
        Self::broadcast_to_channel_inner(&clients, &channel, &ServerMsg::ChannelMemberAdded {
            channel: channel.clone(),
            username: target_user.clone(),
        }, None);

        // Update channel lists so the new member can see the channel
        self.broadcast_channel_lists(&clients);
    }

    pub(super) async fn handle_remove_channel_member(&self, id: usize, channel: String, target_user: String) {
        let mut clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        let is_creator = self.db.get_channel_creator(&channel).as_deref() == Some(&username);
        let is_admin = self.db.user_has_permission(&username, "manage_settings");
        if !is_creator && !is_admin {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Only the channel creator or an admin can manage members"));
            }
            return;
        }

        self.db.remove_channel_member(&channel, &target_user);

        // Remove target from channel in their session
        for client in clients.values_mut() {
            if client.username == target_user {
                client.channels.remove(&channel);
            }
        }

        // Notify channel members
        Self::broadcast_to_channel_inner(&clients, &channel, &ServerMsg::ChannelMemberRemoved {
            channel: channel.clone(),
            username: target_user.clone(),
        }, None);

        // Update channel lists
        self.broadcast_channel_lists(&clients);
    }

    pub(super) async fn handle_get_channel_members(&self, id: usize, channel: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        if !self.db.can_access_channel(&channel, &username) {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Access denied"));
            }
            return;
        }

        let members = self.db.get_channel_members(&channel);
        let restricted = self.db.is_channel_restricted(&channel);
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::ChannelMemberList {
                channel, members, restricted,
            });
        }
    }
}
