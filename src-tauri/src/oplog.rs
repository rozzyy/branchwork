use crate::{
    error::AppError,
    store::{OPLOG_MAX_PAYLOAD, OplogRow, Store},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(crate) fn snapshot_payload_cost(path: &Path, byte_len: u64) -> usize {
    let path_len = path.to_string_lossy().len();
    usize::try_from(byte_len)
        .unwrap_or(usize::MAX)
        .saturating_mul(4)
        .saturating_add(path_len.saturating_mul(6))
        .saturating_add(128)
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Entry {
    pub operation: String,
    pub worktree: String,
    pub path: String,
    pub payload: Value,
}

#[cfg(test)]
pub(crate) fn entries_for(store: &Store, worktree: &Path) -> Vec<Entry> {
    let worktree = worktree.to_string_lossy().to_string();
    store
        .oplog_rows_for(&worktree)
        .unwrap()
        .into_iter()
        .filter_map(|row| {
            let payload: Value = serde_json::from_slice(row.payload.as_deref()?).ok()?;
            Some(Entry {
                operation: row.kind,
                worktree: worktree.clone(),
                path: payload["path"].as_str().unwrap_or_default().to_owned(),
                payload,
            })
        })
        .collect()
}

pub(crate) fn record(
    store: &Store,
    operation: &str,
    worktree: &Path,
    path: &str,
    mut payload: Value,
) -> Result<i64, AppError> {
    let worktree = worktree
        .to_str()
        .ok_or_else(|| AppError::validation("Worktree path is not valid UTF-8"))?;
    if let Some(object) = payload.as_object_mut() {
        object.insert("path".into(), Value::String(path.to_owned()));
    }
    let undoable = matches!(
        operation,
        "commit"
            | "sync"
            | "pull"
            | "checkout"
            | "cherry_pick"
            | "revert"
            | "discard"
            | "delete_to_trash"
            | "stash_drop"
    ) && !(operation == "delete_to_trash"
        && payload["inlineBytes"].is_null()
        && !cfg!(any(target_os = "linux", target_os = "windows")))
        && !(matches!(
            operation,
            "commit" | "pull" | "checkout" | "cherry_pick" | "revert"
        ) && payload["beforeHead"].is_null())
        && payload["payloadTooLarge"] != true;
    let payload = serde_json::to_vec(&payload)
        .map_err(|error| AppError::internal(format!("Could not encode undo data: {error}")))?;
    store
        .record_oplog(worktree, operation, &payload, undoable)
        .map_err(AppError::from)
}

pub(crate) fn remove_failed_record(store: &Store, id: i64, cause: AppError) -> AppError {
    remove_failed_records(store, &[id], cause)
}

pub(crate) fn remove_failed_records(store: &Store, ids: &[i64], cause: AppError) -> AppError {
    let cleanup_errors = ids
        .iter()
        .filter_map(|id| store.delete_oplog(*id).err())
        .map(|error| error.to_string())
        .collect::<Vec<_>>();
    if cleanup_errors.is_empty() {
        cause
    } else {
        AppError::internal(format!(
            "{}; could not remove failed operation undo records: {}",
            cause.message,
            cleanup_errors.join("; ")
        ))
    }
}

pub(crate) fn update_commit_record(
    store: &Store,
    id: i64,
    before_head: &str,
    after_head: &str,
) -> Result<(), AppError> {
    let payload = serde_json::to_vec(&json!({
        "path": "",
        "beforeHead": before_head,
        "afterHead": after_head,
    }))
    .map_err(|error| AppError::internal(format!("Could not encode undo data: {error}")))?;
    if !store.update_oplog_payload(id, &payload)? {
        return Err(AppError::internal(
            "Commit completed, but its undo record could not be found",
        ));
    }
    Ok(())
}

fn row_payload(row: &OplogRow) -> Result<Value, AppError> {
    let bytes = row
        .payload
        .as_deref()
        .ok_or_else(|| AppError::validation("This undo record has no recoverable payload"))?;
    serde_json::from_slice(bytes)
        .map_err(|error| AppError::internal(format!("Undo record is corrupt: {error}")))
}

fn relative_target(root: &Path, path: &str) -> Result<PathBuf, AppError> {
    let relative = Path::new(path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || relative
            .components()
            .any(|component| component.as_os_str() == ".git")
    {
        return Err(AppError::validation("Undo path is not worktree-relative"));
    }
    let full = root.join(relative);
    let parent = full
        .parent()
        .ok_or_else(|| AppError::validation("Undo path has no parent directory"))?;
    let existing_parent = parent
        .canonicalize()
        .map_err(|error| AppError::io(format!("Could not resolve undo path: {error}")))?;
    if !existing_parent.starts_with(root) {
        return Err(AppError::validation("Undo path escapes the worktree"));
    }
    Ok(full)
}

/// Undo writes go through the same invocation as forward writes: local checkout filters and
/// fsmonitor neutralized, inherited `GIT_DIR`-style variables scrubbed, user config kept.
fn run_git(root: &Path, args: &[&str]) -> Result<(), AppError> {
    let filters = crate::worktree::configured_checkout_filters(root)?;
    let argv: Vec<&std::ffi::OsStr> = args.iter().map(std::ffi::OsStr::new).collect();
    let output = crate::worktree::invoke_git_allowing_hooks(root, &argv, &filters)?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        Err(AppError::internal(if detail.is_empty() {
            format!(
                "Git {} failed with status {}",
                args.join(" "),
                output.status
            )
        } else {
            format!("Git {} failed: {detail}", args.join(" "))
        }))
    }
}

fn undo_commit(root: &Path, payload: &Value) -> Result<(), AppError> {
    undo_head_move(root, payload, "--soft")
}

/// Undo for pull / cherry-pick / revert. `--keep` refuses to clobber local changes in files the
/// action touched, unlike `--hard`.
fn undo_reset_keep(root: &Path, payload: &Value) -> Result<(), AppError> {
    undo_head_move(root, payload, "--keep")
}

/// Switches back to the branch (or detached commit) that was checked out before.
fn undo_checkout(root: &Path, payload: &Value) -> Result<(), AppError> {
    let (previous, _) = verified_head_move(root, payload)?;
    match payload["beforeBranch"].as_str() {
        Some(branch) if !branch.is_empty() && !branch.starts_with('-') => {
            // `--no-guess`: fail if the branch was deleted instead of recreating it from a remote.
            run_git(root, &["switch", "--no-guess", branch])
        }
        _ => run_git(root, &["switch", "--detach", previous]),
    }
}

fn undo_head_move(root: &Path, payload: &Value, mode: &str) -> Result<(), AppError> {
    let (previous, _) = verified_head_move(root, payload)?;
    run_git(root, &["reset", mode, previous])
}

/// Validates `beforeHead`/`afterHead` and that HEAD has not moved since the action ran.
fn verified_head_move<'p>(root: &Path, payload: &'p Value) -> Result<(&'p str, &'p str), AppError> {
    let previous = payload["beforeHead"]
        .as_str()
        .ok_or_else(|| AppError::validation("Undo record has no previous commit"))?;
    let expected = payload["afterHead"]
        .as_str()
        .ok_or_else(|| AppError::validation("Undo record has no resulting commit"))?;
    validate_git_sha(previous)?;
    validate_git_sha(expected)?;
    let repository = git2::Repository::open(root)?;
    let current = repository
        .head()?
        .target()
        .map(|oid| oid.to_string())
        .ok_or_else(|| AppError::validation("Cannot undo a commit without a current HEAD"))?;
    if current != expected {
        return Err(AppError::validation(
            "Cannot undo this action because HEAD has moved since it ran",
        ));
    }
    Ok((previous, expected))
}

fn validate_git_sha(sha: &str) -> Result<(), AppError> {
    if matches!(sha.len(), 40 | 64) && sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AppError::validation(
            "Undo record contains an invalid commit id",
        ))
    }
}

fn undo_discard(root: &Path, payload: &Value) -> Result<(), AppError> {
    if let Some(items) = payload["items"].as_array() {
        for item in items.iter().rev() {
            undo_discard_item(root, item)?;
        }
        return Ok(());
    }
    undo_discard_item(root, payload)
}

fn undo_discard_item(root: &Path, payload: &Value) -> Result<(), AppError> {
    let path = payload["path"]
        .as_str()
        .ok_or_else(|| AppError::validation("Undo record has no file path"))?;
    let target = relative_target(root, path)?;
    match payload["beforeWorkingTree"].as_array() {
        None => match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_dir() => {
                Err(AppError::validation("Cannot undo discard over a directory"))
            }
            Ok(_) => fs::remove_file(&target)
                .map_err(|error| AppError::io(format!("Could not remove discarded file: {error}"))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AppError::io(format!(
                "Could not inspect discarded file: {error}"
            ))),
        },
        Some(_) => {
            let bytes: Vec<u8> = serde_json::from_value(payload["beforeWorkingTree"].clone())
                .map_err(|error| AppError::internal(format!("Undo data is invalid: {error}")))?;
            replace_with_bytes(
                &target,
                &bytes,
                payload["wasSymlink"] == true,
                payload_unix_mode(payload)?,
            )
        }
    }
}

fn payload_unix_mode(payload: &Value) -> Result<Option<u32>, AppError> {
    match payload.get("unixMode") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let mode = value
                .as_u64()
                .and_then(|mode| u32::try_from(mode).ok())
                .filter(|mode| mode & !0o7777 == 0)
                .ok_or_else(|| AppError::validation("Undo record contains an invalid file mode"))?;
            Ok(Some(mode))
        }
    }
}

fn replace_with_bytes(
    target: &Path,
    bytes: &[u8],
    symlink: bool,
    unix_mode: Option<u32>,
) -> Result<(), AppError> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::io(format!("Could not create undo directory: {error}")))?;
    }
    match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.is_dir() => {
            return Err(AppError::validation(
                "Cannot restore a file over a directory",
            ));
        }
        Ok(_) => fs::remove_file(target).map_err(|error| {
            AppError::io(format!("Could not replace file during undo: {error}"))
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AppError::io(format!(
                "Could not inspect file during undo: {error}"
            )));
        }
    }
    if symlink {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            std::os::unix::fs::symlink(std::ffi::OsStr::from_bytes(bytes), target)
                .map_err(|error| AppError::io(format!("Could not restore symlink: {error}")))?;
        }
        #[cfg(not(unix))]
        return Err(AppError::internal(
            "Restoring symlinks is not supported on this platform",
        ));
    } else {
        fs::write(target, bytes)
            .map_err(|error| AppError::io(format!("Could not restore file: {error}")))?;
        #[cfg(unix)]
        if let Some(mode) = unix_mode {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(target, fs::Permissions::from_mode(mode)).map_err(|error| {
                AppError::io(format!("Could not restore file permissions: {error}"))
            })?;
        }
        #[cfg(not(unix))]
        let _ = unix_mode;
    }
    Ok(())
}

fn undo_delete(root: &Path, payload: &Value) -> Result<(), AppError> {
    let path = payload["path"]
        .as_str()
        .ok_or_else(|| AppError::validation("Undo record has no file path"))?;
    let target = relative_target(root, path)?;
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        let original = payload["absolutePath"]
            .as_str()
            .ok_or_else(|| AppError::validation("Undo record has no original path"))?;
        if Path::new(original) != target {
            return Err(AppError::validation(
                "Undo record contains an invalid original path",
            ));
        }
        if let Ok(items) = trash::os_limited::list() {
            if let Some(item) = items
                .into_iter()
                .find(|item| item.original_path() == Path::new(original))
            {
                if trash::os_limited::restore_all(&[item]).is_ok() {
                    return Ok(());
                }
            }
        }
    }
    match fs::symlink_metadata(&target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => {
            return Err(AppError::new(
                crate::error::ErrorKind::Conflict,
                "Cannot restore deleted item because the path now exists",
            ));
        }
        Err(error) => {
            return Err(AppError::io(format!(
                "Could not inspect deleted path: {error}"
            )));
        }
    }
    let bytes: Vec<u8> = serde_json::from_value(payload["inlineBytes"].clone())
        .map_err(|error| AppError::validation(format!("Trash fallback is unavailable: {error}")))?;
    replace_with_bytes(
        &target,
        &bytes,
        payload["isSymlink"] == true,
        payload_unix_mode(payload)?,
    )
}

fn apply_reverse(root: &Path, row: &OplogRow) -> Result<(), AppError> {
    let payload = row_payload(row)?;
    match row.kind.as_str() {
        "commit" | "sync" => undo_commit(root, &payload),
        "pull" | "cherry_pick" | "revert" => undo_reset_keep(root, &payload),
        "checkout" => undo_checkout(root, &payload),
        "discard" => undo_discard(root, &payload),
        "delete_to_trash" => undo_delete(root, &payload),
        "stash_drop" => {
            let sha = payload["sha"]
                .as_str()
                .ok_or_else(|| AppError::validation("Undo record has no stash commit"))?;
            validate_git_sha(sha)?;
            run_git(root, &["stash", "apply", sha])
        }
        _ => Err(AppError::validation(format!(
            "Undo is not supported for {}",
            row.kind
        ))),
    }
}

pub(crate) fn undo_last(store: &Store, worktree: &Path) -> Result<(), AppError> {
    let root = worktree
        .canonicalize()
        .map_err(|error| AppError::io(format!("Could not resolve worktree path: {error}")))?;
    let path = root
        .to_str()
        .ok_or_else(|| AppError::validation("Worktree path is not valid UTF-8"))?;
    let row = store
        .latest_oplog(path)
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::not_found("There is no action to undo for this worktree"))?;
    if !row.undoable {
        return Err(AppError::validation("The latest action cannot be undone"));
    }
    // A reset during a merge/cherry-pick/revert/rebase would silently end it and mix the undone
    // commit into the in-progress resolution.
    if git2::Repository::open(&root)?.state() != git2::RepositoryState::Clean {
        return Err(AppError::validation(
            "Finish or abort the merge, cherry-pick, revert, or rebase before undoing",
        ));
    }
    apply_reverse(&root, &row)?;
    store.delete_oplog(row.id).map_err(AppError::from)
}

pub(crate) fn delete_payload(path: &Path, absolute_path: &Path) -> Result<Value, AppError> {
    let metadata = fs::symlink_metadata(absolute_path)
        .map_err(|error| AppError::io(format!("Could not inspect file for undo: {error}")))?;
    let symlink = metadata.file_type().is_symlink();
    let unix_mode = if !symlink && metadata.is_file() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            Some(metadata.permissions().mode() & 0o7777)
        }
        #[cfg(not(unix))]
        {
            None
        }
    } else {
        None
    };
    let inline_bytes = if symlink {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            Some(
                fs::read_link(absolute_path)
                    .map_err(|error| AppError::io(format!("Could not read symlink: {error}")))?
                    .as_os_str()
                    .as_bytes()
                    .to_vec(),
            )
        }
        #[cfg(not(unix))]
        {
            None
        }
    } else if metadata.is_file() && snapshot_payload_cost(path, metadata.len()) <= OPLOG_MAX_PAYLOAD
    {
        Some(
            fs::read(absolute_path)
                .map_err(|error| AppError::io(format!("Could not read file for undo: {error}")))?,
        )
    } else {
        None
    };
    let is_inline_available = inline_bytes.is_some();
    let payload_too_large =
        metadata.is_file() && snapshot_payload_cost(path, metadata.len()) > OPLOG_MAX_PAYLOAD;
    let mut payload = json!({
        "path": path.to_string_lossy(),
        "absolutePath": absolute_path.to_string_lossy(),
        "isSymlink": symlink,
        "unixMode": unix_mode,
        "payloadTooLarge": payload_too_large,
    });
    if let Some(bytes) = inline_bytes {
        payload["inlineBytes"] = serde_json::to_value(bytes).map_err(|error| {
            AppError::internal(format!("Could not encode Trash fallback: {error}"))
        })?;
    }
    if !is_inline_available && !absolute_path.is_dir() {
        payload["inlineBytes"] = Value::Null;
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{stash, store::Store};
    use git2::Repository;
    use std::{
        path::PathBuf,
        process::{Command, Output},
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("branchwork-oplog-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git(path: &Path, args: &[&str]) -> Output {
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap()
    }

    fn init_repo(path: &Path) -> String {
        Repository::init(path).unwrap();
        assert!(
            git(path, &["config", "user.name", "Branchwork Test"])
                .status
                .success()
        );
        assert!(
            git(path, &["config", "user.email", "test@example.com"])
                .status
                .success()
        );
        fs::write(path.join("file.txt"), b"before\n").unwrap();
        assert!(git(path, &["add", "file.txt"]).status.success());
        assert!(git(path, &["commit", "-m", "initial"]).status.success());
        String::from_utf8_lossy(&git(path, &["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_owned()
    }

    fn record_discard(store: &Store, root: &Path, path: &str, before: &[u8]) {
        record(
            store,
            "discard",
            root,
            path,
            json!({ "beforeWorkingTree": before, "wasSymlink": false }),
        )
        .unwrap();
    }

    #[test]
    fn undo_commit_soft_resets_and_removes_the_row() {
        let temp = TestDir::new();
        let store = Store::in_memory().unwrap();
        let previous = init_repo(&temp.0);
        fs::write(temp.0.join("file.txt"), b"after\n").unwrap();
        assert!(git(&temp.0, &["add", "file.txt"]).status.success());
        assert!(git(&temp.0, &["commit", "-m", "second"]).status.success());
        let root = temp.0.canonicalize().unwrap();
        record(
            &store,
            "commit",
            &root,
            "",
            json!({
                "beforeHead": previous,
                "afterHead": String::from_utf8_lossy(&git(&root, &["rev-parse", "HEAD"]).stdout).trim(),
            }),
        )
        .unwrap();

        undo_last(&store, &root).unwrap();

        assert_eq!(
            String::from_utf8_lossy(&git(&root, &["rev-parse", "HEAD"]).stdout).trim(),
            previous
        );
        assert_eq!(
            store.latest_oplog_undoable(root.to_str().unwrap()).unwrap(),
            None
        );
    }

    #[test]
    fn undo_commit_refuses_to_reset_past_a_later_commit() {
        let temp = TestDir::new();
        let store = Store::in_memory().unwrap();
        let previous = init_repo(&temp.0);
        fs::write(temp.0.join("file.txt"), b"app commit\n").unwrap();
        assert!(git(&temp.0, &["add", "file.txt"]).status.success());
        assert!(
            git(&temp.0, &["commit", "-m", "app commit"])
                .status
                .success()
        );
        let app_commit = String::from_utf8_lossy(&git(&temp.0, &["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_owned();
        let root = temp.0.canonicalize().unwrap();
        record(
            &store,
            "commit",
            &root,
            "",
            json!({ "beforeHead": previous, "afterHead": app_commit }),
        )
        .unwrap();

        fs::write(root.join("external.txt"), b"external commit\n").unwrap();
        assert!(git(&root, &["add", "external.txt"]).status.success());
        assert!(
            git(&root, &["commit", "-m", "external commit"])
                .status
                .success()
        );
        let external_head = String::from_utf8_lossy(&git(&root, &["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_owned();

        let error = undo_last(&store, &root).unwrap_err();

        assert!(error.message.contains("HEAD has moved"));
        assert_eq!(
            String::from_utf8_lossy(&git(&root, &["rev-parse", "HEAD"]).stdout).trim(),
            external_head
        );
        assert_eq!(
            store.latest_oplog_undoable(root.to_str().unwrap()).unwrap(),
            Some(true)
        );
    }

    #[test]
    fn undo_discard_restores_the_stored_file_bytes() {
        let temp = TestDir::new();
        let store = Store::in_memory().unwrap();
        init_repo(&temp.0);
        let root = temp.0.canonicalize().unwrap();
        fs::write(root.join("file.txt"), b"discarded\n").unwrap();
        record_discard(&store, &root, "file.txt", b"before\n");

        undo_last(&store, &root).unwrap();

        assert_eq!(fs::read(root.join("file.txt")).unwrap(), b"before\n");
        assert_eq!(
            store.latest_oplog_undoable(root.to_str().unwrap()).unwrap(),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn undo_discard_restores_the_original_file_mode() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TestDir::new();
        let store = Store::in_memory().unwrap();
        init_repo(&temp.0);
        let root = temp.0.canonicalize().unwrap();
        let file = root.join("file.txt");
        fs::write(&file, b"discarded\n").unwrap();
        record(
            &store,
            "discard",
            &root,
            "file.txt",
            json!({
                "beforeWorkingTree": b"before\n",
                "wasSymlink": false,
                "unixMode": 0o751,
            }),
        )
        .unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();

        undo_last(&store, &root).unwrap();

        assert_eq!(
            fs::metadata(file).unwrap().permissions().mode() & 0o7777,
            0o751
        );
    }

    #[test]
    fn undo_delete_uses_the_inline_copy_when_trash_restore_is_unavailable() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let temp = TestDir::new();
        let store = Store::in_memory().unwrap();
        init_repo(&temp.0);
        let root = temp.0.canonicalize().unwrap();
        let deleted = root.join("deleted.txt");
        fs::write(&deleted, b"deleted\n").unwrap();
        #[cfg(unix)]
        fs::set_permissions(&deleted, fs::Permissions::from_mode(0o751)).unwrap();
        record(
            &store,
            "delete_to_trash",
            &root,
            "deleted.txt",
            json!({
                "absolutePath": root.join("deleted.txt").to_string_lossy(),
                "inlineBytes": b"deleted\n",
                "isSymlink": false,
                "unixMode": 0o751,
            }),
        )
        .unwrap();
        fs::remove_file(&deleted).unwrap();

        undo_last(&store, &root).unwrap();

        assert_eq!(fs::read(root.join("deleted.txt")).unwrap(), b"deleted\n");
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(deleted).unwrap().permissions().mode() & 0o7777,
            0o751
        );
    }

    #[test]
    fn undo_stash_drop_applies_the_stash_commit_by_sha() {
        let temp = TestDir::new();
        let store = Store::in_memory().unwrap();
        init_repo(&temp.0);
        fs::write(temp.0.join("file.txt"), b"stashed\n").unwrap();
        stash::stash_push(
            &temp.0,
            &stash::StashPushOptions {
                message: Some("undo me".into()),
                include_untracked: false,
            },
        )
        .unwrap();
        stash::stash_drop(&store, &temp.0, 0).unwrap();
        assert_eq!(fs::read(temp.0.join("file.txt")).unwrap(), b"before\n");

        undo_last(&store, &temp.0).unwrap();

        assert_eq!(fs::read(temp.0.join("file.txt")).unwrap(), b"stashed\n");
    }

    #[test]
    fn a_failed_reverse_keeps_the_oplog_row() {
        let temp = TestDir::new();
        let store = Store::in_memory().unwrap();
        init_repo(&temp.0);
        let root = temp.0.canonicalize().unwrap();
        fs::create_dir(root.join("directory")).unwrap();
        record_discard(&store, &root, "directory", b"cannot replace directory");

        assert!(undo_last(&store, &root).is_err());
        assert_eq!(
            store.latest_oplog_undoable(root.to_str().unwrap()).unwrap(),
            Some(true)
        );
    }

    #[test]
    fn a_non_undoable_latest_action_does_not_skip_to_an_older_entry() {
        let temp = TestDir::new();
        let store = Store::in_memory().unwrap();
        init_repo(&temp.0);
        let root = temp.0.canonicalize().unwrap();
        fs::write(root.join("file.txt"), b"discarded\n").unwrap();
        record_discard(&store, &root, "file.txt", b"before\n");
        record(
            &store,
            "fsWrite",
            &root,
            "file.txt",
            json!({ "previousBytes": b"discarded\n" }),
        )
        .unwrap();

        assert!(undo_last(&store, &root).is_err());
        assert_eq!(fs::read(root.join("file.txt")).unwrap(), b"discarded\n");
        let latest = store.latest_oplog(root.to_str().unwrap()).unwrap().unwrap();
        assert_eq!(latest.kind, "fsWrite");
        assert!(!latest.undoable);
    }
}
