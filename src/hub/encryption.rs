use super::Hub;
use crate::protocol::ServerMsg;

impl Hub {
    pub(super) async fn handle_upload_public_key(&self, id: usize, public_key: String) {
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

    pub(super) async fn handle_get_public_keys(&self, id: usize, usernames: Vec<String>) {
        let keys = self.db.get_public_keys(&usernames);
        self.send_msg(id, &ServerMsg::PublicKeys { keys }).await;
    }

    pub(super) async fn handle_create_encrypted_channel(&self, id: usize, channel: String, encrypted_channel_key: String) {
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

        // Update channel list for everyone (per-user filtering)
        self.broadcast_channel_lists(&clients);
    }

    pub(super) async fn handle_request_channel_key(&self, id: usize, channel: String) {
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

    pub(super) async fn handle_provide_channel_key(&self, id: usize, channel: String, target_user: String, encrypted_key: String) {
        let clients = self.clients.lock().await;
        let (username, in_channel) = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => (c.username.clone(), c.channels.contains(&channel)),
            _ => return,
        };

        // S10: verify sender is a member of the channel
        if !in_channel {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Not a member of this channel"));
            }
            return;
        }
        let _ = username;

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

    pub(super) async fn handle_rotate_channel_key(&self, id: usize, channel: String, new_keys: std::collections::HashMap<String, String>) {
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
