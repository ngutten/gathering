use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use chrono::{DateTime, Utc};
use rand::rngs::OsRng;
use rusqlite::{Connection, params};
use std::path::Path;
use std::sync::Mutex;
use uuid::Uuid;

use crate::protocol::HistoryMessage;

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
                expires_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_messages_channel_time
                ON messages(channel, timestamp);
            CREATE INDEX IF NOT EXISTS idx_messages_expires
                ON messages(expires_at) WHERE expires_at IS NOT NULL;

            -- Ensure 'general' channel exists
            INSERT OR IGNORE INTO channels(name) VALUES ('general');",
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

    // ── Messages ────────────────────────────────────────────────────

    pub fn store_message(
        &self,
        id: &str,
        channel: &str,
        author: &str,
        content: &str,
        timestamp: &DateTime<Utc>,
        expires_at: Option<&DateTime<Utc>>,
    ) {
        let conn = self.conn.lock().unwrap();
        let ts = timestamp.to_rfc3339();
        let exp = expires_at.map(|e| e.to_rfc3339());
        let _ = conn.execute(
            "INSERT INTO messages (id, channel, author, content, timestamp, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, channel, author, content, ts, exp],
        );
    }

    pub fn get_history(&self, channel: &str, limit: u32) -> Vec<HistoryMessage> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();

        let mut stmt = conn
            .prepare(
                "SELECT id, author, content, timestamp, expires_at FROM messages
                 WHERE channel = ?1
                   AND (expires_at IS NULL OR expires_at > ?2)
                 ORDER BY timestamp DESC LIMIT ?3",
            )
            .unwrap();

        let rows = stmt
            .query_map(params![channel, now, limit], |row| {
                let ts_str: String = row.get(3)?;
                let exp_str: Option<String> = row.get(4)?;
                Ok(HistoryMessage {
                    id: row.get(0)?,
                    author: row.get(1)?,
                    content: row.get(2)?,
                    timestamp: DateTime::parse_from_rfc3339(&ts_str)
                        .unwrap_or_default()
                        .with_timezone(&Utc),
                    expires_at: exp_str.and_then(|s| {
                        DateTime::parse_from_rfc3339(&s).ok().map(|d| d.with_timezone(&Utc))
                    }),
                })
            })
            .unwrap()
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();

        // Return in chronological order
        rows.into_iter().rev().collect()
    }

    /// Delete expired messages. Returns count deleted.
    pub fn purge_expired(&self) -> usize {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?1",
            params![now],
        )
        .unwrap_or(0)
    }
}
