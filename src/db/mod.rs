mod auth;
mod channels;
mod dms;
mod encryption;
mod files;
mod invites;
mod members;
mod messages;
mod preferences;
mod profiles;
mod quotas;
mod reactions;
mod roles;
mod search;
mod settings;
mod topics;
mod voice;
mod widget_state;

use rusqlite::{Connection, params};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::protocol::FileInfo;

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) {
    let sql: String = conn
        .prepare(&format!("SELECT sql FROM sqlite_master WHERE type='table' AND name='{}'", table))
        .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, String>(0)))
        .unwrap_or_default();
    if !sql.is_empty() && !sql.contains(column) {
        if let Err(e) = conn.execute_batch(&format!("ALTER TABLE {} ADD COLUMN {} {};", table, column, definition)) {
            eprintln!("[db] ensure_column ALTER TABLE {table} ADD {column} failed: {e}");
        }
    }
}

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

        // Column migrations for existing databases
        ensure_column(&conn, "messages", "attachments", "TEXT");
        ensure_column(&conn, "topics", "expires_at", "TEXT");
        ensure_column(&conn, "topics", "attachments", "TEXT");
        ensure_column(&conn, "topic_replies", "expires_at", "TEXT");
        ensure_column(&conn, "topic_replies", "attachments", "TEXT");
        ensure_column(&conn, "messages", "edited_at", "TEXT");
        ensure_column(&conn, "topics", "edited_at", "TEXT");
        ensure_column(&conn, "topic_replies", "edited_at", "TEXT");
        ensure_column(&conn, "messages", "encrypted", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(&conn, "topics", "encrypted", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(&conn, "topic_replies", "encrypted", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(&conn, "roles", "disk_quota_mb", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(&conn, "files", "pinned", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(&conn, "channels", "channel_type", "TEXT NOT NULL DEFAULT 'text'");
        ensure_column(&conn, "channels", "restricted", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(&conn, "channels", "created_by", "TEXT");
        ensure_column(&conn, "sessions", "expires_at", "TEXT");
        ensure_column(&conn, "files", "encrypted", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(&conn, "messages", "reply_to_id", "TEXT");
        ensure_column(&conn, "messages", "reply_to_author", "TEXT");
        ensure_column(&conn, "messages", "reply_to_snippet", "TEXT");
        ensure_column(&conn, "messages", "mentions", "TEXT");
        ensure_column(&conn, "messages", "pinned", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(&conn, "channels", "anonymous", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(&conn, "channels", "force_ghost", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(&conn, "channels", "max_ttl_secs", "INTEGER");

        // Table creation migrations
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS dm_members (
                channel TEXT NOT NULL,
                username TEXT NOT NULL,
                PRIMARY KEY (channel, username)
            );"
        )?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS voice_channel_ttl (
                channel TEXT PRIMARY KEY,
                empty_since TEXT,
                default_ttl_secs INTEGER NOT NULL DEFAULT 600
            );"
        )?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS channel_members (
                channel TEXT NOT NULL,
                username TEXT NOT NULL,
                PRIMARY KEY (channel, username)
            );"
        )?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS user_preferences (
                username TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (username, key)
            );"
        )?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS message_reactions (
                message_id TEXT NOT NULL,
                username TEXT NOT NULL,
                emoji TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (message_id, username, emoji)
            );"
        )?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS widget_state (
                channel TEXT NOT NULL,
                widget_id TEXT NOT NULL,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_by TEXT NOT NULL,
                PRIMARY KEY (channel, widget_id)
            );"
        )?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS key_backups (
                username TEXT PRIMARY KEY REFERENCES users(username),
                encrypted_key TEXT NOT NULL,
                salt TEXT NOT NULL,
                nonce TEXT NOT NULL,
                ops_limit INTEGER NOT NULL,
                mem_limit INTEGER NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );"
        )?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS user_profiles (
                username TEXT PRIMARY KEY REFERENCES users(username),
                avatar_id TEXT,
                status TEXT,
                about TEXT
            );"
        )?;

        Ok(Db { conn: Mutex::new(conn) })
    }

    /// Create a backup of the database to the given directory.
    /// Returns the path to the backup file.
    pub fn backup(&self, backup_dir: &Path) -> Result<PathBuf, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let backup_name = format!("gathering_backup_{}.db", timestamp);
        let backup_path = backup_dir.join(&backup_name);

        let mut dst = Connection::open(&backup_path).map_err(|e| format!("Failed to create backup file: {}", e))?;
        let backup = rusqlite::backup::Backup::new(&conn, &mut dst)
            .map_err(|e| format!("Failed to init backup: {}", e))?;
        backup.step(-1)
            .map_err(|e| format!("Backup failed: {}", e))?;

        Ok(backup_path)
    }

    pub fn table_counts(&self) -> Vec<(String, i64)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let tables = [
            "users", "sessions", "channels", "messages", "files", "topics",
            "topic_replies", "roles", "user_roles", "settings", "invite_codes",
            "user_public_keys", "channel_encryption", "channel_keys",
            "dm_members", "channel_members", "user_preferences",
            "message_reactions", "widget_state", "key_backups", "user_profiles",
            "voice_channel_ttl",
        ];
        let mut counts = Vec::new();
        for table in &tables {
            let count: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM {}", table),
                [],
                |row| row.get(0),
            ).unwrap_or(0);
            counts.push((table.to_string(), count));
        }
        counts
    }

    pub fn purge_expired_sessions(&self) -> usize {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= ?1",
            params![now],
        ).unwrap_or(0)
    }

    fn get_file_inner(&self, conn: &Connection, id: &str) -> Option<FileInfo> {
        conn.query_row(
            "SELECT id, filename, size, mime_type, encrypted FROM files WHERE id = ?1",
            params![id],
            |row| {
                let file_id: String = row.get(0)?;
                Ok(FileInfo {
                    url: format!("/api/files/{}", file_id),
                    id: file_id,
                    filename: row.get(1)?,
                    size: row.get(2)?,
                    mime_type: row.get(3)?,
                    encrypted: row.get::<_, i32>(4).unwrap_or(0) != 0,
                })
            },
        )
        .ok()
    }
}
