use crate::protocol::ServerMsg;

use super::Hub;

const MAX_STATUS_LEN: usize = 128;
const MAX_ABOUT_LEN: usize = 1024;

impl Hub {
    pub(super) async fn handle_get_profile(&self, id: usize, target_user: String) {
        let profile = self.db.get_profile(&target_user);
        self.send_msg(id, &ServerMsg::UserProfile {
            username: target_user,
            profile,
        }).await;
    }

    pub(super) async fn handle_get_profiles(&self, id: usize, usernames: Vec<String>) {
        let clamped: Vec<String> = usernames.into_iter().take(100).collect();
        let profiles = self.db.get_profiles_bulk(&clamped);
        self.send_msg(id, &ServerMsg::UserProfiles { profiles }).await;
    }

    pub(super) async fn handle_update_profile(&self, id: usize, field: String, value: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        drop(clients);

        // Validate field and value
        match field.as_str() {
            "status" if value.len() > MAX_STATUS_LEN => {
                self.send_error(id, &format!("Status must be {} characters or fewer", MAX_STATUS_LEN)).await;
                return;
            }
            "about" if value.len() > MAX_ABOUT_LEN => {
                self.send_error(id, &format!("About must be {} characters or fewer", MAX_ABOUT_LEN)).await;
                return;
            }
            "avatar_id" => {
                // Validate the file exists and belongs to this user
                if !value.is_empty() {
                    if let Some(info) = self.db.get_file_owner(&value) {
                        if info != username {
                            self.send_error(id, "You can only use your own uploaded files as avatar").await;
                            return;
                        }
                    } else {
                        self.send_error(id, "File not found").await;
                        return;
                    }
                }
            }
            "status" | "about" => {}
            _ => {
                self.send_error(id, "Invalid profile field").await;
                return;
            }
        }

        if let Err(e) = self.db.set_profile_field(&username, &field, &value) {
            self.send_error(id, &e).await;
            return;
        }

        // Broadcast profile update to all authenticated clients
        let clients = self.clients.lock().await;
        let msg = ServerMsg::ProfileUpdated {
            username: username.clone(),
            field,
            value,
        };
        Self::broadcast_all_inner(&clients, &msg, None);
    }
}
