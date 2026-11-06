use rusqlite::{params, Connection, OptionalExtension};
use std::{path::Path, sync::Mutex};

/// Key/value settings persisted in SQLite (spec §3.4). Values are JSON strings owned by the UI.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Self::init(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn get(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
    }

    pub fn set(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_key_is_none() {
        let s = Store::in_memory().unwrap();
        assert_eq!(s.get("theme").unwrap(), None);
    }

    #[test]
    fn set_then_get_and_overwrite() {
        let s = Store::in_memory().unwrap();
        s.set("theme", r#"{"mode":"dark"}"#).unwrap();
        assert_eq!(s.get("theme").unwrap().as_deref(), Some(r#"{"mode":"dark"}"#));
        s.set("theme", r#"{"mode":"light"}"#).unwrap();
        assert_eq!(s.get("theme").unwrap().as_deref(), Some(r#"{"mode":"light"}"#));
    }
}
