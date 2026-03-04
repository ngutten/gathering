use chrono::Utc;
use rusqlite::params;

use super::Db;
use crate::protocol::SearchResult;

impl Db {
    pub fn search_messages(&self, query: &str, channel: Option<&str>, limit: u32) -> Vec<SearchResult> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();
        let pattern = format!("%{}%", query);
        if let Some(ch) = channel {
            let mut stmt = conn.prepare(
                "SELECT id, channel, author, content, timestamp FROM messages
                 WHERE channel = ?1 AND content LIKE ?2 AND encrypted = 0
                   AND (expires_at IS NULL OR expires_at > ?3)
                 ORDER BY timestamp DESC LIMIT ?4"
            ).unwrap();
            stmt.query_map(params![ch, pattern, now, limit], |row| {
                Ok(SearchResult {
                    id: row.get(0)?,
                    channel: row.get(1)?,
                    author: row.get(2)?,
                    content: row.get(3)?,
                    timestamp: row.get(4)?,
                })
            }).unwrap().filter_map(|r| r.ok()).collect()
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, channel, author, content, timestamp FROM messages
                 WHERE content LIKE ?1 AND encrypted = 0
                   AND (expires_at IS NULL OR expires_at > ?2)
                 ORDER BY timestamp DESC LIMIT ?3"
            ).unwrap();
            stmt.query_map(params![pattern, now, limit], |row| {
                Ok(SearchResult {
                    id: row.get(0)?,
                    channel: row.get(1)?,
                    author: row.get(2)?,
                    content: row.get(3)?,
                    timestamp: row.get(4)?,
                })
            }).unwrap().filter_map(|r| r.ok()).collect()
        }
    }
}
