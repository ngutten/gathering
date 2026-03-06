use rusqlite::params;
use std::collections::HashMap;

use super::Db;

impl Db {
    pub fn get_user_preferences(&self, username: &str) -> HashMap<String, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT key, value FROM user_preferences WHERE username = ?1",
        ) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[db::preferences] get_user_preferences prepare failed: {e}");
                return HashMap::new();
            }
        };
        let rows = match stmt.query_map(params![username], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect::<Vec<_>>(),
            Err(e) => {
                eprintln!("[db::preferences] get_user_preferences query failed: {e}");
                return HashMap::new();
            }
        };
        rows.into_iter().collect()
    }

    pub fn set_user_preference(&self, username: &str, key: &str, value: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "INSERT OR REPLACE INTO user_preferences (username, key, value) VALUES (?1, ?2, ?3)",
            params![username, key, value],
        ) {
            eprintln!("[db::preferences] set_user_preference failed: {e}");
        }
    }
}
