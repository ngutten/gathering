use rusqlite::params;

use super::Db;
use crate::protocol::RoleInfo;

impl Db {
    pub fn upsert_role(&self, name: &str, permissions: &[String]) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let perms_json = serde_json::to_string(permissions).unwrap_or_else(|_| "[]".to_string());
        let _ = conn.execute(
            "INSERT INTO roles(name, permissions) VALUES(?1, ?2)
             ON CONFLICT(name) DO UPDATE SET permissions = ?2",
            params![name, perms_json],
        );
    }

    pub fn upsert_role_with_quota(&self, name: &str, permissions: &[String], disk_quota_mb: i64) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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

    pub fn backfill_user_roles(&self) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute(
            "INSERT OR IGNORE INTO user_roles(username, role_name)
             SELECT u.username, 'user' FROM users u
             WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.username = u.username)",
            [],
        );
    }

    pub fn assign_role(&self, username: &str, role: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT OR IGNORE INTO user_roles(username, role_name) VALUES(?1, ?2)",
            params![username, role],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_role(&self, username: &str, role: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "DELETE FROM user_roles WHERE username = ?1 AND role_name = ?2",
            params![username, role],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_user_roles(&self, username: &str) -> Vec<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn.prepare(
            "SELECT role_name FROM user_roles WHERE username = ?1 ORDER BY role_name"
        ).unwrap();
        stmt.query_map(params![username], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn get_user_permissions(&self, username: &str) -> Vec<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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

    pub fn update_role_quota(&self, name: &str, disk_quota_mb: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let rows = conn.execute(
            "UPDATE roles SET disk_quota_mb = ?2 WHERE name = ?1",
            params![name, disk_quota_mb],
        ).map_err(|e| e.to_string())?;
        if rows == 0 { return Err("Role not found".into()); }
        Ok(())
    }
}
