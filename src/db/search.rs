use chrono::Utc;
use rusqlite::params_from_iter;

use super::Db;
use crate::protocol::SearchResult;

impl Db {
    pub fn search_messages(
        &self,
        query: &str,
        channel: Option<&str>,
        from: Option<&str>,
        date_start: Option<&str>,
        date_end: Option<&str>,
        mentions: Option<&str>,
        limit: u32,
    ) -> Vec<SearchResult> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = Utc::now().to_rfc3339();

        let mut sql = String::from(
            "SELECT id, channel, author, content, timestamp FROM messages WHERE encrypted = 0 AND (expires_at IS NULL OR expires_at > ?1)"
        );
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now)];
        let mut idx = 2;

        if let Some(ch) = channel {
            sql.push_str(&format!(" AND channel = ?{idx}"));
            params.push(Box::new(ch.to_string()));
            idx += 1;
        }

        if !query.is_empty() {
            let escaped_query = query.replace('%', "\\%").replace('_', "\\_");
            let pattern = format!("%{escaped_query}%");
            sql.push_str(&format!(" AND content LIKE ?{idx} ESCAPE '\\'"));
            params.push(Box::new(pattern));
            idx += 1;
        }

        if let Some(author) = from {
            sql.push_str(&format!(" AND author = ?{idx}"));
            params.push(Box::new(author.to_string()));
            idx += 1;
        }

        if let Some(ds) = date_start {
            sql.push_str(&format!(" AND timestamp >= ?{idx}"));
            params.push(Box::new(ds.to_string()));
            idx += 1;
        }

        if let Some(de) = date_end {
            sql.push_str(&format!(" AND timestamp < ?{idx}"));
            params.push(Box::new(de.to_string()));
            idx += 1;
        }

        if let Some(target) = mentions {
            // mentions column stores JSON array like ["alice","bob"]
            let escaped_target = target.replace('%', "\\%").replace('_', "\\_");
            let mention_pattern = format!("%\"{escaped_target}\"%");
            sql.push_str(&format!(" AND mentions LIKE ?{idx} ESCAPE '\\'"));
            params.push(Box::new(mention_pattern));
            idx += 1;
        }

        let _ = idx; // suppress unused warning

        sql.push_str(" ORDER BY timestamp DESC LIMIT ?");
        params.push(Box::new(limit));

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(e) => { eprintln!("[db::search] search_messages prepare failed: {e}"); return Vec::new(); }
        };

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let result = match stmt.query_map(params_from_iter(param_refs), |row| {
            Ok(SearchResult {
                id: row.get(0)?,
                channel: row.get(1)?,
                author: row.get(2)?,
                content: row.get(3)?,
                timestamp: row.get(4)?,
            })
        }) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(e) => { eprintln!("[db::search] search_messages query failed: {e}"); Vec::new() }
        };
        result
    }
}
