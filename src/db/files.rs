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
        let mut stmt = match conn.prepare(
            "SELECT id, filename, size, mime_type, channel, created_at, pinned, encrypted FROM files
             WHERE uploader = ?1 ORDER BY created_at DESC"
        ) {
            Ok(s) => s,
            Err(e) => { eprintln!("[db::files] list_user_files prepare failed: {e}"); return Vec::new(); }
        };
        let result = match stmt.query_map(params![username], |row| {
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
        }) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(e) => { eprintln!("[db::files] list_user_files query failed: {e}"); Vec::new() }
        };
        result
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

    pub fn get_file_size_and_mime(&self, file_id: &str) -> Option<(u64, String)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT size, mime_type FROM files WHERE id = ?1",
            params![file_id],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
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
        let mut stmt = match conn.prepare(
            "SELECT id, filename, size FROM files WHERE uploader = ?1 AND pinned = 0 ORDER BY created_at ASC"
        ) {
            Ok(s) => s,
            Err(e) => { eprintln!("[db::files] get_released_files_for_user prepare failed: {e}"); return Vec::new(); }
        };
        let result = match stmt.query_map(params![username], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        }) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(e) => { eprintln!("[db::files] get_released_files_for_user query failed: {e}"); Vec::new() }
        };
        result
    }

    pub fn list_all_files(&self, user: Option<&str>, channel: Option<&str>) -> Vec<(String, String, i64, String, String, String)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut sql = "SELECT id, filename, size, uploader, channel, created_at FROM files".to_string();
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut conditions = Vec::new();
        if let Some(u) = user {
            params_vec.push(Box::new(u.to_string()));
            conditions.push(format!("uploader = ?{}", params_vec.len()));
        }
        if let Some(c) = channel {
            params_vec.push(Box::new(c.to_string()));
            conditions.push(format!("channel = ?{}", params_vec.len()));
        }
        if !conditions.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }
        sql.push_str(" ORDER BY created_at DESC");

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(e) => { eprintln!("[db::files] list_all_files prepare failed: {e}"); return Vec::new(); }
        };
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let result = match stmt.query_map(param_refs.as_slice(), |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
        ))) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(e) => { eprintln!("[db::files] list_all_files query failed: {e}"); Vec::new() }
        };
        result
    }

    pub fn file_stats(&self) -> (i64, i64) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM files",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        ).unwrap_or((0, 0))
    }
}
