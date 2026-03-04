use chrono::Utc;
use rusqlite::params;

use super::Db;

impl Db {
    pub fn mark_voice_channel_occupied(&self, channel: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "UPDATE voice_channel_ttl SET empty_since = NULL WHERE channel = ?1",
            params![channel],
        ) {
            eprintln!("[db::voice] mark_voice_channel_occupied update failed: {e}");
        }
    }

    pub fn mark_voice_channel_empty(&self, channel: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();
        if let Err(e) = conn.execute(
            "UPDATE voice_channel_ttl SET empty_since = ?2 WHERE channel = ?1",
            params![channel, now],
        ) {
            eprintln!("[db::voice] mark_voice_channel_empty update failed: {e}");
        }
    }

    pub fn get_voice_channels_pending_expiry(&self) -> Vec<(String, i64)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();
        let mut stmt = conn.prepare(
            "SELECT channel, default_ttl_secs FROM voice_channel_ttl
             WHERE empty_since IS NOT NULL
             AND datetime(empty_since, '+' || default_ttl_secs || ' seconds') <= ?1"
        ).unwrap();
        stmt.query_map(params![now], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn expire_voice_channel_messages(&self, channel: &str) -> usize {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let msgs = conn.execute(
            "DELETE FROM messages WHERE channel = ?1 AND expires_at IS NULL",
            params![channel],
        ).unwrap_or(0);
        if let Err(e) = conn.execute(
            "DELETE FROM topic_replies WHERE topic_id IN (SELECT id FROM topics WHERE channel = ?1 AND expires_at IS NULL)",
            params![channel],
        ) {
            eprintln!("[db::voice] expire voice topic replies failed: {e}");
        }
        let topics = conn.execute(
            "DELETE FROM topics WHERE channel = ?1 AND expires_at IS NULL",
            params![channel],
        ).unwrap_or(0);
        if let Err(e) = conn.execute(
            "UPDATE voice_channel_ttl SET empty_since = NULL WHERE channel = ?1",
            params![channel],
        ) {
            eprintln!("[db::voice] reset voice channel empty_since failed: {e}");
        }
        msgs + topics
    }
}
