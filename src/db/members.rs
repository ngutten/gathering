use rusqlite::params;

use super::Db;

impl Db {
    pub fn add_channel_member(&self, channel: &str, username: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute(
            "INSERT OR IGNORE INTO channel_members(channel, username) VALUES(?1, ?2)",
            params![channel, username],
        );
    }

    pub fn remove_channel_member(&self, channel: &str, username: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute(
            "DELETE FROM channel_members WHERE channel = ?1 AND username = ?2",
            params![channel, username],
        );
    }

    pub fn get_channel_members(&self, channel: &str) -> Vec<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn.prepare(
            "SELECT username FROM channel_members WHERE channel = ?1 ORDER BY username"
        ).unwrap();
        stmt.query_map(params![channel], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }
}
