use rusqlite::params;
use std::collections::HashMap;

use super::Db;

impl Db {
    pub fn get_settings(&self) -> HashMap<String, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare("SELECT key, value FROM settings") {
            Ok(s) => s,
            Err(e) => { eprintln!("[db::settings] get_settings prepare failed: {e}"); return HashMap::new(); }
        };
        let mut map = HashMap::new();
        let rows: Vec<(String, String)> = match stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?))
        }) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(e) => { eprintln!("[db::settings] get_settings query failed: {e}"); return HashMap::new(); }
        };
        for (k, v) in rows {
            map.insert(k, v);
        }
        map
    }

    pub fn get_setting(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        ).ok()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }
}
