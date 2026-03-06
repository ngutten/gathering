use rusqlite::params;
use super::Db;

impl Db {
    pub fn save_widget_state(&self, channel: &str, widget_id: &str, state_json: &str, username: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = conn.execute(
            "INSERT OR REPLACE INTO widget_state (channel, widget_id, state_json, updated_at, updated_by)
             VALUES (?1, ?2, ?3, datetime('now'), ?4)",
            params![channel, widget_id, state_json, username],
        ) {
            eprintln!("[db] save_widget_state failed: {e}");
        }
    }

    pub fn load_widget_state(&self, channel: &str, widget_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT state_json FROM widget_state WHERE channel = ?1 AND widget_id = ?2",
            params![channel, widget_id],
            |row| row.get(0),
        ).ok()
    }
}
