//! Stash list/apply/pop/drop reads and writes (Task 08).
use crate::{error::AppError, oplog, store::Store, worktree};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Output,
};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
    pub time: i64,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StashPushOptions {
    pub message: Option<String>,
    pub include_untracked: bool,
}

fn open_worktree(worktree_path: &Path) -> Result<(PathBuf, git2::Repository), AppError> {
    let root = worktree_path
        .canonicalize()
        .map_err(|error| AppError::io(format!("Could not resolve worktree path: {error}")))?;
    let repository = git2::Repository::open(&root).map_err(AppError::from)?;
    Ok((root, repository))
}

fn run_git(root: &Path, args: &[&OsStr]) -> Result<Output, AppError> {
    let filters = worktree::configured_checkout_filters(root)?;
    worktree::invoke_git_allowing_hooks(root, args, &filters)
}

fn require_success(operation: &str, output: Output) -> Result<(), AppError> {
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(AppError::internal(if detail.is_empty() {
        format!("Git {operation} failed with status {}", output.status)
    } else {
        format!("Git {operation} failed: {detail}")
    }))
}

fn stash_reference(index: usize) -> String {
    format!("stash@{{{index}}}")
}

fn branch_from_message(message: &str) -> String {
    let rest = message
        .strip_prefix("WIP on ")
        .or_else(|| message.strip_prefix("On "));
    rest.and_then(|rest| rest.split(':').next())
        .unwrap_or("")
        .to_owned()
}

fn read_stashes(_root: &Path, repository: &git2::Repository) -> Result<Vec<StashEntry>, AppError> {
    let reflog = match repository.reflog("refs/stash") {
        Ok(reflog) => reflog,
        Err(error) if error.code() == git2::ErrorCode::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut entries = Vec::with_capacity(reflog.len());
    for (index, entry) in reflog.iter().enumerate() {
        let message = entry
            .message()
            .ok()
            .flatten()
            .unwrap_or_default()
            .to_owned();
        entries.push(StashEntry {
            index,
            branch: branch_from_message(&message),
            message,
            time: entry.committer().when().seconds(),
        });
    }
    Ok(entries)
}

pub(crate) fn stash_list(worktree_path: &Path) -> Result<Vec<StashEntry>, AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    read_stashes(&root, &repository)
}

pub(crate) fn stash_push(worktree_path: &Path, options: &StashPushOptions) -> Result<(), AppError> {
    let (root, _) = open_worktree(worktree_path)?;
    let mut args: Vec<OsString> = vec!["stash".into(), "push".into()];
    if let Some(message) = options
        .message
        .as_deref()
        .map(str::trim)
        .filter(|message| !message.is_empty())
    {
        args.push("-m".into());
        args.push(message.into());
    }
    if options.include_untracked {
        args.push("--include-untracked".into());
    }
    let args: Vec<&OsStr> = args.iter().map(AsRef::as_ref).collect();
    require_success("stash push", run_git(&root, &args)?)
}

pub(crate) fn stash_apply(worktree_path: &Path, index: usize) -> Result<(), AppError> {
    let (root, _) = open_worktree(worktree_path)?;
    let reference = stash_reference(index);
    require_success(
        "stash apply",
        run_git(
            &root,
            &[
                OsStr::new("stash"),
                OsStr::new("apply"),
                OsStr::new(&reference),
            ],
        )?,
    )
}

pub(crate) fn stash_pop(worktree_path: &Path, index: usize) -> Result<(), AppError> {
    let (root, _) = open_worktree(worktree_path)?;
    let reference = stash_reference(index);
    require_success(
        "stash pop",
        run_git(
            &root,
            &[
                OsStr::new("stash"),
                OsStr::new("pop"),
                OsStr::new(&reference),
            ],
        )?,
    )
}

pub(crate) fn stash_drop(
    store: &Store,
    worktree_path: &Path,
    index: usize,
) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    let entry = read_stashes(&root, &repository)?
        .into_iter()
        .find(|entry| entry.index == index)
        .ok_or_else(|| AppError::validation("Stash index is out of range"))?;
    let reference = stash_reference(index);
    let resolved = run_git(
        &root,
        &[
            OsStr::new("rev-parse"),
            OsStr::new("--verify"),
            OsStr::new(&reference),
        ],
    )?;
    if !resolved.status.success() {
        let detail = String::from_utf8_lossy(&resolved.stderr).trim().to_string();
        return Err(AppError::internal(format!(
            "Could not resolve {reference}: {detail}"
        )));
    }
    let sha = String::from_utf8_lossy(&resolved.stdout).trim().to_owned();
    let record_id = oplog::record(
        store,
        "stash_drop",
        &root,
        "",
        json!({
            "sha": sha,
            "message": entry.message,
            "time": entry.time,
        }),
    )?;
    let output = run_git(
        &root,
        &[
            OsStr::new("stash"),
            OsStr::new("drop"),
            OsStr::new(&reference),
        ],
    )
    .map_err(|error| oplog::remove_failed_record(store, record_id, error))?;
    require_success("stash drop", output)
        .map_err(|error| oplog::remove_failed_record(store, record_id, error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;
    use std::{
        fs,
        process::Command,
        sync::{
            OnceLock,
            atomic::{AtomicUsize, Ordering},
        },
    };

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);
    static STORE: OnceLock<Store> = OnceLock::new();

    fn test_store() -> &'static Store {
        STORE.get_or_init(|| Store::in_memory().unwrap())
    }

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "branchwork-m2-stash-{label}-{}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git(cwd: &Path, args: &[&str]) -> Output {
        Command::new("git")
            .args(["-C"])
            .arg(cwd)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap()
    }

    fn init_repo(path: &Path) -> git2::Repository {
        let repository = git2::Repository::init(path).unwrap();
        git(path, &["config", "user.name", "Branchwork Test"]);
        git(path, &["config", "user.email", "test@example.com"]);
        fs::write(path.join("README.md"), b"one\n").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = Signature::now("Branchwork Test", "test@example.com").unwrap();
        repository
            .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
        drop(tree);
        repository
    }

    fn push(path: &Path, message: Option<&str>, include_untracked: bool) {
        stash_push(
            path,
            &StashPushOptions {
                message: message.map(str::to_owned),
                include_untracked,
            },
        )
        .unwrap();
    }

    fn rev_parse(path: &Path, reference: &str) -> String {
        let output = git(path, &["rev-parse", "--verify", reference]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    #[test]
    fn push_stashes_tracked_changes_but_keeps_untracked_by_default() {
        let temp = TestDir::new("tracked");
        init_repo(&temp.0);
        fs::write(temp.0.join("README.md"), b"two\n").unwrap();
        fs::write(temp.0.join("note.txt"), b"untracked\n").unwrap();

        push(&temp.0, Some("one"), false);

        assert_eq!(fs::read(temp.0.join("README.md")).unwrap(), b"one\n");
        assert!(temp.0.join("note.txt").exists());
        let entries = stash_list(&temp.0).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].index, 0);
        assert!(entries[0].message.contains("one"));
        let branch =
            String::from_utf8_lossy(&git(&temp.0, &["rev-parse", "--abbrev-ref", "HEAD"]).stdout)
                .trim()
                .to_owned();
        assert_eq!(entries[0].branch, branch);
        assert!(entries[0].time > 0);
    }

    #[test]
    fn push_with_untracked_removes_it_and_apply_restores_both() {
        let temp = TestDir::new("untracked");
        init_repo(&temp.0);
        fs::write(temp.0.join("README.md"), b"two\n").unwrap();
        fs::write(temp.0.join("note.txt"), b"untracked\n").unwrap();

        push(&temp.0, Some("with-untracked"), true);
        assert_eq!(fs::read(temp.0.join("README.md")).unwrap(), b"one\n");
        assert!(!temp.0.join("note.txt").exists());

        stash_apply(&temp.0, 0).unwrap();
        assert_eq!(fs::read(temp.0.join("README.md")).unwrap(), b"two\n");
        assert_eq!(fs::read(temp.0.join("note.txt")).unwrap(), b"untracked\n");
        assert_eq!(stash_list(&temp.0).unwrap().len(), 1);
    }

    #[test]
    fn list_returns_most_recent_first() {
        let temp = TestDir::new("order");
        init_repo(&temp.0);
        fs::write(temp.0.join("README.md"), b"two\n").unwrap();
        push(&temp.0, Some("first"), false);
        fs::write(temp.0.join("README.md"), b"three\n").unwrap();
        push(&temp.0, Some("second"), false);

        let entries = stash_list(&temp.0).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].index, 0);
        assert!(entries[0].message.contains("second"));
        assert_eq!(entries[1].index, 1);
        assert!(entries[1].message.contains("first"));
    }

    #[test]
    fn pop_restores_working_tree_and_removes_the_stash() {
        let temp = TestDir::new("pop");
        init_repo(&temp.0);
        fs::write(temp.0.join("README.md"), b"two\n").unwrap();
        push(&temp.0, Some("pop-me"), false);
        assert_eq!(fs::read(temp.0.join("README.md")).unwrap(), b"one\n");

        stash_pop(&temp.0, 0).unwrap();

        assert_eq!(fs::read(temp.0.join("README.md")).unwrap(), b"two\n");
        assert!(stash_list(&temp.0).unwrap().is_empty());
    }

    #[test]
    fn drop_writes_the_recovery_row_before_dropping() {
        let temp = TestDir::new("drop");
        init_repo(&temp.0);
        fs::write(temp.0.join("README.md"), b"two\n").unwrap();
        push(&temp.0, Some("drop-me"), false);
        let sha = rev_parse(&temp.0, "stash@{0}");
        let root = temp.0.canonicalize().unwrap();

        stash_drop(test_store(), &temp.0, 0).unwrap();

        assert!(stash_list(&temp.0).unwrap().is_empty());
        let entry = oplog::entries_for(test_store(), &root)
            .into_iter()
            .find(|entry| entry.operation == "stash_drop")
            .expect("stash_drop oplog row");
        assert_eq!(entry.payload["sha"], sha);
        assert!(
            entry.payload["message"]
                .as_str()
                .unwrap()
                .contains("drop-me")
        );
        assert!(entry.payload["time"].as_i64().unwrap() > 0);
    }

    #[test]
    fn failed_stash_drop_removes_its_undo_record() {
        let temp = TestDir::new("drop-failure");
        init_repo(&temp.0);
        fs::write(temp.0.join("README.md"), b"two\n").unwrap();
        push(&temp.0, Some("blocked-drop"), false);
        let root = temp.0.canonicalize().unwrap();
        let store = Store::in_memory().unwrap();
        fs::write(root.join(".git/refs/stash.lock"), b"locked").unwrap();

        assert!(stash_drop(&store, &temp.0, 0).is_err());
        assert_eq!(stash_list(&temp.0).unwrap().len(), 1);
        assert_eq!(
            store.latest_oplog_undoable(root.to_str().unwrap()).unwrap(),
            None
        );
    }

    #[test]
    fn a_dropped_stash_can_be_reapplied_by_sha() {
        let temp = TestDir::new("recover");
        init_repo(&temp.0);
        fs::write(temp.0.join("README.md"), b"two\n").unwrap();
        push(&temp.0, Some("recover-me"), false);
        let sha = rev_parse(&temp.0, "stash@{0}");
        stash_drop(test_store(), &temp.0, 0).unwrap();
        assert!(stash_list(&temp.0).unwrap().is_empty());

        let output = git(&temp.0, &["stash", "apply", &sha]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(temp.0.join("README.md")).unwrap(), b"two\n");
    }
}
