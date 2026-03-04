use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use chrono::{DateTime, Utc};
use rand::rngs::OsRng;
use rusqlite::{Connection, params};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use uuid::Uuid;

use crate::protocol::{DMInfo, FileInfo, HistoryMessage, InviteInfo, RoleInfo, SearchResult, TopicDetailData, TopicReplyData, TopicSummary, UserFileInfo};

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;

        // WAL mode for concurrent reads
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                username TEXT NOT NULL REFERENCES users(username),
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS channels (
                name TEXT PRIMARY KEY,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                channel TEXT NOT NULL REFERENCES channels(name),
                author TEXT NOT NULL REFERENCES users(username),
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                expires_at TEXT,
                attachments TEXT
            );

            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                size INTEGER NOT NULL,
                mime_type TEXT NOT NULL,
                uploader TEXT NOT NULL REFERENCES users(username),
                channel TEXT NOT NULL REFERENCES channels(name),
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_messages_channel_time
                ON messages(channel, timestamp);
            CREATE INDEX IF NOT EXISTS idx_messages_expires
                ON messages(expires_at) WHERE expires_at IS NOT NULL;

            CREATE TABLE IF NOT EXISTS topics (
                id TEXT PRIMARY KEY,
                channel TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                author TEXT NOT NULL,
                created_at TEXT NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0,
                expires_at TEXT,
                attachments TEXT
            );

            CREATE TABLE IF NOT EXISTS topic_replies (
                id TEXT PRIMARY KEY,
                topic_id TEXT NOT NULL REFERENCES topics(id),
                author TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT,
                attachments TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_topics_channel
                ON topics(channel, pinned DESC, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_topic_replies_topic
                ON topic_replies(topic_id, created_at ASC);

            -- Roles & permissions
            CREATE TABLE IF NOT EXISTS roles (
                name TEXT PRIMARY KEY,
                permissions TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE IF NOT EXISTS user_roles (
                username TEXT NOT NULL REFERENCES users(username),
                role_name TEXT NOT NULL REFERENCES roles(name),
                PRIMARY KEY (username, role_name)
            );

            -- Server settings
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Invite codes
            CREATE TABLE IF NOT EXISTS invite_codes (
                code TEXT PRIMARY KEY,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL,
                used_by TEXT,
                used_at TEXT
            );

            -- E2E encryption tables
            CREATE TABLE IF NOT EXISTS user_public_keys (
                username TEXT PRIMARY KEY REFERENCES users(username),
                public_key TEXT NOT NULL,
                uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS channel_encryption (
                channel TEXT PRIMARY KEY REFERENCES channels(name),
                key_version INTEGER NOT NULL DEFAULT 1,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS channel_keys (
                channel TEXT NOT NULL,
                username TEXT NOT NULL,
                encrypted_key TEXT NOT NULL,
                key_version INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (channel, username, key_version)
            );

            INSERT OR IGNORE INTO settings(key, value) VALUES ('registration_mode', 'open');
            INSERT OR IGNORE INTO settings(key, value) VALUES ('channel_creation', 'all');

            -- Ensure 'general' channel exists
            INSERT OR IGNORE INTO channels(name) VALUES ('general');",
        )?;

        // Add attachments column if missing (migration for existing DBs)
        let has_attachments: bool = conn
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, String>(0)))
            .map(|sql| sql.contains("attachments"))
            .unwrap_or(false);
        if !has_attachments {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN attachments TEXT;")?;
        }

        // Add expires_at/attachments columns to topics/topic_replies if missing
        let topics_sql: String = conn
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='topics'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, String>(0)))
            .unwrap_or_default();
        if !topics_sql.is_empty() && !topics_sql.contains("expires_at") {
            let _ = conn.execute_batch(
                "ALTER TABLE topics ADD COLUMN expires_at TEXT;
                 ALTER TABLE topics ADD COLUMN attachments TEXT;"
            );
        }
        let replies_sql: String = conn
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='topic_replies'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, String>(0)))
            .unwrap_or_default();
        if !replies_sql.is_empty() && !replies_sql.contains("expires_at") {
            let _ = conn.execute_batch(
                "ALTER TABLE topic_replies ADD COLUMN expires_at TEXT;
                 ALTER TABLE topic_replies ADD COLUMN attachments TEXT;"
            );
        }

        // Add edited_at column to messages, topics, topic_replies if missing
        let msg_sql: String = conn
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, String>(0)))
            .unwrap_or_default();
        if !msg_sql.is_empty() && !msg_sql.contains("edited_at") {
            let _ = conn.execute_batch("ALTER TABLE messages ADD COLUMN edited_at TEXT;");
        }
        // Re-read topics_sql after possible prior migration
        let topics_sql2: String = conn
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='topics'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, String>(0)))
            .unwrap_or_default();
        if !topics_sql2.is_empty() && !topics_sql2.contains("edited_at") {
            let _ = conn.execute_batch("ALTER TABLE topics ADD COLUMN edited_at TEXT;");
        }
        let replies_sql2: String = conn
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='topic_replies'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, String>(0)))
            .unwrap_or_default();
        if !replies_sql2.is_empty() && !replies_sql2.contains("edited_at") {
            let _ = conn.execute_batch("ALTER TABLE topic_replies ADD COLUMN edited_at TEXT;");
        }

        // Add encrypted column to messages if missing
        let msg_sql3: String = conn
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, String>(0)))
            .unwrap_or_default();
        if !msg_sql3.is_empty() && !msg_sql3.contains("encrypted") {
            let _ = conn.execute_batch("ALTER TABLE messages ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;");
        }

        // Add encrypted column to topics if missing
        let topics_sql3: String = conn
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='topics'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, String>(0)))
            .unwrap_or_default();
        if !topics_sql3.is_empty() && !topics_sql3.contains("encrypted") {
            let _ = conn.execute_batch("ALTER TABLE topics ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;");
        }

        // Add encrypted column to topic_replies if missing
        let replies_sql3: String = conn
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='topic_replies'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, String>(0)))
            .unwrap_or_default();
        if !replies_sql3.is_empty() && !replies_sql3.contains("encrypted") {
            let _ = conn.execute_batch("ALTER TABLE topic_replies ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;");
        }

        // DM members table
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS dm_members (
                channel TEXT NOT NULL,
                username TEXT NOT NULL,
                PRIMARY KEY (channel, username)
            );"
        )?;

        // Add disk_quota_mb column to roles if missing
        let roles_sql: String = conn
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='roles'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, String>(0)))
            .unwrap_or_default();
        if !roles_sql.is_empty() && !roles_sql.contains("disk_quota_mb") {
            let _ = conn.execute_batch("ALTER TABLE roles ADD COLUMN disk_quota_mb INTEGER NOT NULL DEFAULT 0;");
        }

        // Add pinned column to files if missing
        let files_sql: String = conn
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='files'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, String>(0)))
            .unwrap_or_default();
        if !files_sql.is_empty() && !files_sql.contains("pinned") {
            let _ = conn.execute_batch("ALTER TABLE files ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;");
        }

        // Add channel_type column to channels if missing
        let channels_sql: String = conn
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='channels'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, String>(0)))
            .unwrap_or_default();
        if !channels_sql.is_empty() && !channels_sql.contains("channel_type") {
            let _ = conn.execute_batch("ALTER TABLE channels ADD COLUMN channel_type TEXT NOT NULL DEFAULT 'text';");
        }

        // Voice channel TTL table
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS voice_channel_ttl (
                channel TEXT PRIMARY KEY,
                empty_since TEXT,
                default_ttl_secs INTEGER NOT NULL DEFAULT 600
            );"
        )?;

        Ok(Db { conn: Mutex::new(conn) })
    }

    // ── User management ─────────────────────────────────────────────

    pub fn register(&self, username: &str, password: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();

        // Check if user exists
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM users WHERE username = ?1",
                params![username],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        if exists {
            return Err("Username already taken".into());
        }

        let salt = SaltString::generate(&mut OsRng);
        let hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| e.to_string())?
            .to_string();

        conn.execute(
            "INSERT INTO users (username, password_hash) VALUES (?1, ?2)",
            params![username, hash],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn login(&self, username: &str, password: &str) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();

        let hash: String = conn
            .query_row(
                "SELECT password_hash FROM users WHERE username = ?1",
                params![username],
                |row| row.get(0),
            )
            .map_err(|_| "User not found".to_string())?;

        let parsed = PasswordHash::new(&hash).map_err(|e| e.to_string())?;
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .map_err(|_| "Invalid password".to_string())?;

        let token = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO sessions (token, username) VALUES (?1, ?2)",
            params![token, username],
        )
        .map_err(|e| e.to_string())?;

        Ok(token)
    }

    pub fn validate_token(&self, token: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT username FROM sessions WHERE token = ?1",
            params![token],
            |row| row.get(0),
        )
        .ok()
    }

    // ── Channels ────────────────────────────────────────────────────

    pub fn ensure_channel(&self, name: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT OR IGNORE INTO channels(name) VALUES (?1)",
            params![name],
        );
    }

    pub fn channel_exists(&self, name: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) > 0 FROM channels WHERE name = ?1",
            params![name],
            |row| row.get::<_, bool>(0),
        ).unwrap_or(false)
    }

    pub fn list_channels(&self) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM channels ORDER BY name")
            .unwrap();
        stmt.query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn delete_channel(&self, name: &str) -> Result<(), String> {
        if name == "general" {
            return Err("Cannot delete the general channel".into());
        }
        let conn = self.conn.lock().unwrap();
        // Delete replies for topics in this channel
        conn.execute(
            "DELETE FROM topic_replies WHERE topic_id IN (SELECT id FROM topics WHERE channel = ?1)",
            params![name],
        ).map_err(|e| e.to_string())?;
        // Delete topics
        conn.execute("DELETE FROM topics WHERE channel = ?1", params![name])
            .map_err(|e| e.to_string())?;
        // Delete messages
        conn.execute("DELETE FROM messages WHERE channel = ?1", params![name])
            .map_err(|e| e.to_string())?;
        // Delete files
        conn.execute("DELETE FROM files WHERE channel = ?1", params![name])
            .map_err(|e| e.to_string())?;
        // Delete encryption data
        let _ = conn.execute("DELETE FROM channel_keys WHERE channel = ?1", params![name]);
        let _ = conn.execute("DELETE FROM channel_encryption WHERE channel = ?1", params![name]);
        // Delete channel
        let rows = conn.execute("DELETE FROM channels WHERE name = ?1", params![name])
            .map_err(|e| e.to_string())?;
        if rows == 0 {
            return Err("Channel not found".into());
        }
        Ok(())
    }

    // ── Messages ────────────────────────────────────────────────────

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
        let conn = self.conn.lock().unwrap();
        let ts = timestamp.to_rfc3339();
        let exp = expires_at.map(|e| e.to_rfc3339());
        let att_json = attachments.map(|a| serde_json::to_string(a).unwrap_or_default());
        let _ = conn.execute(
            "INSERT INTO messages (id, channel, author, content, timestamp, expires_at, attachments, encrypted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, channel, author, content, ts, exp, att_json, encrypted as i32],
        );
    }

    pub fn get_history(&self, channel: &str, limit: u32) -> Vec<HistoryMessage> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();

        let mut stmt = conn
            .prepare(
                "SELECT id, author, content, timestamp, expires_at, attachments, edited_at, encrypted FROM messages
                 WHERE channel = ?1
                   AND (expires_at IS NULL OR expires_at > ?2)
                 ORDER BY timestamp DESC LIMIT ?3",
            )
            .unwrap();

        let rows = stmt
            .query_map(params![channel, now, limit], |row| {
                let ts_str: String = row.get(3)?;
                let exp_str: Option<String> = row.get(4)?;
                let att_str: Option<String> = row.get(5)?;
                let edited_str: Option<String> = row.get(6)?;
                let encrypted: bool = row.get::<_, i32>(7).unwrap_or(0) != 0;
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, ts_str, exp_str, att_str, edited_str, encrypted))
            })
            .unwrap()
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();

        // Resolve file IDs to FileInfo
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

        // Return in chronological order
        messages.reverse();
        messages
    }

    /// Delete expired messages, topics, and topic replies. Returns count deleted.
    pub fn purge_expired(&self) -> usize {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        let msgs = conn.execute(
            "DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?1",
            params![now],
        ).unwrap_or(0);
        // Delete replies of expired topics, then the topics themselves
        let _ = conn.execute(
            "DELETE FROM topic_replies WHERE topic_id IN (SELECT id FROM topics WHERE expires_at IS NOT NULL AND expires_at <= ?1)",
            params![now],
        );
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

    // ── Edit/Delete messages ────────────────────────────────────────

    /// Returns (channel, author) on success
    pub fn get_message_info(&self, id: &str) -> Option<(String, String)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT author, channel FROM messages WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(1)?, row.get::<_, String>(0)?)),
        ).ok()
    }

    /// Edit a message's content. Returns (channel, author).
    pub fn edit_message(&self, id: &str, content: &str) -> Result<(String, String), String> {
        let conn = self.conn.lock().unwrap();
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

    /// Delete a message. Returns (channel, author).
    pub fn delete_message(&self, id: &str) -> Result<(String, String), String> {
        let conn = self.conn.lock().unwrap();
        let (channel, author): (String, String) = conn.query_row(
            "SELECT channel, author FROM messages WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| "Message not found".to_string())?;

        conn.execute("DELETE FROM messages WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok((channel, author))
    }

    // ── Edit/Delete topics ──────────────────────────────────────────

    pub fn get_topic_author(&self, id: &str) -> Option<(String, String)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT author, channel FROM topics WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).ok()
    }

    pub fn edit_topic(&self, id: &str, title: Option<&str>, body: Option<&str>) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let channel: String = conn.query_row(
            "SELECT channel FROM topics WHERE id = ?1",
            params![id],
            |row| row.get(0),
        ).map_err(|_| "Topic not found".to_string())?;

        // Cascade delete replies
        conn.execute("DELETE FROM topic_replies WHERE topic_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM topics WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(channel)
    }

    // ── Edit/Delete topic replies ───────────────────────────────────

    pub fn get_reply_author(&self, id: &str) -> Option<(String, String)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT author, topic_id FROM topic_replies WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).ok()
    }

    pub fn edit_topic_reply(&self, id: &str, content: &str) -> Result<(String, String), String> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let (topic_id, author): (String, String) = conn.query_row(
            "SELECT topic_id, author FROM topic_replies WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| "Reply not found".to_string())?;

        conn.execute("DELETE FROM topic_replies WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok((topic_id, author))
    }

    // ── Files ───────────────────────────────────────────────────────

    pub fn store_file(
        &self,
        id: &str,
        filename: &str,
        size: i64,
        mime_type: &str,
        uploader: &str,
        channel: &str,
    ) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO files (id, filename, size, mime_type, uploader, channel)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, filename, size, mime_type, uploader, channel],
        );
    }

    pub fn get_file(&self, id: &str) -> Option<FileInfo> {
        let conn = self.conn.lock().unwrap();
        self.get_file_inner(&conn, id)
    }

    // ── Topics ────────────────────────────────────────────────────

    pub fn create_topic(
        &self, id: &str, channel: &str, title: &str, body: &str, author: &str,
        expires_at: Option<&str>, attachments: Option<&Vec<String>>, encrypted: bool,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        // Verify topic exists
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
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "UPDATE topics SET pinned = ?2 WHERE id = ?1",
            params![topic_id, pinned as i32],
        ).map_err(|e| e.to_string())?;
        if rows == 0 {
            return Err("Topic not found".into());
        }
        Ok(())
    }

    // ── Roles & Permissions ─────────────────────────────────────────

    pub fn upsert_role(&self, name: &str, permissions: &[String]) {
        let conn = self.conn.lock().unwrap();
        let perms_json = serde_json::to_string(permissions).unwrap_or_else(|_| "[]".to_string());
        let _ = conn.execute(
            "INSERT INTO roles(name, permissions) VALUES(?1, ?2)
             ON CONFLICT(name) DO UPDATE SET permissions = ?2",
            params![name, perms_json],
        );
    }

    pub fn upsert_role_with_quota(&self, name: &str, permissions: &[String], disk_quota_mb: i64) {
        let conn = self.conn.lock().unwrap();
        let perms_json = serde_json::to_string(permissions).unwrap_or_else(|_| "[]".to_string());
        let _ = conn.execute(
            "INSERT INTO roles(name, permissions, disk_quota_mb) VALUES(?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET permissions = ?2, disk_quota_mb = ?3",
            params![name, perms_json, disk_quota_mb],
        );
    }

    pub fn delete_role(&self, name: &str) -> Result<(), String> {
        if name == "user" || name == "admin" {
            return Err("Cannot delete built-in roles".into());
        }
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM user_roles WHERE role_name = ?1", params![name])
            .map_err(|e| e.to_string())?;
        let rows = conn.execute("DELETE FROM roles WHERE name = ?1", params![name])
            .map_err(|e| e.to_string())?;
        if rows == 0 {
            return Err("Role not found".into());
        }
        Ok(())
    }

    pub fn list_roles(&self) -> Vec<RoleInfo> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT name, permissions, disk_quota_mb FROM roles ORDER BY name").unwrap();
        stmt.query_map([], |row| {
            let perms_json: String = row.get(1)?;
            let permissions: Vec<String> = serde_json::from_str(&perms_json).unwrap_or_default();
            Ok(RoleInfo {
                name: row.get(0)?,
                permissions,
                disk_quota_mb: row.get::<_, i64>(2).unwrap_or(0),
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// Assign the "user" role to all existing users who have no roles at all.
    pub fn backfill_user_roles(&self) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT OR IGNORE INTO user_roles(username, role_name)
             SELECT u.username, 'user' FROM users u
             WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.username = u.username)",
            [],
        );
    }

    pub fn assign_role(&self, username: &str, role: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO user_roles(username, role_name) VALUES(?1, ?2)",
            params![username, role],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_role(&self, username: &str, role: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM user_roles WHERE username = ?1 AND role_name = ?2",
            params![username, role],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_user_roles(&self, username: &str) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT role_name FROM user_roles WHERE username = ?1 ORDER BY role_name"
        ).unwrap();
        stmt.query_map(params![username], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_user_permissions(&self, username: &str) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT r.permissions FROM roles r
             INNER JOIN user_roles ur ON ur.role_name = r.name
             WHERE ur.username = ?1"
        ).unwrap();
        let mut all_perms: Vec<String> = Vec::new();
        let rows: Vec<String> = stmt.query_map(params![username], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        for perms_json in rows {
            if let Ok(perms) = serde_json::from_str::<Vec<String>>(&perms_json) {
                all_perms.extend(perms);
            }
        }
        all_perms.sort();
        all_perms.dedup();
        all_perms
    }

    pub fn user_has_permission(&self, username: &str, perm: &str) -> bool {
        let perms = self.get_user_permissions(username);
        perms.contains(&"*".to_string()) || perms.contains(&perm.to_string())
    }

    // ── Settings ────────────────────────────────────────────────────

    pub fn get_settings(&self) -> HashMap<String, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM settings").unwrap();
        let mut map = HashMap::new();
        let rows: Vec<(String, String)> = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?))
        }).unwrap().filter_map(|r| r.ok()).collect();
        for (k, v) in rows {
            map.insert(k, v);
        }
        map
    }

    pub fn get_setting(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        ).ok()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Invite codes ────────────────────────────────────────────────

    pub fn create_invite(&self, created_by: &str) -> String {
        let code = Uuid::new_v4().to_string()[..8].to_string();
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        let _ = conn.execute(
            "INSERT INTO invite_codes(code, created_by, created_at) VALUES(?1, ?2, ?3)",
            params![code, created_by, now],
        );
        code
    }

    pub fn list_invites(&self) -> Vec<InviteInfo> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT code, created_by, created_at, used_by, used_at FROM invite_codes ORDER BY created_at DESC"
        ).unwrap();
        stmt.query_map([], |row| {
            Ok(InviteInfo {
                code: row.get(0)?,
                created_by: row.get(1)?,
                created_at: row.get(2)?,
                used_by: row.get(3)?,
                used_at: row.get(4)?,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn validate_invite(&self, code: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let used: Option<String> = conn.query_row(
            "SELECT used_by FROM invite_codes WHERE code = ?1",
            params![code],
            |row| row.get(0),
        ).map_err(|_| "Invalid invite code".to_string())?;

        if used.is_some() {
            return Err("Invite code already used".into());
        }
        Ok(())
    }

    pub fn use_invite(&self, code: &str, username: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE invite_codes SET used_by = ?2, used_at = ?3 WHERE code = ?1 AND used_by IS NULL",
            params![code, username, now],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Direct Messages ─────────────────────────────────────────

    pub fn add_dm_member(&self, channel: &str, username: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT OR IGNORE INTO dm_members(channel, username) VALUES(?1, ?2)",
            params![channel, username],
        );
    }

    pub fn is_dm_member(&self, channel: &str, username: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) > 0 FROM dm_members WHERE channel = ?1 AND username = ?2",
            params![channel, username],
            |row| row.get::<_, bool>(0),
        ).unwrap_or(false)
    }

    pub fn list_user_dms(&self, username: &str) -> Vec<DMInfo> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT channel FROM dm_members WHERE username = ?1"
        ).unwrap();
        stmt.query_map(params![username], |row| {
            let channel: String = row.get(0)?;
            // Extract other user from dm:userA:userB
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

    pub fn is_dm_channel(name: &str) -> bool {
        name.starts_with("dm:")
    }

    // ── E2E Encryption ────────────────────────────────────────────

    pub fn store_public_key(&self, username: &str, public_key: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO user_public_keys(username, public_key) VALUES(?1, ?2)
             ON CONFLICT(username) DO UPDATE SET public_key = ?2, uploaded_at = datetime('now')",
            params![username, public_key],
        );
    }

    pub fn get_public_key(&self, username: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT public_key FROM user_public_keys WHERE username = ?1",
            params![username],
            |row| row.get(0),
        ).ok()
    }

    pub fn get_public_keys(&self, usernames: &[String]) -> HashMap<String, String> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT OR IGNORE INTO channel_encryption(channel, created_by) VALUES(?1, ?2)",
            params![channel, created_by],
        );
    }

    pub fn is_channel_encrypted(&self, channel: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) > 0 FROM channel_encryption WHERE channel = ?1",
            params![channel],
            |row| row.get::<_, bool>(0),
        ).unwrap_or(false)
    }

    pub fn store_channel_key(&self, channel: &str, username: &str, encrypted_key: &str, key_version: i32) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO channel_keys(channel, username, encrypted_key, key_version) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(channel, username, key_version) DO UPDATE SET encrypted_key = ?3, updated_at = datetime('now')",
            params![channel, username, encrypted_key, key_version],
        );
    }

    pub fn get_channel_key(&self, channel: &str, username: &str) -> Option<(String, i32)> {
        let conn = self.conn.lock().unwrap();
        // Get the latest version key for this user
        conn.query_row(
            "SELECT encrypted_key, key_version FROM channel_keys
             WHERE channel = ?1 AND username = ?2
             ORDER BY key_version DESC LIMIT 1",
            params![channel, username],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?)),
        ).ok()
    }

    pub fn get_channel_key_holders(&self, channel: &str, key_version: i32) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT username FROM channel_keys WHERE channel = ?1 AND key_version = ?2"
        ).unwrap();
        stmt.query_map(params![channel, key_version], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn increment_channel_key_version(&self, channel: &str) -> i32 {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE channel_encryption SET key_version = key_version + 1 WHERE channel = ?1",
            params![channel],
        );
        conn.query_row(
            "SELECT key_version FROM channel_encryption WHERE channel = ?1",
            params![channel],
            |row| row.get::<_, i32>(0),
        ).unwrap_or(1)
    }

    pub fn delete_channel_keys_for_user(&self, channel: &str, username: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "DELETE FROM channel_keys WHERE channel = ?1 AND username = ?2",
            params![channel, username],
        );
    }

    pub fn get_channel_key_version(&self, channel: &str) -> i32 {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT key_version FROM channel_encryption WHERE channel = ?1",
            params![channel],
            |row| row.get::<_, i32>(0),
        ).unwrap_or(1)
    }

    // ── File Management (quotas, pinning) ─────────────────────────

    pub fn get_user_disk_usage(&self, username: &str) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COALESCE(SUM(size), 0) FROM files WHERE uploader = ?1",
            params![username],
            |row| row.get::<_, i64>(0),
        ).unwrap_or(0)
    }

    pub fn get_user_quota(&self, username: &str) -> i64 {
        let conn = self.conn.lock().unwrap();
        // Get max disk_quota_mb across user's roles; 0 = unlimited
        let quota_mb: i64 = conn.query_row(
            "SELECT COALESCE(MAX(r.disk_quota_mb), 0) FROM roles r
             INNER JOIN user_roles ur ON ur.role_name = r.name
             WHERE ur.username = ?1",
            params![username],
            |row| row.get::<_, i64>(0),
        ).unwrap_or(0);
        if quota_mb == 0 { 0 } else { quota_mb * 1024 * 1024 }
    }

    pub fn list_user_files(&self, username: &str) -> Vec<UserFileInfo> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, filename, size, mime_type, channel, created_at, pinned FROM files
             WHERE uploader = ?1 ORDER BY created_at DESC"
        ).unwrap();
        stmt.query_map(params![username], |row| {
            Ok(UserFileInfo {
                id: row.get(0)?,
                filename: row.get(1)?,
                size: row.get(2)?,
                mime_type: row.get(3)?,
                channel: row.get(4)?,
                created_at: row.get(5)?,
                pinned: row.get::<_, i32>(6).unwrap_or(0) != 0,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn set_file_pinned(&self, file_id: &str, pinned: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "UPDATE files SET pinned = ?2 WHERE id = ?1",
            params![file_id, pinned as i32],
        ).map_err(|e| e.to_string())?;
        if rows == 0 { return Err("File not found".into()); }
        Ok(())
    }

    pub fn get_file_owner(&self, file_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT uploader FROM files WHERE id = ?1",
            params![file_id],
            |row| row.get::<_, String>(0),
        ).ok()
    }

    pub fn delete_file_record(&self, file_id: &str) -> Option<(String, String)> {
        let conn = self.conn.lock().unwrap();
        // Get filename extension for disk cleanup
        let info: Option<(String, String)> = conn.query_row(
            "SELECT id, filename FROM files WHERE id = ?1",
            params![file_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).ok();
        if info.is_some() {
            let _ = conn.execute("DELETE FROM files WHERE id = ?1", params![file_id]);
        }
        info
    }

    pub fn get_released_files_for_user(&self, username: &str) -> Vec<(String, String, i64)> {
        // Returns (file_id, filename, size) of unpinned files, oldest first
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, filename, size FROM files WHERE uploader = ?1 AND pinned = 0 ORDER BY created_at ASC"
        ).unwrap();
        stmt.query_map(params![username], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    // ── Search ──────────────────────────────────────────────────────

    pub fn search_messages(&self, query: &str, channel: Option<&str>, limit: u32) -> Vec<SearchResult> {
        let conn = self.conn.lock().unwrap();
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

    pub fn update_role_quota(&self, name: &str, disk_quota_mb: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "UPDATE roles SET disk_quota_mb = ?2 WHERE name = ?1",
            params![name, disk_quota_mb],
        ).map_err(|e| e.to_string())?;
        if rows == 0 { return Err("Role not found".into()); }
        Ok(())
    }

    // ── Private helpers ─────────────────────────────────────────────

    // ── Voice Channel Types & TTL ─────────────────────────────────

    pub fn create_channel_with_type(&self, name: &str, channel_type: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT OR IGNORE INTO channels(name, channel_type) VALUES (?1, ?2)",
            params![name, channel_type],
        );
        if channel_type == "voice" {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO voice_channel_ttl(channel) VALUES (?1)",
                params![name],
            );
        }
    }

    pub fn get_channel_type(&self, name: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT channel_type FROM channels WHERE name = ?1",
            params![name],
            |row| row.get::<_, String>(0),
        ).ok()
    }

    pub fn list_channels_with_type(&self) -> Vec<(String, String)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT name, COALESCE(channel_type, 'text') FROM channels ORDER BY name"
        ).unwrap();
        stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn mark_voice_channel_occupied(&self, channel: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE voice_channel_ttl SET empty_since = NULL WHERE channel = ?1",
            params![channel],
        );
    }

    pub fn mark_voice_channel_empty(&self, channel: &str) {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        let _ = conn.execute(
            "UPDATE voice_channel_ttl SET empty_since = ?2 WHERE channel = ?1",
            params![channel, now],
        );
    }

    pub fn get_voice_channels_pending_expiry(&self) -> Vec<(String, i64)> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        // Delete messages without explicit TTL (expires_at IS NULL) in this voice channel
        let msgs = conn.execute(
            "DELETE FROM messages WHERE channel = ?1 AND expires_at IS NULL",
            params![channel],
        ).unwrap_or(0);
        // Delete topic replies for topics in this channel
        let _ = conn.execute(
            "DELETE FROM topic_replies WHERE topic_id IN (SELECT id FROM topics WHERE channel = ?1 AND expires_at IS NULL)",
            params![channel],
        );
        let topics = conn.execute(
            "DELETE FROM topics WHERE channel = ?1 AND expires_at IS NULL",
            params![channel],
        ).unwrap_or(0);
        // Reset empty_since
        let _ = conn.execute(
            "UPDATE voice_channel_ttl SET empty_since = NULL WHERE channel = ?1",
            params![channel],
        );
        msgs + topics
    }

    fn get_file_inner(&self, conn: &Connection, id: &str) -> Option<FileInfo> {
        conn.query_row(
            "SELECT id, filename, size, mime_type FROM files WHERE id = ?1",
            params![id],
            |row| {
                let file_id: String = row.get(0)?;
                Ok(FileInfo {
                    url: format!("/api/files/{}", file_id),
                    id: file_id,
                    filename: row.get(1)?,
                    size: row.get(2)?,
                    mime_type: row.get(3)?,
                })
            },
        )
        .ok()
    }
}
