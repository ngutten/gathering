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
        if let Err(e) = conn.execute(
            "INSERT INTO invite_codes(code, created_by, created_at) VALUES(?1, ?2, ?3)",
            params![code, created_by, now],
        ) {
            eprintln!("[db::invites] create_invite insert failed: {e}");
        }
        code
    }

    pub fn list_invites(&self) -> Vec<InviteInfo> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT code, created_by, created_at, used_by, used_at FROM invite_codes ORDER BY created_at DESC"
        ) {
            Ok(s) => s,
            Err(e) => { eprintln!("[db::invites] list_invites prepare failed: {e}"); return Vec::new(); }
        };
        let result = match stmt.query_map([], |row| {
            Ok(InviteInfo {
                code: row.get(0)?,
                created_by: row.get(1)?,
                created_at: row.get(2)?,
                used_by: row.get(3)?,
                used_at: row.get(4)?,
            })
        }) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(e) => { eprintln!("[db::invites] list_invites query failed: {e}"); Vec::new() }
        };
        result
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

    /// Atomically validate and consume an invite code. Returns error if code
    /// is invalid or was already used (prevents TOCTOU race).
    /// Note: used_by is set to "(used)" rather than the actual username to avoid
    /// building a social graph of who invited whom.
    pub fn use_invite(&self, code: &str, _username: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();
        let rows = conn.execute(
            "UPDATE invite_codes SET used_by = '(used)', used_at = ?2 WHERE code = ?1 AND used_by IS NULL",
            params![code, now],
        ).map_err(|e| e.to_string())?;
        if rows == 0 {
            return Err("Invite code is invalid or already used".into());
        }
        Ok(())
    }

    pub fn purge_used_invites(&self) -> usize {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "DELETE FROM invite_codes WHERE used_by IS NOT NULL",
            [],
        ).unwrap_or(0)
    }
}
