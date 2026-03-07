use super::Hub;
use crate::protocol::ServerMsg;

const MAX_KEY_LEN: usize = 4096;
const MAX_ROTATE_KEYS: usize = 200;

impl Hub {
    pub(super) async fn handle_upload_public_key(&self, id: usize, public_key: String) {
        if public_key.len() > MAX_KEY_LEN {
            self.send_error(id, "Public key too large").await;
            return;
        }
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        self.db.store_public_key(&username, &public_key);
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::PublicKeyStored { username }) {
                eprintln!("[hub::encryption] send public key stored confirmation failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_get_public_keys(&self, id: usize, usernames: Vec<String>) {
        // Limit to prevent abuse (100 keys at a time is plenty)
        let capped: Vec<String> = usernames.into_iter().take(100).collect();
        let keys = self.db.get_public_keys(&capped);
        self.send_msg(id, &ServerMsg::PublicKeys { keys }).await;
    }

    pub(super) async fn handle_create_encrypted_channel(&self, id: usize, channel: String, encrypted_channel_key: String) {
        if encrypted_channel_key.len() > MAX_KEY_LEN {
            self.send_error(id, "Encrypted key too large").await;
            return;
        }
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
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::ChannelKeyData {
                    channel, encrypted_key, key_version,
                }) {
                    eprintln!("[hub::encryption] send channel key data failed: {e:?}");
                }
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
        if encrypted_key.len() > MAX_KEY_LEN {
            self.send_error(id, "Encrypted key too large").await;
            return;
        }
        let clients = self.clients.lock().await;
        let (username, in_channel) = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => (c.username.clone(), c.channels.contains(&channel)),
            _ => return,
        };

        // S10: verify sender is a member of the channel
        if !in_channel {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Not a member of this channel")) {
                    eprintln!("[hub::encryption] send membership error failed: {e:?}");
                }
            }
            return;
        }
        let _ = username;

        let key_version = self.db.get_channel_key_version(&channel);
        self.db.store_channel_key(&channel, &target_user, &encrypted_key, key_version);

        // Forward to target user if online
        for client in clients.values() {
            if client.username == target_user {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::ChannelKeyData {
                    channel: channel.clone(),
                    encrypted_key: encrypted_key.clone(),
                    key_version,
                }) {
                    eprintln!("[hub::encryption] forward channel key to target failed: {e:?}");
                }
            }
        }
    }

    pub(super) async fn handle_set_key_backup(&self, id: usize, encrypted_key: String, salt: String, nonce: String, ops_limit: u32, mem_limit: u32) {
        // Validate sizes
        if encrypted_key.len() > 1024 || salt.len() > 1024 || nonce.len() > 1024 {
            self.send_error(id, "Key backup field too large").await;
            return;
        }
        if ops_limit < 1 || ops_limit > 20 {
            self.send_error(id, "ops_limit out of range (1-20)").await;
            return;
        }
        if mem_limit < 8_388_608 || mem_limit > 1_073_741_824 {
            self.send_error(id, "mem_limit out of range (8MB-1GB)").await;
            return;
        }
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        self.db.store_key_backup(&username, &encrypted_key, &salt, &nonce, ops_limit, mem_limit);
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::KeyBackupStored) {
                eprintln!("[hub::encryption] send key backup stored failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_get_key_backup(&self, id: usize) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        let msg = if let Some((encrypted_key, salt, nonce, ops_limit, mem_limit)) = self.db.get_key_backup(&username) {
            ServerMsg::KeyBackupData { encrypted_key, salt, nonce, ops_limit, mem_limit }
        } else {
            ServerMsg::NoKeyBackup
        };
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &msg) {
                eprintln!("[hub::encryption] send key backup data failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_delete_key_backup(&self, id: usize) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        self.db.delete_key_backup(&username);
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::KeyBackupDeleted) {
                eprintln!("[hub::encryption] send key backup deleted failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_rotate_channel_key(&self, id: usize, channel: String, new_keys: std::collections::HashMap<String, String>) {
        if new_keys.len() > MAX_ROTATE_KEYS || new_keys.values().any(|k| k.len() > MAX_KEY_LEN) {
            self.send_error(id, "Key rotation payload too large").await;
            return;
        }
        let clients = self.clients.lock().await;
        let (username, in_channel) = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => (c.username.clone(), c.channels.contains(&channel)),
            _ => return,
        };

        // Must be a member of the channel to rotate keys
        if !in_channel {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Not a member of this channel"));
            }
            return;
        }
        let _ = username;

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
