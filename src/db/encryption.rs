use rusqlite::params;
use std::collections::HashMap;

use super::Db;

impl Db {
    pub fn store_public_key(&self, username: &str, public_key: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "INSERT INTO user_public_keys(username, public_key) VALUES(?1, ?2)
             ON CONFLICT(username) DO UPDATE SET public_key = ?2, uploaded_at = datetime('now')",
            params![username, public_key],
        ) {
            eprintln!("[db::encryption] store_public_key upsert failed: {e}");
        }
    }

    pub fn get_public_key(&self, username: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT public_key FROM user_public_keys WHERE username = ?1",
            params![username],
            |row| row.get(0),
        ).ok()
    }

    pub fn get_public_keys(&self, usernames: &[String]) -> HashMap<String, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = HashMap::new();
        for u in usernames {
            if let Ok(key) = conn.query_row(
                "SELECT public_key FROM user_public_keys WHERE username = ?1",
                params![u],
                |row| row.get::<_, String>(0),
            ) {
                map.insert(u.clone(), key);
            }
        }
        map
    }

    pub fn set_channel_encrypted(&self, channel: &str, created_by: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "INSERT OR IGNORE INTO channel_encryption(channel, created_by) VALUES(?1, ?2)",
            params![channel, created_by],
        ) {
            eprintln!("[db::encryption] set_channel_encrypted insert failed: {e}");
        }
    }

    pub fn is_channel_encrypted(&self, channel: &str) -> bool {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT COUNT(*) > 0 FROM channel_encryption WHERE channel = ?1",
            params![channel],
            |row| row.get::<_, bool>(0),
        ).unwrap_or(false)
    }

    pub fn store_channel_key(&self, channel: &str, username: &str, encrypted_key: &str, key_version: i32) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "INSERT INTO channel_keys(channel, username, encrypted_key, key_version) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(channel, username, key_version) DO UPDATE SET encrypted_key = ?3, updated_at = datetime('now')",
            params![channel, username, encrypted_key, key_version],
        ) {
            eprintln!("[db::encryption] store_channel_key upsert failed: {e}");
        }
    }

    pub fn get_channel_key(&self, channel: &str, username: &str) -> Option<(String, i32)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT encrypted_key, key_version FROM channel_keys
             WHERE channel = ?1 AND username = ?2
             ORDER BY key_version DESC LIMIT 1",
            params![channel, username],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?)),
        ).ok()
    }

    pub fn increment_channel_key_version(&self, channel: &str) -> i32 {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "UPDATE channel_encryption SET key_version = key_version + 1 WHERE channel = ?1",
            params![channel],
        ) {
            eprintln!("[db::encryption] increment_channel_key_version update failed: {e}");
        }
        conn.query_row(
            "SELECT key_version FROM channel_encryption WHERE channel = ?1",
            params![channel],
            |row| row.get::<_, i32>(0),
        ).unwrap_or(1)
    }

    pub fn get_channel_key_version(&self, channel: &str) -> i32 {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT key_version FROM channel_encryption WHERE channel = ?1",
            params![channel],
            |row| row.get::<_, i32>(0),
        ).unwrap_or(1)
    }
}
