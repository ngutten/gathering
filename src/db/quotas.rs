use rusqlite::params;

use super::Db;

impl Db {
    pub fn get_user_disk_usage(&self, username: &str) -> i64 {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT COALESCE(SUM(size), 0) FROM files WHERE uploader = ?1",
            params![username],
            |row| row.get::<_, i64>(0),
        ).unwrap_or(0)
    }

    pub fn get_user_quota(&self, username: &str) -> i64 {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let quota_mb: i64 = conn.query_row(
            "SELECT COALESCE(MAX(r.disk_quota_mb), 0) FROM roles r
             INNER JOIN user_roles ur ON ur.role_name = r.name
             WHERE ur.username = ?1",
            params![username],
            |row| row.get::<_, i64>(0),
        ).unwrap_or(0);
        if quota_mb == 0 { 0 } else { quota_mb * 1024 * 1024 }
    }
}
