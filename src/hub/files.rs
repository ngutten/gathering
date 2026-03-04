use super::Hub;
use crate::protocol::ServerMsg;

impl Hub {
    pub(super) async fn handle_search_messages(&self, id: usize, query: String, channel: Option<String>) {
        let clients = self.clients.lock().await;
        let _username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        let results = self.db.search_messages(&query, channel.as_deref(), 50);
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::SearchResults { query, results });
        }
    }

    pub(super) async fn handle_list_my_files(&self, id: usize) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        let files = self.db.list_user_files(&username);
        let used_bytes = self.db.get_user_disk_usage(&username);
        let quota_bytes = self.db.get_user_quota(&username);
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::MyFileList { files, used_bytes, quota_bytes });
        }
    }

    pub(super) async fn handle_set_file_pinned(&self, id: usize, file_id: String, pinned: bool) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        // Verify ownership
        match self.db.get_file_owner(&file_id) {
            Some(owner) if owner == username => {}
            _ => {
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::error("File not found or not owned by you"));
                }
                return;
            }
        }
        if let Err(e) = self.db.set_file_pinned(&file_id, pinned) {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error(e));
            }
            return;
        }
        if let Some(client) = clients.get(&id) {
            let _ = Self::send_to(&client.tx, &ServerMsg::FilePinned { file_id, pinned });
        }
    }

    pub(super) async fn handle_delete_file(&self, id: usize, file_id: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        // Verify ownership
        match self.db.get_file_owner(&file_id) {
            Some(owner) if owner == username => {}
            _ => {
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::error("File not found or not owned by you"));
                }
                return;
            }
        }
        if let Some((_fid, filename)) = self.db.delete_file_record(&file_id) {
            // Delete from disk
            let ext = std::path::Path::new(&filename)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("bin");
            let disk_name = format!("{}.{}", file_id, ext);
            let file_path = self.data_dir.join("uploads").join(&disk_name);
            let _ = std::fs::remove_file(&file_path);

            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::FileDeleted { file_id });
            }
        }
    }
}
