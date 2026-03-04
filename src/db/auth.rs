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
        let _ = conn.execute("DELETE FROM sessions WHERE token = ?1", params![token]);
    }
}
