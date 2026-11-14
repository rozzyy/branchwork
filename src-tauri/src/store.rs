use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};

pub(crate) const OPLOG_MAX_PAYLOAD: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OplogRow {
    pub id: i64,
    pub kind: String,
    pub payload: Option<Vec<u8>>,
    pub undoable: bool,
}

#[cfg(test)]
pub(crate) struct StoredOplogRow {
    pub kind: String,
    pub payload: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub color: String,
    pub clone_path_template: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub owner: Option<String>,
    pub name: String,
    pub local_path: String,
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePin {
    pub project_id: String,
    pub worktree_path: String,
}

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
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn get(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()
    }

    pub fn set(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Delete every setting whose key starts with `prefix` (a closed window's
    /// scoped keys). Returns the number of rows removed.
    pub fn delete_settings_with_prefix(&self, prefix: &str) -> rusqlite::Result<usize> {
        self.conn.lock().unwrap().execute(
            "DELETE FROM settings WHERE substr(key, 1, length(?1)) = ?1",
            params![prefix],
        )
    }

    pub fn list_groups(&self) -> rusqlite::Result<Vec<Group>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, color, clone_path_template FROM groups ORDER BY name, id")?;
        stmt.query_map([], |row| {
            Ok(Group {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                clone_path_template: row.get(3)?,
            })
        })?
        .collect()
    }

    pub fn save_group(&self, group: &Group) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO groups (id, name, color, clone_path_template) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, clone_path_template = excluded.clone_path_template",
            params![group.id, group.name, group.color, group.clone_path_template],
        )?;
        Ok(())
    }

    pub fn delete_group(&self, id: &str) -> rusqlite::Result<bool> {
        Ok(self
            .conn
            .lock()
            .unwrap()
            .execute("DELETE FROM groups WHERE id = ?1", [id])?
            > 0)
    }

    pub fn list_projects(&self) -> rusqlite::Result<Vec<Project>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, owner, name, local_path, group_id FROM projects ORDER BY name, local_path",
        )?;
        stmt.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                owner: row.get(1)?,
                name: row.get(2)?,
                local_path: row.get(3)?,
                group_id: row.get(4)?,
            })
        })?
        .collect()
    }

    pub fn project_by_path(&self, local_path: &str) -> rusqlite::Result<Option<Project>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT id, owner, name, local_path, group_id FROM projects WHERE local_path = ?1",
                [local_path],
                |row| {
                    Ok(Project {
                        id: row.get(0)?,
                        owner: row.get(1)?,
                        name: row.get(2)?,
                        local_path: row.get(3)?,
                        group_id: row.get(4)?,
                    })
                },
            )
            .optional()
    }

    pub fn save_project(&self, project: &Project) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO projects (id, owner, name, local_path, group_id) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, name = excluded.name, local_path = excluded.local_path, group_id = excluded.group_id",
            params![project.id, project.owner, project.name, project.local_path, project.group_id],
        )?;
        Ok(())
    }

    pub fn delete_project(&self, id: &str) -> rusqlite::Result<bool> {
        Ok(self
            .conn
            .lock()
            .unwrap()
            .execute("DELETE FROM projects WHERE id = ?1", [id])?
            > 0)
    }

    pub fn list_pins(&self, project_id: Option<&str>) -> rusqlite::Result<Vec<WorktreePin>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT project_id, worktree_path FROM worktree_pins
             WHERE (?1 IS NULL OR project_id = ?1) ORDER BY project_id, worktree_path",
        )?;
        stmt.query_map([project_id], |row| {
            Ok(WorktreePin {
                project_id: row.get(0)?,
                worktree_path: row.get(1)?,
            })
        })?
        .collect()
    }

    pub fn pin_worktree(&self, pin: &WorktreePin) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT OR IGNORE INTO worktree_pins (project_id, worktree_path) VALUES (?1, ?2)",
            params![pin.project_id, pin.worktree_path],
        )?;
        Ok(())
    }

    pub fn unpin_worktree(&self, project_id: &str, worktree_path: &str) -> rusqlite::Result<bool> {
        Ok(self.conn.lock().unwrap().execute(
            "DELETE FROM worktree_pins WHERE project_id = ?1 AND worktree_path = ?2",
            params![project_id, worktree_path],
        )? > 0)
    }

    pub(crate) fn record_oplog(
        &self,
        worktree_path: &str,
        kind: &str,
        payload: &[u8],
        undoable: bool,
    ) -> rusqlite::Result<i64> {
        let within_limit = payload.len() <= OPLOG_MAX_PAYLOAD;
        let undoable = undoable && within_limit;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO oplog (worktree_path, kind, payload, undoable, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                worktree_path,
                kind,
                within_limit.then_some(payload),
                undoable,
                unix_time_seconds()
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub(crate) fn update_oplog_payload(&self, id: i64, payload: &[u8]) -> rusqlite::Result<bool> {
        let within_limit = payload.len() <= OPLOG_MAX_PAYLOAD;
        Ok(self.conn.lock().unwrap().execute(
            "UPDATE oplog SET payload = ?1, undoable = undoable AND ?2 WHERE id = ?3",
            params![within_limit.then_some(payload), within_limit, id],
        )? > 0)
    }

    pub(crate) fn mark_oplog_non_undoable(&self, id: i64) -> rusqlite::Result<bool> {
        Ok(self
            .conn
            .lock()
            .unwrap()
            .execute("UPDATE oplog SET undoable = 0 WHERE id = ?1", [id])?
            > 0)
    }

    pub(crate) fn latest_oplog_undoable(
        &self,
        worktree_path: &str,
    ) -> rusqlite::Result<Option<bool>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT undoable FROM oplog WHERE worktree_path = ?1 ORDER BY id DESC LIMIT 1",
                [worktree_path],
                |row| row.get::<_, bool>(0),
            )
            .optional()
    }

    pub(crate) fn latest_oplog(&self, worktree_path: &str) -> rusqlite::Result<Option<OplogRow>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT id, kind, payload, undoable FROM oplog
                 WHERE worktree_path = ?1 ORDER BY id DESC LIMIT 1",
                [worktree_path],
                |row| {
                    Ok(OplogRow {
                        id: row.get(0)?,
                        kind: row.get(1)?,
                        payload: row.get(2)?,
                        undoable: row.get(3)?,
                    })
                },
            )
            .optional()
    }

    pub(crate) fn delete_oplog(&self, id: i64) -> rusqlite::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM oplog WHERE id = ?1", [id])?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn oplog_rows_for(
        &self,
        worktree_path: &str,
    ) -> rusqlite::Result<Vec<StoredOplogRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT kind, payload FROM oplog WHERE worktree_path = ?1 ORDER BY id ASC")?;
        stmt.query_map([worktree_path], |row| {
            Ok(StoredOplogRow {
                kind: row.get(0)?,
                payload: row.get(1)?,
            })
        })?
        .collect()
    }

    #[cfg(test)]
    pub(crate) fn reject_oplog_inserts(&self) {
        self.conn
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_oplog BEFORE INSERT ON oplog
                 BEGIN SELECT RAISE(ABORT, 'oplog unavailable'); END;",
            )
            .unwrap();
    }
}

fn unix_time_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > 2 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if version == 0 {
        conn.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE IF NOT EXISTS settings (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             CREATE TABLE groups (
                 id TEXT PRIMARY KEY NOT NULL,
                 name TEXT NOT NULL,
                 color TEXT NOT NULL,
                 clone_path_template TEXT NOT NULL
             );
             CREATE TABLE projects (
                 id TEXT PRIMARY KEY NOT NULL,
                 owner TEXT,
                 name TEXT NOT NULL,
                 local_path TEXT NOT NULL UNIQUE,
                 group_id TEXT REFERENCES groups(id) ON DELETE SET NULL
             );
             CREATE INDEX projects_group_id_idx ON projects(group_id);
             CREATE TABLE worktree_pins (
                 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                 worktree_path TEXT NOT NULL,
                 PRIMARY KEY (project_id, worktree_path)
             );
             PRAGMA user_version = 1;
             COMMIT;",
        )?;
    }
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version < 2 {
        conn.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE IF NOT EXISTS oplog (
                 id INTEGER PRIMARY KEY,
                 worktree_path TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 payload BLOB,
                 undoable INTEGER NOT NULL DEFAULT 1,
                 created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS oplog_worktree_id_idx
                 ON oplog(worktree_path, id DESC);
             PRAGMA user_version = 2;
             COMMIT;",
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_is_idempotent_and_preserves_settings() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO settings (key, value) VALUES ('theme', '{\"mode\":\"dark\"}');",
        )
        .unwrap();

        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO oplog (worktree_path, kind, payload, undoable, created_at)
             VALUES ('/repo', 'commit', X'7B7D', 1, 1)",
            [],
        )
        .unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let setting: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'theme'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 2);
        assert_eq!(setting, r#"{"mode":"dark"}"#);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM oplog", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
        let index: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'oplog_worktree_id_idx'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(index.contains("worktree_path, id DESC"));
    }

    #[test]
    fn deleting_group_ungroups_projects_and_deleting_project_removes_pins() {
        let store = Store::in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO groups (id, name, color, clone_path_template) VALUES ('g1', 'Group', 'blue', '~/clients/{repo}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, local_path, group_id) VALUES ('p1', 'Repo', '/repos/repo', 'g1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO worktree_pins (project_id, worktree_path) VALUES ('p1', '/repos/repo')",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM groups WHERE id = 'g1'", [])
            .unwrap();
        let group_id: Option<String> = conn
            .query_row("SELECT group_id FROM projects WHERE id = 'p1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(group_id, None);

        conn.execute("DELETE FROM projects WHERE id = 'p1'", [])
            .unwrap();
        let pin_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM worktree_pins", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pin_count, 0);
    }

    #[test]
    fn duplicate_project_paths_are_rejected() {
        let store = Store::in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, local_path) VALUES ('p1', 'Repo', '/repos/repo')",
            [],
        )
        .unwrap();

        let result = conn.execute(
            "INSERT INTO projects (id, name, local_path) VALUES ('p2', 'Other name', '/repos/repo')",
            [],
        );
        assert!(matches!(result, Err(rusqlite::Error::SqliteFailure(_, _))));
    }

    #[test]
    fn catalog_crud_and_group_reassignment_work() {
        let store = Store::in_memory().unwrap();
        let group = Group {
            id: "g1".into(),
            name: "Group".into(),
            color: "blue".into(),
            clone_path_template: "~/clients/{repo}".into(),
        };
        store.save_group(&group).unwrap();
        assert_eq!(store.list_groups().unwrap(), vec![group.clone()]);

        let project = Project {
            id: "p1".into(),
            owner: Some("owner".into()),
            name: "Repo".into(),
            local_path: "/repos/repo".into(),
            group_id: Some(group.id.clone()),
        };
        store.save_project(&project).unwrap();
        assert_eq!(store.list_projects().unwrap(), vec![project.clone()]);

        let updated = Project {
            group_id: None,
            name: "Renamed".into(),
            ..project
        };
        store.save_project(&updated).unwrap();
        assert_eq!(store.list_projects().unwrap(), vec![updated]);
        assert!(store.delete_group(&group.id).unwrap());
        assert!(store.list_groups().unwrap().is_empty());
        assert!(store.delete_project("p1").unwrap());
        assert!(store.list_projects().unwrap().is_empty());
        assert!(!store.delete_project("p1").unwrap());
    }

    #[test]
    fn pins_are_idempotent_listable_and_removable() {
        let store = Store::in_memory().unwrap();
        store
            .save_project(&Project {
                id: "p1".into(),
                owner: None,
                name: "Repo".into(),
                local_path: "/repos/repo".into(),
                group_id: None,
            })
            .unwrap();
        let pin = WorktreePin {
            project_id: "p1".into(),
            worktree_path: "/repos/repo-feature".into(),
        };
        store.pin_worktree(&pin).unwrap();
        store.pin_worktree(&pin).unwrap();
        assert_eq!(store.list_pins(None).unwrap(), vec![pin.clone()]);
        assert_eq!(
            store.list_pins(Some("p2")).unwrap(),
            Vec::<WorktreePin>::new()
        );
        assert!(
            store
                .unpin_worktree(&pin.project_id, &pin.worktree_path)
                .unwrap()
        );
        assert!(
            !store
                .unpin_worktree(&pin.project_id, &pin.worktree_path)
                .unwrap()
        );
    }

    #[test]
    fn project_rejects_unknown_group_references() {
        let store = Store::in_memory().unwrap();
        let result = store.save_project(&Project {
            id: "p1".into(),
            owner: None,
            name: "Repo".into(),
            local_path: "/repos/repo".into(),
            group_id: Some("missing".into()),
        });
        assert!(matches!(result, Err(rusqlite::Error::SqliteFailure(_, _))));
    }

    #[test]
    fn missing_key_is_none() {
        let s = Store::in_memory().unwrap();
        assert_eq!(s.get("theme").unwrap(), None);
    }

    #[test]
    fn set_then_get_and_overwrite() {
        let s = Store::in_memory().unwrap();
        s.set("theme", r#"{"mode":"dark"}"#).unwrap();
        assert_eq!(
            s.get("theme").unwrap().as_deref(),
            Some(r#"{"mode":"dark"}"#)
        );
        s.set("theme", r#"{"mode":"light"}"#).unwrap();
        assert_eq!(
            s.get("theme").unwrap().as_deref(),
            Some(r#"{"mode":"light"}"#)
        );
    }

    #[test]
    fn oplog_payload_cap_keeps_oversize_rows_but_disables_undo() {
        let store = Store::in_memory().unwrap();
        let within = vec![b'x'; OPLOG_MAX_PAYLOAD];
        let oversize = vec![b'y'; OPLOG_MAX_PAYLOAD + 1];
        store
            .record_oplog("/repo", "discard", &within, true)
            .unwrap();
        store
            .record_oplog("/repo", "discard", &oversize, true)
            .unwrap();
        assert_eq!(store.latest_oplog_undoable("/repo").unwrap(), Some(false));
        let conn = store.conn.lock().unwrap();
        let rows: Vec<(Option<Vec<u8>>, bool)> = conn
            .prepare("SELECT payload, undoable FROM oplog ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows[0].0.as_ref().unwrap().len(), OPLOG_MAX_PAYLOAD);
        assert!(rows[0].1);
        assert_eq!(rows[1], (None, false));
    }

    #[test]
    fn failed_oplog_insert_is_reported_to_abort_the_forward_write() {
        let store = Store::in_memory().unwrap();
        store.reject_oplog_inserts();
        let error = store.record_oplog("/repo", "discard", b"{}", true);
        assert!(error.is_err());
        assert_eq!(store.latest_oplog_undoable("/repo").unwrap(), None);
    }

    #[test]
    fn oplog_migration_preserves_existing_catalog_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE groups (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, clone_path_template TEXT NOT NULL);
             CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, owner TEXT, name TEXT NOT NULL, local_path TEXT NOT NULL UNIQUE, group_id TEXT);
             CREATE TABLE worktree_pins (project_id TEXT NOT NULL, worktree_path TEXT NOT NULL, PRIMARY KEY (project_id, worktree_path));
             INSERT INTO settings VALUES ('theme', 'dark');
             INSERT INTO groups VALUES ('g1', 'Group', 'blue', '~/repos/{repo}');
             INSERT INTO projects VALUES ('p1', 'owner', 'Repo', '/repos/repo', 'g1');
             INSERT INTO worktree_pins VALUES ('p1', '/repos/repo');
             PRAGMA user_version = 1;",
        )
        .unwrap();

        migrate(&conn).unwrap();
        migrate(&conn).unwrap();

        let catalog_counts: (i64, i64, i64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM groups), (SELECT COUNT(*) FROM projects), (SELECT COUNT(*) FROM worktree_pins)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(catalog_counts, (1, 1, 1));
        let theme: String = conn
            .query_row("SELECT value FROM settings WHERE key='theme'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(theme, "dark");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
    }
}
