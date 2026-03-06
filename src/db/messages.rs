use chrono::{DateTime, Utc};
use rusqlite::params;

use super::Db;
use crate::protocol::HistoryMessage;

impl Db {
    pub fn store_message(
        &self,
        id: &str,
        channel: &str,
        author: &str,
        content: &str,
        timestamp: &DateTime<Utc>,
        expires_at: Option<&DateTime<Utc>>,
        attachments: Option<&Vec<String>>,
        encrypted: bool,
    ) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let ts = timestamp.to_rfc3339();
        let exp = expires_at.map(|e| e.to_rfc3339());
        let att_json = attachments.map(|a| serde_json::to_string(a).unwrap_or_default());
        if let Err(e) = conn.execute(
            "INSERT INTO messages (id, channel, author, content, timestamp, expires_at, attachments, encrypted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, channel, author, content, ts, exp, att_json, encrypted as i32],
        ) {
            eprintln!("[db::messages] store_message insert failed: {e}");
        }
    }

    pub fn get_history(&self, channel: &str, limit: u32) -> Vec<HistoryMessage> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();

        let mut stmt = match conn.prepare(
                "SELECT id, author, content, timestamp, expires_at, attachments, edited_at, encrypted FROM messages
                 WHERE channel = ?1
                   AND (expires_at IS NULL OR expires_at > ?2)
                 ORDER BY timestamp DESC LIMIT ?3",
            ) {
            Ok(s) => s,
            Err(e) => { eprintln!("[db::messages] get_history prepare failed: {e}"); return Vec::new(); }
        };

        let rows: Vec<(String, String, String, String, Option<String>, Option<String>, Option<String>, bool)> = match stmt.query_map(params![channel, now, limit], |row| {
                let ts_str: String = row.get(3)?;
                let exp_str: Option<String> = row.get(4)?;
                let att_str: Option<String> = row.get(5)?;
                let edited_str: Option<String> = row.get(6)?;
                let encrypted: bool = row.get::<_, i32>(7).unwrap_or(0) != 0;
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, ts_str, exp_str, att_str, edited_str, encrypted))
            }) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(e) => { eprintln!("[db::messages] get_history query failed: {e}"); return Vec::new(); }
        };

        let mut messages: Vec<HistoryMessage> = rows.into_iter().map(|(id, author, content, ts_str, exp_str, att_str, edited_str, encrypted)| {
            let attachments = att_str
                .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
                .map(|ids| {
                    ids.iter()
                        .filter_map(|fid| self.get_file_inner(&conn, fid))
                        .collect::<Vec<_>>()
                })
                .filter(|v| !v.is_empty());

            let edited_at = edited_str.and_then(|s| {
                DateTime::parse_from_rfc3339(&s).ok().map(|d| d.with_timezone(&Utc))
            });

            HistoryMessage {
                id,
                author,
                content,
                timestamp: DateTime::parse_from_rfc3339(&ts_str)
                    .unwrap_or_default()
                    .with_timezone(&Utc),
                expires_at: exp_str.and_then(|s| {
                    DateTime::parse_from_rfc3339(&s).ok().map(|d| d.with_timezone(&Utc))
                }),
                attachments,
                edited_at,
                encrypted,
            }
        }).collect();

        messages.reverse();
        messages
    }

    pub fn purge_expired(&self) -> usize {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();
        let msgs = conn.execute(
            "DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?1",
            params![now],
        ).unwrap_or(0);
        if let Err(e) = conn.execute(
            "DELETE FROM topic_replies WHERE topic_id IN (SELECT id FROM topics WHERE expires_at IS NOT NULL AND expires_at <= ?1)",
            params![now],
        ) {
            eprintln!("[db::messages] purge expired topic replies failed: {e}");
        }
        let topics = conn.execute(
            "DELETE FROM topics WHERE expires_at IS NOT NULL AND expires_at <= ?1",
            params![now],
        ).unwrap_or(0);
        let replies = conn.execute(
            "DELETE FROM topic_replies WHERE expires_at IS NOT NULL AND expires_at <= ?1",
            params![now],
        ).unwrap_or(0);
        msgs + topics + replies
    }

    pub fn get_message_info(&self, id: &str) -> Option<(String, String)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT author, channel FROM messages WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(1)?, row.get::<_, String>(0)?)),
        ).ok()
    }

    pub fn edit_message(&self, id: &str, content: &str) -> Result<(String, String), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let (channel, author): (String, String) = conn.query_row(
            "SELECT channel, author FROM messages WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| "Message not found".to_string())?;

        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE messages SET content = ?2, edited_at = ?3 WHERE id = ?1",
            params![id, content, now],
        ).map_err(|e| e.to_string())?;
        Ok((channel, author))
    }

    pub fn delete_message(&self, id: &str) -> Result<(String, String), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let (channel, author): (String, String) = conn.query_row(
            "SELECT channel, author FROM messages WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| "Message not found".to_string())?;

        conn.execute("DELETE FROM messages WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok((channel, author))
    }
}
