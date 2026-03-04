use super::Hub;
use crate::protocol::ServerMsg;

impl Hub {
    pub(super) async fn handle_delete_channel(&self, id: usize, channel: String) {
        let mut clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        if !self.db.user_has_permission(&username, "delete_channel") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied: delete_channel")) {
                    eprintln!("[hub::admin] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        match self.db.delete_channel(&channel) {
            Ok(()) => {
                // Remove channel from all clients' channel sets
                for client in clients.values_mut() {
                    client.channels.remove(&channel);
                }
                // Broadcast ChannelDeleted
                Self::broadcast_all_inner(&clients, &ServerMsg::ChannelDeleted {
                    channel: channel.clone(),
                }, None);
                // Broadcast updated channel list (per-user filtering)
                self.broadcast_channel_lists(&clients);
            }
            Err(e) => {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                        eprintln!("[hub::admin] send delete_channel error failed: {e:?}");
                    }
                }
            }
        }
    }

    pub(super) async fn handle_get_settings(&self, id: usize) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        if !self.db.user_has_permission(&username, "manage_settings") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::admin] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        let settings = self.db.get_settings();
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::Settings { settings }) {
                eprintln!("[hub::admin] send settings failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_update_setting(&self, id: usize, key: String, value: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        if !self.db.user_has_permission(&username, "manage_settings") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::admin] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        // Validate known keys/values
        let valid = match key.as_str() {
            "registration_mode" => ["open", "closed", "invite"].contains(&value.as_str()),
            "channel_creation" => ["all", "admin"].contains(&value.as_str()),
            _ => false,
        };
        if !valid {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Invalid setting key or value")) {
                    eprintln!("[hub::admin] send invalid setting error failed: {e:?}");
                }
            }
            return;
        }

        if let Err(e) = self.db.set_setting(&key, &value) {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                    eprintln!("[hub::admin] send set_setting error failed: {e:?}");
                }
            }
            return;
        }

        let settings = self.db.get_settings();
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::Settings { settings }) {
                eprintln!("[hub::admin] send updated settings failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_create_invite(&self, id: usize) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        if !self.db.user_has_permission(&username, "manage_invites") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::admin] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        let code = self.db.create_invite(&username);
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::InviteCreated { code }) {
                eprintln!("[hub::admin] send invite created failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_list_invites(&self, id: usize) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        if !self.db.user_has_permission(&username, "manage_invites") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::admin] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        let invites = self.db.list_invites();
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::InviteList { invites }) {
                eprintln!("[hub::admin] send invite list failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_list_roles(&self, id: usize) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        if !self.db.user_has_permission(&username, "manage_roles") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::admin] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        let roles = self.db.list_roles();
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::RoleList { roles }) {
                eprintln!("[hub::admin] send role list failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_create_role(&self, id: usize, name: String, permissions: Vec<String>) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        if !self.db.user_has_permission(&username, "manage_roles") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::admin] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        self.db.upsert_role(&name, &permissions);
        let roles = self.db.list_roles();
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::RoleList { roles }) {
                eprintln!("[hub::admin] send role list after create failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_update_role(&self, id: usize, name: String, permissions: Vec<String>) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        if !self.db.user_has_permission(&username, "manage_roles") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::admin] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        self.db.upsert_role(&name, &permissions);
        let roles = self.db.list_roles();
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::RoleList { roles }) {
                eprintln!("[hub::admin] send role list after update failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_delete_role(&self, id: usize, name: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        if !self.db.user_has_permission(&username, "manage_roles") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::admin] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        match self.db.delete_role(&name) {
            Ok(()) => {
                let roles = self.db.list_roles();
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::RoleList { roles }) {
                        eprintln!("[hub::admin] send role list after delete failed: {e:?}");
                    }
                }
            }
            Err(e) => {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                        eprintln!("[hub::admin] send delete_role error failed: {e:?}");
                    }
                }
            }
        }
    }

    pub(super) async fn handle_assign_role(&self, id: usize, target_user: String, role_name: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        if !self.db.user_has_permission(&username, "manage_roles") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::admin] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        if let Err(e) = self.db.assign_role(&target_user, &role_name) {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                    eprintln!("[hub::admin] send assign_role error failed: {e:?}");
                }
            }
            return;
        }

        let roles = self.db.get_user_roles(&target_user);
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::UserRoles { username: target_user, roles }) {
                eprintln!("[hub::admin] send user roles failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_remove_role(&self, id: usize, target_user: String, role_name: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        if !self.db.user_has_permission(&username, "manage_roles") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::admin] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        if let Err(e) = self.db.remove_role(&target_user, &role_name) {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                    eprintln!("[hub::admin] send remove_role error failed: {e:?}");
                }
            }
            return;
        }

        let roles = self.db.get_user_roles(&target_user);
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::UserRoles { username: target_user, roles }) {
                eprintln!("[hub::admin] send user roles failed: {e:?}");
            }
        }
    }

    pub(super) async fn handle_get_user_roles(&self, id: usize, target_user: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        if !self.db.user_has_permission(&username, "manage_roles") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::admin] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        let roles = self.db.get_user_roles(&target_user);
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::UserRoles { username: target_user, roles }) {
                eprintln!("[hub::admin] send user roles failed: {e:?}");
            }
        }
    }
}
