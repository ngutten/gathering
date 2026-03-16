use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use chrono::Utc;
use rand::rngs::OsRng;
use rusqlite::params;
use uuid::Uuid;

use super::Db;

impl Db {
    pub fn register(&self, username: &str, password: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());

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
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());

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
        let expires_at = (Utc::now() + chrono::Duration::days(30)).to_rfc3339();
        conn.execute(
            "INSERT INTO sessions (token, username, expires_at) VALUES (?1, ?2, ?3)",
            params![token, username, expires_at],
        )
        .map_err(|e| e.to_string())?;

        Ok(token)
    }

    pub fn validate_token(&self, token: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();
        conn.query_row(
            "SELECT username FROM sessions WHERE token = ?1 AND (expires_at IS NULL OR expires_at > ?2)",
            params![token, now],
            |row| row.get(0),
        )
        .ok()
    }

    pub fn delete_session(&self, token: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute("DELETE FROM sessions WHERE token = ?1", params![token]) {
            eprintln!("[db::auth] delete_session failed: {e}");
        }
    }

    pub fn user_exists(&self, username: &str) -> bool {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT COUNT(*) > 0 FROM users WHERE username = ?1",
            params![username],
            |row| row.get::<_, bool>(0),
        ).unwrap_or(false)
    }

    pub fn list_users(&self) -> Vec<(String, String)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT username, created_at FROM users ORDER BY username"
        ) {
            Ok(s) => s,
            Err(e) => { eprintln!("[db::auth] list_users prepare failed: {e}"); return Vec::new(); }
        };
        let result = match stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(e) => { eprintln!("[db::auth] list_users query failed: {e}"); Vec::new() }
        };
        result
    }

    pub fn delete_user(&self, username: &str, purge: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        // Save current FK state and disable — reassigning messages to "[deleted]"
        // violates the FK on messages.author since "[deleted]" is not a real user.
        // Must be set outside the transaction (PRAGMA foreign_keys is a no-op inside one).
        let fk_was_on: bool = conn.query_row("PRAGMA foreign_keys", [], |row| row.get(0)).unwrap_or(false);
        if fk_was_on {
            conn.execute_batch("PRAGMA foreign_keys = OFF").map_err(|e| e.to_string())?;
        }
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            // Check user exists
            let exists: bool = conn.query_row(
                "SELECT COUNT(*) > 0 FROM users WHERE username = ?1",
                params![username],
                |row| row.get(0),
            ).map_err(|e| e.to_string())?;
            if !exists {
                return Err("User not found".into());
            }

            conn.execute("DELETE FROM sessions WHERE username = ?1", params![username]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM user_roles WHERE username = ?1", params![username]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM user_public_keys WHERE username = ?1", params![username]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM key_backups WHERE username = ?1", params![username]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM user_profiles WHERE username = ?1", params![username]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM user_preferences WHERE username = ?1", params![username]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM channel_members WHERE username = ?1", params![username]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM dm_members WHERE username = ?1", params![username]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM channel_keys WHERE username = ?1", params![username]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM message_reactions WHERE username = ?1", params![username]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM files WHERE uploader = ?1", params![username]).map_err(|e| e.to_string())?;

            if purge {
                conn.execute(
                    "DELETE FROM topic_replies WHERE author = ?1",
                    params![username],
                ).map_err(|e| e.to_string())?;
                conn.execute(
                    "DELETE FROM topic_replies WHERE topic_id IN (SELECT id FROM topics WHERE author = ?1)",
                    params![username],
                ).map_err(|e| e.to_string())?;
                conn.execute("DELETE FROM topics WHERE author = ?1", params![username]).map_err(|e| e.to_string())?;
                conn.execute("DELETE FROM messages WHERE author = ?1", params![username]).map_err(|e| e.to_string())?;
            } else {
                // Reassign orphaned content to "[deleted]" so the FK on users can be dropped
                conn.execute("UPDATE messages SET author = '[deleted]' WHERE author = ?1", params![username]).map_err(|e| e.to_string())?;
                conn.execute("UPDATE topics SET author = '[deleted]' WHERE author = ?1", params![username]).map_err(|e| e.to_string())?;
                conn.execute("UPDATE topic_replies SET author = '[deleted]' WHERE author = ?1", params![username]).map_err(|e| e.to_string())?;
            }

            conn.execute("DELETE FROM users WHERE username = ?1", params![username]).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }
        if fk_was_on {
            let _ = conn.execute_batch("PRAGMA foreign_keys = ON");
        }
        result
    }

    pub fn reset_password(&self, username: &str, new_password: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());

        let exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM users WHERE username = ?1",
            params![username],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !exists {
            return Err("User not found".into());
        }

        let salt = SaltString::generate(&mut OsRng);
        let hash = Argon2::default()
            .hash_password(new_password.as_bytes(), &salt)
            .map_err(|e| e.to_string())?
            .to_string();

        conn.execute(
            "UPDATE users SET password_hash = ?2 WHERE username = ?1",
            params![username, hash],
        ).map_err(|e| e.to_string())?;

        // Invalidate all sessions
        conn.execute(
            "DELETE FROM sessions WHERE username = ?1",
            params![username],
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn count_user_sessions(&self, username: &str) -> i64 {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();
        conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE username = ?1 AND (expires_at IS NULL OR expires_at > ?2)",
            params![username, now],
            |row| row.get::<_, i64>(0),
        ).unwrap_or(0)
    }
}
