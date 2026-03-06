use rusqlite::params;
use std::collections::HashMap;

use super::Db;

impl Db {
    /// Get a user's profile fields. Returns empty map if no profile set.
    pub fn get_profile(&self, username: &str) -> HashMap<String, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare("SELECT avatar_id, status, about FROM user_profiles WHERE username = ?1")
            .unwrap();
        stmt.query_row(params![username], |row| {
            let mut map = HashMap::new();
            let avatar_id: Option<String> = row.get(0)?;
            let status: Option<String> = row.get(1)?;
            let about: Option<String> = row.get(2)?;
            if let Some(v) = avatar_id { map.insert("avatar_id".into(), v); }
            if let Some(v) = status { map.insert("status".into(), v); }
            if let Some(v) = about { map.insert("about".into(), v); }
            Ok(map)
        })
        .unwrap_or_default()
    }

    /// Get profiles for multiple users at once (for bulk loading).
    pub fn get_profiles_bulk(&self, usernames: &[String]) -> HashMap<String, HashMap<String, String>> {
        if usernames.is_empty() {
            return HashMap::new();
        }
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let placeholders: Vec<String> = (1..=usernames.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT username, avatar_id, status, about FROM user_profiles WHERE username IN ({})",
            placeholders.join(",")
        );
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return HashMap::new(),
        };
        let params: Vec<&dyn rusqlite::ToSql> = usernames.iter().map(|u| u as &dyn rusqlite::ToSql).collect();
        let rows = stmt
            .query_map(params.as_slice(), |row| {
                let username: String = row.get(0)?;
                let avatar_id: Option<String> = row.get(1)?;
                let status: Option<String> = row.get(2)?;
                let about: Option<String> = row.get(3)?;
                let mut map = HashMap::new();
                if let Some(v) = avatar_id { map.insert("avatar_id".into(), v); }
                if let Some(v) = status { map.insert("status".into(), v); }
                if let Some(v) = about { map.insert("about".into(), v); }
                Ok((username, map))
            })
            .ok();
        let mut result = HashMap::new();
        if let Some(rows) = rows {
            for row in rows.flatten() {
                result.insert(row.0, row.1);
            }
        }
        result
    }

    /// Set a profile field for a user. Valid keys: avatar_id, status, about.
    pub fn set_profile_field(&self, username: &str, key: &str, value: &str) -> Result<(), String> {
        let column = match key {
            "avatar_id" | "status" | "about" => key,
            _ => return Err("Invalid profile field".into()),
        };
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        // Upsert
        let sql = format!(
            "INSERT INTO user_profiles (username, {col}) VALUES (?1, ?2)
             ON CONFLICT(username) DO UPDATE SET {col} = ?2",
            col = column
        );
        conn.execute(&sql, params![username, value])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
