use chrono::Utc;
use rusqlite::params;
use uuid::Uuid;

use super::Db;
use crate::protocol::InviteInfo;

impl Db {
    pub fn create_invite(&self, created_by: &str) -> String {
        let code = Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();
        let _ = conn.execute(
            "INSERT INTO invite_codes(code, created_by, created_at) VALUES(?1, ?2, ?3)",
            params![code, created_by, now],
        );
        code
    }

    pub fn list_invites(&self) -> Vec<InviteInfo> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE invite_codes SET used_by = ?2, used_at = ?3 WHERE code = ?1 AND used_by IS NULL",
            params![code, username, now],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }
}
