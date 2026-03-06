use rusqlite::params;

use super::Db;

impl Db {
    pub fn ensure_channel(&self, name: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "INSERT OR IGNORE INTO channels(name) VALUES (?1)",
            params![name],
        ) {
            eprintln!("[db::channels] ensure_channel insert failed: {e}");
        }
    }

    pub fn ensure_channel_with_creator(&self, name: &str, creator: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "INSERT OR IGNORE INTO channels(name, created_by) VALUES (?1, ?2)",
            params![name, creator],
        ) {
            eprintln!("[db::channels] ensure_channel_with_creator insert failed: {e}");
        }
    }

    pub fn channel_exists(&self, name: &str) -> bool {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT COUNT(*) > 0 FROM channels WHERE name = ?1",
            params![name],
            |row| row.get::<_, bool>(0),
        ).unwrap_or(false)
    }

    pub fn delete_channel(&self, name: &str) -> Result<(), String> {
        if name == "general" {
            return Err("Cannot delete the general channel".into());
        }
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            conn.execute(
                "DELETE FROM topic_replies WHERE topic_id IN (SELECT id FROM topics WHERE channel = ?1)",
                params![name],
            ).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM topics WHERE channel = ?1", params![name])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM messages WHERE channel = ?1", params![name])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM files WHERE channel = ?1", params![name])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM channel_keys WHERE channel = ?1", params![name])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM channel_encryption WHERE channel = ?1", params![name])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM channel_members WHERE channel = ?1", params![name])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM dm_members WHERE channel = ?1", params![name])
                .map_err(|e| e.to_string())?;
            let rows = conn.execute("DELETE FROM channels WHERE name = ?1", params![name])
                .map_err(|e| e.to_string())?;
            if rows == 0 {
                return Err("Channel not found".into());
            }
            Ok(())
        })();
        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }
        result
    }

    pub fn create_channel_with_type(&self, name: &str, channel_type: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "INSERT OR IGNORE INTO channels(name, channel_type) VALUES (?1, ?2)",
            params![name, channel_type],
        ) {
            eprintln!("[db::channels] create_channel_with_type insert failed: {e}");
        }
        if channel_type == "voice" {
            if let Err(e) = conn.execute(
                "INSERT OR IGNORE INTO voice_channel_ttl(channel) VALUES (?1)",
                params![name],
            ) {
                eprintln!("[db::channels] create voice_channel_ttl entry failed: {e}");
            }
        }
    }

    pub fn list_channels_with_type(&self) -> Vec<(String, String)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT name, COALESCE(channel_type, 'text') FROM channels ORDER BY name"
        ) {
            Ok(s) => s,
            Err(e) => { eprintln!("[db::channels] list_channels_with_type prepare failed: {e}"); return Vec::new(); }
        };
        let result = match stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(e) => { eprintln!("[db::channels] list_channels_with_type query failed: {e}"); Vec::new() }
        };
        result
    }

    pub fn set_channel_restricted(&self, channel: &str, restricted: bool) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "UPDATE channels SET restricted = ?2 WHERE name = ?1",
            params![channel, restricted as i32],
        ) {
            eprintln!("[db::channels] set_channel_restricted update failed: {e}");
        }
    }

    pub fn is_channel_restricted(&self, channel: &str) -> bool {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT restricted FROM channels WHERE name = ?1",
            params![channel],
            |row| row.get::<_, i32>(0),
        ).map(|v| v != 0).unwrap_or(false)
    }

    pub fn get_channel_creator(&self, channel: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT created_by FROM channels WHERE name = ?1",
            params![channel],
            |row| row.get::<_, Option<String>>(0),
        ).ok().flatten()
    }

    pub fn can_access_channel(&self, channel: &str, username: &str) -> bool {
        if Self::is_dm_channel(channel) {
            return self.is_dm_member(channel, username);
        }
        if !self.is_channel_restricted(channel) {
            return true;
        }
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT COUNT(*) > 0 FROM channel_members WHERE channel = ?1 AND username = ?2",
            params![channel, username],
            |row| row.get::<_, bool>(0),
        ).unwrap_or(false)
    }

    pub fn is_dm_channel(name: &str) -> bool {
        name.starts_with("dm:")
    }
}
