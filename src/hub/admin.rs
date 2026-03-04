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
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied: delete_channel"));
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
                    let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
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
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
            }
            return;
        }

        let settings = self.db.get_settings();
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::Settings { settings });
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
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
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
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Invalid setting key or value"));
            }
            return;
        }

        if let Err(e) = self.db.set_setting(&key, &value) {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
            }
            return;
        }

        let settings = self.db.get_settings();
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::Settings { settings });
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
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
            }
            return;
        }

        let code = self.db.create_invite(&username);
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::InviteCreated { code });
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
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
            }
            return;
        }

        let invites = self.db.list_invites();
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::InviteList { invites });
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
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
            }
            return;
        }

        let roles = self.db.list_roles();
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::RoleList { roles });
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
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
            }
            return;
        }

        self.db.upsert_role(&name, &permissions);
        let roles = self.db.list_roles();
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::RoleList { roles });
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
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
            }
            return;
        }

        self.db.upsert_role(&name, &permissions);
        let roles = self.db.list_roles();
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::RoleList { roles });
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
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
            }
            return;
        }

        match self.db.delete_role(&name) {
            Ok(()) => {
                let roles = self.db.list_roles();
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::RoleList { roles });
                }
            }
            Err(e) => {
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
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
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
            }
            return;
        }

        if let Err(e) = self.db.assign_role(&target_user, &role_name) {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
            }
            return;
        }

        let roles = self.db.get_user_roles(&target_user);
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::UserRoles { username: target_user, roles });
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
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
            }
            return;
        }

        if let Err(e) = self.db.remove_role(&target_user, &role_name) {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
            }
            return;
        }

        let roles = self.db.get_user_roles(&target_user);
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::UserRoles { username: target_user, roles });
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
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Permission denied"));
            }
            return;
        }

        let roles = self.db.get_user_roles(&target_user);
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::UserRoles { username: target_user, roles });
        }
    }
}
