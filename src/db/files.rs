use rusqlite::params;

use super::Db;
use crate::protocol::{FileInfo, UserFileInfo};

impl Db {
    pub fn store_file(
        &self,
        id: &str,
        filename: &str,
        size: i64,
        mime_type: &str,
        uploader: &str,
        channel: &str,
        encrypted: bool,
    ) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "INSERT INTO files (id, filename, size, mime_type, uploader, channel, encrypted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, filename, size, mime_type, uploader, channel, encrypted as i32],
        ) {
            eprintln!("[db::files] store_file insert failed: {e}");
        }
    }

    pub fn get_file(&self, id: &str) -> Option<FileInfo> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        self.get_file_inner(&conn, id)
    }

    pub fn get_file_channel(&self, file_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT channel FROM files WHERE id = ?1",
            params![file_id],
            |row| row.get::<_, String>(0),
        ).ok()
    }

    pub fn list_user_files(&self, username: &str) -> Vec<UserFileInfo> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn.prepare(
            "SELECT id, filename, size, mime_type, channel, created_at, pinned, encrypted FROM files
             WHERE uploader = ?1 ORDER BY created_at DESC"
        ).unwrap();
        stmt.query_map(params![username], |row| {
            Ok(UserFileInfo {
                id: row.get(0)?,
                filename: row.get(1)?,
                size: row.get(2)?,
                mime_type: row.get(3)?,
                channel: row.get(4)?,
                created_at: row.get(5)?,
                pinned: row.get::<_, i32>(6).unwrap_or(0) != 0,
                encrypted: row.get::<_, i32>(7).unwrap_or(0) != 0,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn set_file_pinned(&self, file_id: &str, pinned: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let rows = conn.execute(
            "UPDATE files SET pinned = ?2 WHERE id = ?1",
            params![file_id, pinned as i32],
        ).map_err(|e| e.to_string())?;
        if rows == 0 { return Err("File not found".into()); }
        Ok(())
    }

    pub fn get_file_owner(&self, file_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT uploader FROM files WHERE id = ?1",
            params![file_id],
            |row| row.get::<_, String>(0),
        ).ok()
    }

    pub fn delete_file_record(&self, file_id: &str) -> Option<(String, String)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let info: Option<(String, String)> = conn.query_row(
            "SELECT id, filename FROM files WHERE id = ?1",
            params![file_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).ok();
        if info.is_some() {
            if let Err(e) = conn.execute("DELETE FROM files WHERE id = ?1", params![file_id]) {
                eprintln!("[db::files] delete_file_record delete failed: {e}");
            }
        }
        info
    }

    pub fn get_released_files_for_user(&self, username: &str) -> Vec<(String, String, i64)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn.prepare(
            "SELECT id, filename, size FROM files WHERE uploader = ?1 AND pinned = 0 ORDER BY created_at ASC"
        ).unwrap();
        stmt.query_map(params![username], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        }).unwrap().filter_map(|r| r.ok()).collect()
    }
}
