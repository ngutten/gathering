use rusqlite::params;
use std::collections::HashMap;

use super::Db;

impl Db {
    pub fn add_reaction(&self, message_id: &str, username: &str, emoji: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT OR IGNORE INTO message_reactions(message_id, username, emoji) VALUES(?1, ?2, ?3)",
            params![message_id, username, emoji],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_reaction(&self, message_id: &str, username: &str, emoji: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "DELETE FROM message_reactions WHERE message_id = ?1 AND username = ?2 AND emoji = ?3",
            params![message_id, username, emoji],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Get reactions for a batch of message IDs.
    /// Returns { message_id: { emoji: [username, ...] } }
    pub fn get_reactions_batch(&self, message_ids: &[String]) -> HashMap<String, HashMap<String, Vec<String>>> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut result: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();

        if message_ids.is_empty() {
            return result;
        }

        // Build IN clause with placeholders
        let placeholders: Vec<String> = (1..=message_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT message_id, emoji, username FROM message_reactions WHERE message_id IN ({}) ORDER BY created_at",
            placeholders.join(", ")
        );

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(e) => { eprintln!("[db::reactions] get_reactions_batch prepare failed: {e}"); return result; }
        };

        let params: Vec<&dyn rusqlite::types::ToSql> = message_ids.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();

        let rows: Vec<(String, String, String)> = match stmt.query_map(params.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        }) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(e) => { eprintln!("[db::reactions] get_reactions_batch query failed: {e}"); return result; }
        };

        for (msg_id, emoji, username) in rows {
            result
                .entry(msg_id)
                .or_default()
                .entry(emoji)
                .or_default()
                .push(username);
        }

        result
    }

    /// Delete all reactions for a message (used when deleting a message).
    pub fn delete_reactions_for_message(&self, message_id: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "DELETE FROM message_reactions WHERE message_id = ?1",
            params![message_id],
        ) {
            eprintln!("[db::reactions] delete_reactions_for_message failed: {e}");
        }
    }
}
