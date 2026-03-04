use super::Hub;
use crate::protocol::ServerMsg;

const DEFAULT_HISTORY_LIMIT: u32 = 100;

impl Hub {
    pub(super) async fn handle_start_dm(&self, id: usize, target_user: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        drop(clients);

        if target_user == username {
            self.send_error(id, "Cannot DM yourself").await;
            return;
        }

        // Compute canonical DM channel name
        let mut names = [username.clone(), target_user.clone()];
        names.sort();
        let dm_channel = format!("dm:{}:{}", names[0], names[1]);

        let channel_exists = self.db.channel_exists(&dm_channel);

        if !channel_exists {
            // Create channel
            self.db.ensure_channel(&dm_channel);
            // Mark as encrypted
            self.db.set_channel_encrypted(&dm_channel, &username);
            // Add both users as DM members
            self.db.add_dm_member(&dm_channel, &username);
            self.db.add_dm_member(&dm_channel, &target_user);
        }

        // Auto-join the requester to the DM channel
        let mut clients = self.clients.lock().await;
        if let Some(c) = clients.get_mut(&id) {
            c.channels.insert(dm_channel.clone());
        }

        // Send history to requester
        let history = self.db.get_history(&dm_channel, DEFAULT_HISTORY_LIMIT);
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::History {
                channel: dm_channel.clone(),
                messages: history,
            }) {
                eprintln!("[hub::dms] send DM history to requester failed: {e:?}");
            }
        }

        // If channel is encrypted, deliver channel key or request it
        if self.db.is_channel_encrypted(&dm_channel) {
            if let Some((encrypted_key, key_version)) = self.db.get_channel_key(&dm_channel, &username) {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::ChannelKeyData {
                        channel: dm_channel.clone(),
                        encrypted_key,
                        key_version,
                    }) {
                        eprintln!("[hub::dms] send DM channel key to requester failed: {e:?}");
                    }
                }
            }
        }

        // Send DMStarted to requester (initiated=true only for NEW channels so they generate the key)
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::DMStarted {
                channel: dm_channel.clone(),
                other_user: target_user.clone(),
                initiated: !channel_exists,
            }) {
                eprintln!("[hub::dms] send DMStarted to requester failed: {e:?}");
            }
        }

        // If target is online, auto-join them and notify
        let target_ids: Vec<usize> = clients.iter()
            .filter(|(_, c)| c.username == target_user)
            .map(|(cid, _)| *cid)
            .collect();
        for tid in &target_ids {
            if let Some(c) = clients.get_mut(tid) {
                c.channels.insert(dm_channel.clone());
            }
        }
        for tid in &target_ids {
            if let Some(client) = clients.get(tid) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::DMStarted {
                    channel: dm_channel.clone(),
                    other_user: username.clone(),
                    initiated: false,
                }) {
                    eprintln!("[hub::dms] send DMStarted to target failed: {e:?}");
                }
                // Send history to target
                let history = self.db.get_history(&dm_channel, DEFAULT_HISTORY_LIMIT);
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::History {
                    channel: dm_channel.clone(),
                    messages: history,
                }) {
                    eprintln!("[hub::dms] send DM history to target failed: {e:?}");
                }
                // Send channel key if available
                if let Some((encrypted_key, key_version)) = self.db.get_channel_key(&dm_channel, &target_user) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::ChannelKeyData {
                        channel: dm_channel.clone(),
                        encrypted_key,
                        key_version,
                    }) {
                        eprintln!("[hub::dms] send DM channel key to target failed: {e:?}");
                    }
                }
            }
        }
    }

    pub(super) async fn handle_list_dms(&self, id: usize) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        let dms = self.db.list_user_dms(&username);
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::DMList { dms }) {
                eprintln!("[hub::dms] send DM list failed: {e:?}");
            }
        }
    }
}
