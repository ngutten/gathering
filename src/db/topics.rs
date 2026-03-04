use chrono::Utc;
use rusqlite::params;

use super::Db;
use crate::protocol::{TopicDetailData, TopicReplyData, TopicSummary};

impl Db {
    pub fn create_topic(
        &self, id: &str, channel: &str, title: &str, body: &str, author: &str,
        expires_at: Option<&str>, attachments: Option<&Vec<String>>, encrypted: bool,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();
        let att_json = attachments.map(|a| serde_json::to_string(a).unwrap_or_default());
        conn.execute(
            "INSERT INTO topics (id, channel, title, body, author, created_at, expires_at, attachments, encrypted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, channel, title, body, author, now, expires_at, att_json, encrypted as i32],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_topics(&self, channel: &str, limit: u32) -> Vec<TopicSummary> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();
        let mut stmt = conn.prepare(
            "SELECT t.id, t.channel, t.title, t.author, t.created_at, t.pinned,
                    COUNT(r.id) as reply_count,
                    COALESCE(MAX(r.created_at), t.created_at) as last_activity,
                    t.expires_at, t.encrypted
             FROM topics t
             LEFT JOIN topic_replies r ON r.topic_id = t.id
             WHERE t.channel = ?1
               AND (t.expires_at IS NULL OR t.expires_at > ?2)
             GROUP BY t.id
             ORDER BY t.pinned DESC, last_activity DESC
             LIMIT ?3"
        ).unwrap();
        stmt.query_map(params![channel, now, limit], |row| {
            Ok(TopicSummary {
                id: row.get(0)?,
                channel: row.get(1)?,
                title: row.get(2)?,
                author: row.get(3)?,
                created_at: row.get(4)?,
                pinned: row.get::<_, i32>(5)? != 0,
                reply_count: row.get::<_, u32>(6)?,
                last_activity: row.get(7)?,
                expires_at: row.get(8)?,
                encrypted: row.get::<_, i32>(9).unwrap_or(0) != 0,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn get_topic(&self, topic_id: &str) -> Option<TopicDetailData> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT id, channel, title, body, author, created_at, pinned, expires_at, attachments, edited_at, encrypted FROM topics WHERE id = ?1",
            params![topic_id],
            |row| {
                let att_str: Option<String> = row.get(8)?;
                let attachments = att_str
                    .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
                    .map(|ids| ids.iter().filter_map(|fid| self.get_file_inner(&conn, fid)).collect::<Vec<_>>())
                    .filter(|v| !v.is_empty());
                Ok(TopicDetailData {
                    id: row.get(0)?,
                    channel: row.get(1)?,
                    title: row.get(2)?,
                    body: row.get(3)?,
                    author: row.get(4)?,
                    created_at: row.get(5)?,
                    pinned: row.get::<_, i32>(6)? != 0,
                    expires_at: row.get(7)?,
                    attachments,
                    edited_at: row.get(9)?,
                    encrypted: row.get::<_, i32>(10).unwrap_or(0) != 0,
                })
            },
        ).ok()
    }

    pub fn get_topic_replies(&self, topic_id: &str, limit: u32) -> Vec<TopicReplyData> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();
        let mut stmt = conn.prepare(
            "SELECT id, topic_id, author, content, created_at, expires_at, attachments, edited_at, encrypted FROM topic_replies
             WHERE topic_id = ?1
               AND (expires_at IS NULL OR expires_at > ?2)
             ORDER BY created_at ASC LIMIT ?3"
        ).unwrap();
        stmt.query_map(params![topic_id, now, limit], |row| {
            let att_str: Option<String> = row.get(6)?;
            let attachments = att_str
                .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
                .map(|ids| ids.iter().filter_map(|fid| self.get_file_inner(&conn, fid)).collect::<Vec<_>>())
                .filter(|v| !v.is_empty());
            Ok(TopicReplyData {
                id: row.get(0)?,
                topic_id: row.get(1)?,
                author: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                expires_at: row.get(5)?,
                attachments,
                edited_at: row.get(7)?,
                encrypted: row.get::<_, i32>(8).unwrap_or(0) != 0,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn create_topic_reply(
        &self, id: &str, topic_id: &str, author: &str, content: &str,
        expires_at: Option<&str>, attachments: Option<&Vec<String>>, encrypted: bool,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM topics WHERE id = ?1",
            params![topic_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !exists {
            return Err("Topic not found".into());
        }
        let now = Utc::now().to_rfc3339();
        let att_json = attachments.map(|a| serde_json::to_string(a).unwrap_or_default());
        conn.execute(
            "INSERT INTO topic_replies (id, topic_id, author, content, created_at, expires_at, attachments, encrypted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, topic_id, author, content, now, expires_at, att_json, encrypted as i32],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn pin_topic(&self, topic_id: &str, pinned: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let rows = conn.execute(
            "UPDATE topics SET pinned = ?2 WHERE id = ?1",
            params![topic_id, pinned as i32],
        ).map_err(|e| e.to_string())?;
        if rows == 0 {
            return Err("Topic not found".into());
        }
        Ok(())
    }

    pub fn get_topic_author(&self, id: &str) -> Option<(String, String)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT author, channel FROM topics WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).ok()
    }

    pub fn edit_topic(&self, id: &str, title: Option<&str>, body: Option<&str>) -> Result<String, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let channel: String = conn.query_row(
            "SELECT channel FROM topics WHERE id = ?1",
            params![id],
            |row| row.get(0),
        ).map_err(|_| "Topic not found".to_string())?;

        let now = Utc::now().to_rfc3339();
        if let Some(t) = title {
            conn.execute("UPDATE topics SET title = ?2 WHERE id = ?1", params![id, t])
                .map_err(|e| e.to_string())?;
        }
        if let Some(b) = body {
            conn.execute("UPDATE topics SET body = ?2 WHERE id = ?1", params![id, b])
                .map_err(|e| e.to_string())?;
        }
        conn.execute("UPDATE topics SET edited_at = ?2 WHERE id = ?1", params![id, now])
            .map_err(|e| e.to_string())?;
        Ok(channel)
    }

    pub fn delete_topic(&self, id: &str) -> Result<String, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let channel: String = conn.query_row(
            "SELECT channel FROM topics WHERE id = ?1",
            params![id],
            |row| row.get(0),
        ).map_err(|_| "Topic not found".to_string())?;

        conn.execute("DELETE FROM topic_replies WHERE topic_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM topics WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(channel)
    }

    pub fn get_reply_author(&self, id: &str) -> Option<(String, String)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT author, topic_id FROM topic_replies WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).ok()
    }

    pub fn edit_topic_reply(&self, id: &str, content: &str) -> Result<(String, String), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let (topic_id, author): (String, String) = conn.query_row(
            "SELECT topic_id, author FROM topic_replies WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| "Reply not found".to_string())?;

        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE topic_replies SET content = ?2, edited_at = ?3 WHERE id = ?1",
            params![id, content, now],
        ).map_err(|e| e.to_string())?;
        Ok((topic_id, author))
    }

    pub fn delete_topic_reply(&self, id: &str) -> Result<(String, String), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let (topic_id, author): (String, String) = conn.query_row(
            "SELECT topic_id, author FROM topic_replies WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| "Reply not found".to_string())?;

        conn.execute("DELETE FROM topic_replies WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok((topic_id, author))
    }
}
