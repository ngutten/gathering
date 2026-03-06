use rusqlite::params;

use super::Db;

impl Db {
    pub fn add_channel_member(&self, channel: &str, username: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "INSERT OR IGNORE INTO channel_members(channel, username) VALUES(?1, ?2)",
            params![channel, username],
        ) {
            eprintln!("[db::members] add_channel_member insert failed: {e}");
        }
    }

    pub fn remove_channel_member(&self, channel: &str, username: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "DELETE FROM channel_members WHERE channel = ?1 AND username = ?2",
            params![channel, username],
        ) {
            eprintln!("[db::members] remove_channel_member delete failed: {e}");
        }
    }

    pub fn get_channel_members(&self, channel: &str) -> Vec<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT username FROM channel_members WHERE channel = ?1 ORDER BY username"
        ) {
            Ok(s) => s,
            Err(e) => { eprintln!("[db::members] get_channel_members prepare failed: {e}"); return Vec::new(); }
        };
        let result = match stmt.query_map(params![channel], |row| row.get(0)) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(e) => { eprintln!("[db::members] get_channel_members query failed: {e}"); Vec::new() }
        };
        result
    }
}
