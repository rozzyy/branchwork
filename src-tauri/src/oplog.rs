use crate::error::AppError;
use serde_json::Value;
use std::{
    path::Path,
    sync::{Mutex, OnceLock},
};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Entry {
    pub operation: String,
    pub worktree: String,
    pub path: String,
    pub payload: Value,
}

static ENTRIES: OnceLock<Mutex<Vec<Entry>>> = OnceLock::new();

/// Task 14 adds the SQLite oplog table. Until then, retain snapshots in-process so each write
/// still records its inverse data before it mutates the index or worktree.
pub(crate) fn record(
    operation: &str,
    worktree: &Path,
    path: &str,
    payload: Value,
) -> Result<(), AppError> {
    let worktree = worktree
        .to_str()
        .ok_or_else(|| AppError::validation("Worktree path is not valid UTF-8"))?;
    let queue = ENTRIES.get_or_init(|| Mutex::new(Vec::new()));
    queue
        .lock()
        .map_err(|_| AppError::internal("The in-process oplog queue is unavailable"))?
        .push(Entry {
            operation: operation.to_owned(),
            worktree: worktree.to_owned(),
            path: path.to_owned(),
            payload,
        });
    Ok(())
}

#[cfg(test)]
pub(crate) fn entries_for(worktree: &Path) -> Vec<Entry> {
    let Some(queue) = ENTRIES.get() else {
        return Vec::new();
    };
    let worktree = worktree.to_string_lossy();
    queue
        .lock()
        .unwrap()
        .iter()
        .filter(|entry| entry.worktree == worktree)
        .cloned()
        .collect()
}
