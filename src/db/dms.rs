use rusqlite::params;

use super::Db;
use crate::protocol::DMInfo;

impl Db {
    pub fn add_dm_member(&self, channel: &str, username: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "INSERT OR IGNORE INTO dm_members(channel, username) VALUES(?1, ?2)",
            params![channel, username],
        ) {
            eprintln!("[db::dms] add_dm_member insert failed: {e}");
        }
    }

    pub fn is_dm_member(&self, channel: &str, username: &str) -> bool {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT COUNT(*) > 0 FROM dm_members WHERE channel = ?1 AND username = ?2",
            params![channel, username],
            |row| row.get::<_, bool>(0),
        ).unwrap_or(false)
    }

    pub fn list_user_dms(&self, username: &str) -> Vec<DMInfo> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn.prepare(
            "SELECT channel FROM dm_members WHERE username = ?1"
        ).unwrap();
        stmt.query_map(params![username], |row| {
            let channel: String = row.get(0)?;
            let parts: Vec<&str> = channel.splitn(3, ':').collect();
            let other_user = if parts.len() == 3 {
                if parts[1] == username { parts[2].to_string() } else { parts[1].to_string() }
            } else {
                "unknown".to_string()
            };
            Ok(DMInfo {
                channel,
                other_user,
                encrypted: true,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }
}
