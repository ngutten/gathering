use super::Hub;
use crate::protocol::ServerMsg;

const MAX_SEARCH_RESULTS: u32 = 50;

impl Hub {
    pub(super) async fn handle_search_messages(&self, id: usize, query: String, channel: Option<String>) {
        let clients = self.clients.lock().await;
        let _username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        let results = self.db.search_messages(&query, channel.as_deref(), MAX_SEARCH_RESULTS);
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::SearchResults { query, results }) {
                eprintln!("[hub::files] send search results failed: {e:?}");
            }
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
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::MyFileList { files, used_bytes, quota_bytes }) {
                eprintln!("[hub::files] send file list failed: {e:?}");
            }
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
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("File not found or not owned by you")) {
                        eprintln!("[hub::files] send file ownership error failed: {e:?}");
                    }
                }
                return;
            }
        }
        if let Err(e) = self.db.set_file_pinned(&file_id, pinned) {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                    eprintln!("[hub::files] send set_file_pinned error failed: {e:?}");
                }
            }
            return;
        }
        if let Some(client) = clients.get(&id) {
            if let Err(e) = Self::send_to(&client.tx, &ServerMsg::FilePinned { file_id, pinned }) {
                eprintln!("[hub::files] send file pinned confirmation failed: {e:?}");
            }
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
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("File not found or not owned by you")) {
                        eprintln!("[hub::files] send file ownership error failed: {e:?}");
                    }
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
            if let Err(e) = std::fs::remove_file(&file_path) {
                eprintln!("[hub::files] remove file from disk failed: {e}");
            }

            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::FileDeleted { file_id }) {
                    eprintln!("[hub::files] send file deleted confirmation failed: {e:?}");
                }
            }
        }
    }
}
