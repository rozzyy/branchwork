//! Commit / push / sync writes via the user's `git` CLI (Task 07).
use crate::error::AppError;
use crate::oplog;
use crate::store::Store;
use crate::worktree;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::Output,
};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitOptions {
    pub message: String,
    pub amend: bool,
    pub stage_all: bool,
}

pub(crate) fn open_worktree(
    worktree_path: &Path,
) -> Result<(std::path::PathBuf, git2::Repository), AppError> {
    let root = worktree_path
        .canonicalize()
        .map_err(|error| AppError::io(format!("Could not resolve worktree path: {error}")))?;
    let repository = git2::Repository::open(&root).map_err(AppError::from)?;
    Ok((root, repository))
}

pub(crate) fn head_sha(repository: &git2::Repository) -> Result<Option<String>, AppError> {
    match repository.head() {
        Ok(head) => Ok(Some(head.peel_to_commit()?.id().to_string())),
        Err(error) if error.code() == git2::ErrorCode::UnbornBranch => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn rebase_abort_failure(
    store: &Store,
    record_id: i64,
    error: AppError,
    after_write: impl FnOnce(),
) -> AppError {
    let error = match store.mark_oplog_non_undoable(record_id) {
        Ok(true) => error,
        Ok(false) => AppError::internal(format!(
            "{}; sync undo record could not be found",
            error.message
        )),
        Err(update_error) => AppError::internal(format!(
            "{}; could not mark sync undo record non-undoable: {update_error}",
            error.message
        )),
    };
    after_write();
    error
}

fn stderr_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

pub(crate) fn combined_text(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    format!("{stdout}\n{stderr}").trim().to_string()
}

fn looks_like_hook_failure(text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    for hook in [
        "pre-commit",
        "prepare-commit-msg",
        "commit-msg",
        "post-commit",
        "pre-push",
        "pre-rebase",
        "post-rewrite",
    ] {
        // Git's own wording ("pre-push hook declined"); a bare hook name can be part of a
        // remote URL or path (e.g. a `pre-commit-hooks` fork).
        if lower.contains(&format!("{hook} hook")) {
            return Some(hook);
        }
    }
    if lower.contains("hook declined") || lower.contains("hook failed") {
        return Some("git");
    }
    None
}

/// Git does not print which hook failed when the hook itself exits silently, so fall back to
/// checking the repository's hook directory when a write fails for a non-hook reason.
fn hooks_for_operation(operation: &str) -> &'static [&'static str] {
    match operation {
        "commit" => &[
            "pre-commit",
            "prepare-commit-msg",
            "commit-msg",
            "post-commit",
        ],
        "push" => &["pre-push"],
        "rebase" => &["pre-rebase", "post-rewrite"],
        _ => &[],
    }
}

fn hooks_directory(root: &Path, repository: &git2::Repository) -> Option<PathBuf> {
    let configured = repository
        .config()
        .ok()
        .and_then(|config| config.get_string("core.hooksPath").ok());
    let directory = match configured {
        Some(value) => {
            let path = Path::new(&value);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                root.join(path)
            }
        }
        None => repository.commondir().join("hooks"),
    };
    (directory != Path::new("/dev/null")).then_some(directory)
}

fn is_executable_hook(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

fn installed_hook(
    root: &Path,
    repository: &git2::Repository,
    operation: &str,
) -> Option<&'static str> {
    let directory = hooks_directory(root, repository)?;
    hooks_for_operation(operation)
        .iter()
        .copied()
        .find(|hook| is_executable_hook(&directory.join(hook)))
}

fn looks_like_plain_git_error(text: &str) -> bool {
    [
        "nothing to commit",
        "no changes added to commit",
        "nothing added to commit",
        "please tell me who you are",
        "author identity unknown",
        "unable to auto-detect email",
        "empty commit message",
        "not a git repository",
        "could not resolve head",
        "rejected",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn looks_like_auth_failure(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("permission denied (publickey)")
        || lower.contains("invalid username or password")
        // HTTP status only in git's own wording: a bare "401"/"403" also appears in paths,
        // commit subjects, and abbreviated SHAs.
        || lower.contains("returned error: 401")
        || lower.contains("returned error: 403")
        || lower.contains("terminal prompts disabled")
        || lower.contains("repository not found")
}

fn looks_like_network_failure(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "could not resolve host",
        "could not resolve hostname",
        "failed to connect",
        "connection refused",
        "connection timed out",
        "operation timed out",
        "network is unreachable",
        "connection reset",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// Caps git output carried in `AppError.detail` so a noisy remote cannot flood IPC/UI state.
const MAX_DETAIL_BYTES: usize = 16 * 1024;

pub(crate) fn bounded(mut error: AppError) -> AppError {
    if let Some(detail) = error.detail.as_mut()
        && detail.len() > MAX_DETAIL_BYTES
    {
        let mut end = MAX_DETAIL_BYTES;
        while !detail.is_char_boundary(end) {
            end -= 1;
        }
        detail.truncate(end);
        detail.push_str("\n…");
    }
    error
}

/// Operations that stop in a merge/cherry-pick/revert/rebase state when they conflict.
fn stops_on_conflict(operation: &str) -> bool {
    matches!(
        operation,
        "pull" | "cherry-pick" | "revert" | "rebase" | "merge"
    )
}

pub(crate) fn classify_git_failure(
    root: &Path,
    repository: &git2::Repository,
    operation: &str,
    output: &Output,
) -> AppError {
    let detail = stderr_text(output);
    let combined = combined_text(output);
    let lower = combined.to_ascii_lowercase();
    // Conflicts first, from repository state: merge output lists paths and subjects (e.g.
    // `.pre-commit-config.yaml`) that must not be read as hook or auth failures. The detail
    // keeps stdout, where git prints the `CONFLICT …` lines.
    if stops_on_conflict(operation)
        && (repository.state() != git2::RepositoryState::Clean
            || lower.contains("automatic merge failed")
            || lower.contains("could not apply"))
    {
        return AppError::git_conflict(format!("Git {operation} conflicted"), combined);
    }
    // Hook, auth and network wording is git's own and goes to stderr.
    if let Some(hook) = looks_like_hook_failure(&detail) {
        return AppError::git_hook(hook, detail);
    }
    if looks_like_auth_failure(&detail) {
        return AppError::git_auth(
            format!("Git {operation} failed: authentication required"),
            detail,
        );
    }
    if looks_like_network_failure(&detail) {
        return AppError::network(
            format!("Git {operation} failed: the remote could not be reached"),
            detail,
        );
    }
    if lower.contains("conflict") {
        return AppError::git_conflict(format!("Git {operation} conflicted"), combined);
    }
    if let Some(hook) =
        installed_hook(root, repository, operation).filter(|_| !looks_like_plain_git_error(&lower))
    {
        return AppError::git_hook(hook, detail);
    }
    // Generic failure: a short message, with git's full output behind "Show details".
    let mut error = AppError::internal(format!("Git {operation} failed"));
    error.detail = (!combined.is_empty()).then_some(combined);
    error.recoverable = true;
    error
}

pub(crate) fn run_git(root: &Path, args: &[&OsStr]) -> Result<Output, AppError> {
    let filters = worktree::configured_checkout_filters(root)?;
    worktree::invoke_git_allowing_hooks(root, args, &filters)
}

pub(crate) fn require_success(
    root: &Path,
    repository: &git2::Repository,
    operation: &str,
    output: Output,
) -> Result<(), AppError> {
    if output.status.success() {
        Ok(())
    } else {
        Err(bounded(classify_git_failure(
            root, repository, operation, &output,
        )))
    }
}

fn record_before_head(
    store: &Store,
    root: &Path,
    repository: &git2::Repository,
    operation: &str,
) -> Result<(i64, Option<String>), AppError> {
    let before = head_sha(repository)?;
    let record_id = oplog::record(
        store,
        operation,
        root,
        "",
        serde_json::json!({ "beforeHead": before }),
    )?;
    Ok((record_id, before))
}

fn update_commit_record(
    store: &Store,
    record_id: i64,
    root: &Path,
    before_head: Option<&str>,
) -> Result<(), AppError> {
    let Some(before_head) = before_head else {
        return Ok(());
    };
    let after_head = open_worktree(root)
        .and_then(|(_, repository)| head_sha(&repository))?
        .ok_or_else(|| AppError::internal("Commit completed without creating a HEAD"))?;
    if let Err(error) = oplog::update_commit_record(store, record_id, before_head, &after_head) {
        return Err(oplog::remove_failed_record(
            store,
            record_id,
            AppError::internal(format!(
                "Commit completed, but its undo record could not be updated: {}",
                error.message
            )),
        ));
    }
    Ok(())
}

fn write_commit(
    root: &Path,
    repository: &git2::Repository,
    options: &CommitOptions,
) -> Result<(), AppError> {
    if options.stage_all {
        let output = run_git(root, &[OsStr::new("add"), OsStr::new("-A")])?;
        require_success(root, repository, "add", output)?;
    }

    let message = options.message.trim();
    let mut args: Vec<std::ffi::OsString> = vec!["commit".into()];
    if options.amend && message.is_empty() {
        args.push("--amend".into());
        args.push("--no-edit".into());
    } else if options.amend {
        args.push("--amend".into());
        args.push("-m".into());
        args.push(message.into());
    } else {
        args.push("-m".into());
        args.push(message.into());
    }
    let args_ref: Vec<&OsStr> = args.iter().map(AsRef::as_ref).collect();
    let output = run_git(root, &args_ref)?;
    require_success(root, repository, "commit", output)
}

pub(crate) fn commit(
    store: &Store,
    worktree_path: &Path,
    options: &CommitOptions,
) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    let message = options.message.trim();
    if message.is_empty() && !options.amend {
        return Err(AppError::validation("Commit message must not be empty"));
    }

    let (record_id, before_head) = record_before_head(store, &root, &repository, "commit")?;
    if let Err(error) = write_commit(&root, &repository, options) {
        return Err(oplog::remove_failed_record(store, record_id, error));
    }
    update_commit_record(store, record_id, &root, before_head.as_deref())
}

pub(crate) fn commit_and_push_with_callback(
    store: &Store,
    worktree_path: &Path,
    options: &CommitOptions,
    after_commit: impl FnOnce(),
) -> Result<(), AppError> {
    commit(store, worktree_path, options)?;
    after_commit();
    let (root, repository) = open_worktree(worktree_path)?;
    let output = run_git(&root, &[OsStr::new("push")])?;
    require_success(&root, &repository, "push", output)
}

pub(crate) fn commit_and_sync_with_callback(
    store: &Store,
    worktree_path: &Path,
    options: &CommitOptions,
    mut after_write: impl FnMut(),
) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;

    // Record before fetch/rebase/commit so undo can return to the pre-sync HEAD.
    let (record_id, before_head) = record_before_head(store, &root, &repository, "sync")?;

    let fetch = run_git(&root, &[OsStr::new("fetch"), OsStr::new("--prune")])
        .map_err(|error| oplog::remove_failed_record(store, record_id, error))?;
    require_success(&root, &repository, "fetch", fetch)
        .map_err(|error| oplog::remove_failed_record(store, record_id, error))?;

    let rebase = run_git(&root, &[OsStr::new("rebase")])
        .map_err(|error| oplog::remove_failed_record(store, record_id, error))?;
    if !rebase.status.success() {
        let detail = combined_text(&rebase);
        let aborted = run_git(&root, &[OsStr::new("rebase"), OsStr::new("--abort")]);
        if let Err(error) = aborted {
            let error = AppError::internal(format!(
                "Rebase conflicted and could not be aborted: {error}"
            ));
            return Err(rebase_abort_failure(store, record_id, error, after_write));
        }
        let lower = detail.to_ascii_lowercase();
        if lower.contains("conflict") || lower.contains("could not apply") {
            return Err(oplog::remove_failed_record(
                store,
                record_id,
                AppError::git_conflict(
                    "Rebase conflicted while syncing; the rebase was aborted",
                    stderr_text(&rebase),
                ),
            ));
        }
        return Err(oplog::remove_failed_record(
            store,
            record_id,
            classify_git_failure(&root, &repository, "rebase", &rebase),
        ));
    }

    update_commit_record(store, record_id, &root, before_head.as_deref())?;
    after_write();
    let message = options.message.trim();
    let should_commit = options.amend || !message.is_empty();
    if should_commit {
        write_commit(&root, &repository, options)?;
        update_commit_record(store, record_id, &root, before_head.as_deref())?;
        after_write();
    }

    let push = run_git(&root, &[OsStr::new("push")])?;
    require_success(&root, &repository, "push", push)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use git2::Signature;
    use std::sync::OnceLock;
    use std::{
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicUsize, Ordering},
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
                "branchwork-m2-commit-{label}-{}-{id}",
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
        // Identity for CLI commits; keep hooks able to run from .git/hooks.
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

    fn head_message(path: &Path) -> String {
        let repository = git2::Repository::open(path).unwrap();
        repository
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .message()
            .unwrap_or("")
            .trim()
            .to_owned()
    }

    fn head_id(path: &Path) -> String {
        let repository = git2::Repository::open(path).unwrap();
        repository
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id()
            .to_string()
    }

    fn stage_file(path: &Path, name: &str, contents: &[u8]) {
        fs::write(path.join(name), contents).unwrap();
        let output = git(path, &["add", "--", name]);
        assert!(output.status.success(), "{}", stderr_text(&output));
    }

    #[test]
    fn commits_staged_changes_and_records_before_head() {
        let temp = TestDir::new("plain");
        let repository = init_repo(&temp.0);
        let before = head_id(&temp.0);
        stage_file(&temp.0, "README.md", b"two\n");

        commit(
            test_store(),
            &temp.0,
            &CommitOptions {
                message: "update readme".into(),
                amend: false,
                stage_all: false,
            },
        )
        .unwrap();

        assert_eq!(head_message(&temp.0), "update readme");
        let entry = oplog::entries_for(test_store(), &temp.0.canonicalize().unwrap())
            .into_iter()
            .rev()
            .find(|entry| entry.operation == "commit")
            .expect("oplog commit row");
        assert_eq!(entry.payload["beforeHead"], before);
        assert_eq!(entry.payload["afterHead"], head_id(&temp.0));
        drop(repository);
    }

    #[test]
    fn amend_with_empty_message_reuses_previous_message() {
        let temp = TestDir::new("amend");
        init_repo(&temp.0);
        stage_file(&temp.0, "README.md", b"two\n");
        commit(
            test_store(),
            &temp.0,
            &CommitOptions {
                message: "second".into(),
                amend: false,
                stage_all: false,
            },
        )
        .unwrap();
        stage_file(&temp.0, "README.md", b"three\n");
        commit(
            test_store(),
            &temp.0,
            &CommitOptions {
                message: String::new(),
                amend: true,
                stage_all: false,
            },
        )
        .unwrap();
        assert_eq!(head_message(&temp.0), "second");
    }

    #[test]
    fn stage_all_includes_untracked_files() {
        let temp = TestDir::new("stage-all");
        init_repo(&temp.0);
        fs::write(temp.0.join("README.md"), b"edited\n").unwrap();
        fs::write(temp.0.join("new.txt"), b"fresh\n").unwrap();
        commit(
            test_store(),
            &temp.0,
            &CommitOptions {
                message: "everything".into(),
                amend: false,
                stage_all: true,
            },
        )
        .unwrap();
        let repository = git2::Repository::open(&temp.0).unwrap();
        let tree = repository
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap();
        assert!(tree.get_name("new.txt").is_some());
    }

    #[test]
    fn pre_commit_hook_failure_surfaces_as_git_hook() {
        let temp = TestDir::new("hook");
        init_repo(&temp.0);
        let hooks = temp.0.join(".git/hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        fs::write(&hook, b"#!/bin/sh\necho hook-blocked >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&hook).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&hook, perms).unwrap();
        }
        stage_file(&temp.0, "README.md", b"hooked\n");
        let error = commit(
            test_store(),
            &temp.0,
            &CommitOptions {
                message: "should fail".into(),
                amend: false,
                stage_all: false,
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::GitHook);
        assert!(error.message.contains("pre-commit"));
        assert!(
            error
                .detail
                .as_deref()
                .unwrap_or("")
                .contains("hook-blocked")
        );
        assert_eq!(
            test_store()
                .latest_oplog_undoable(temp.0.canonicalize().unwrap().to_str().unwrap())
                .unwrap(),
            None
        );
    }

    #[test]
    fn failed_rebase_abort_disables_the_incomplete_sync_undo_record() {
        let store = Store::in_memory().unwrap();
        let record_id = store
            .record_oplog("/repo", "sync", br#"{"beforeHead":"abc"}"#, true)
            .unwrap();
        let mut refreshed_undoable = None;

        let error = rebase_abort_failure(
            &store,
            record_id,
            AppError::internal("Rebase conflicted and could not be aborted"),
            || refreshed_undoable = store.latest_oplog_undoable("/repo").unwrap(),
        );

        assert!(error.message.contains("could not be aborted"));
        assert_eq!(refreshed_undoable, Some(false));
        let row = store.latest_oplog("/repo").unwrap().unwrap();
        assert_eq!(row.id, record_id);
        assert!(!row.undoable);
    }

    #[test]
    fn commit_and_push_updates_a_local_bare_remote() {
        let temp = TestDir::new("push");
        init_repo(&temp.0);
        let bare = TestDir::new("bare");
        // Convert-style bare remote via clone --bare.
        let clone = Command::new("git")
            .args(["clone", "--bare"])
            .arg(&temp.0)
            .arg(&bare.0)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(clone.status.success(), "{}", stderr_text(&clone));
        // Re-init working copy remote to the bare repo.
        let work = TestDir::new("push-work");
        let work_clone = Command::new("git")
            .args(["clone"])
            .arg(&bare.0)
            .arg(&work.0)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(work_clone.status.success(), "{}", stderr_text(&work_clone));
        git(&work.0, &["config", "user.name", "Branchwork Test"]);
        git(&work.0, &["config", "user.email", "test@example.com"]);
        stage_file(&work.0, "README.md", b"pushed\n");
        commit_and_push_with_callback(
            test_store(),
            &work.0,
            &CommitOptions {
                message: "push me".into(),
                amend: false,
                stage_all: false,
            },
            || {},
        )
        .unwrap();
        let remote_head = git2::Repository::open(&bare.0)
            .unwrap()
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .message()
            .unwrap_or("")
            .trim()
            .to_owned();
        assert_eq!(remote_head, "push me");
    }

    #[test]
    fn push_to_unreachable_remote_surfaces_as_network() {
        let temp = TestDir::new("auth");
        let repository = init_repo(&temp.0);
        let branch = repository.head().unwrap().shorthand().unwrap().to_owned();
        git(
            &temp.0,
            &[
                "remote",
                "add",
                "origin",
                "https://127.0.0.1:1/branchwork-missing.git",
            ],
        );
        git(
            &temp.0,
            &["config", &format!("branch.{branch}.remote"), "origin"],
        );
        git(
            &temp.0,
            &[
                "config",
                &format!("branch.{branch}.merge"),
                &format!("refs/heads/{branch}"),
            ],
        );
        stage_file(&temp.0, "README.md", b"auth\n");
        let error = commit_and_push_with_callback(
            test_store(),
            &temp.0,
            &CommitOptions {
                message: "auth fail".into(),
                amend: false,
                stage_all: false,
            },
            || {},
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Network);
    }

    #[test]
    fn commit_and_push_notifies_after_commit_even_when_push_fails() {
        let temp = TestDir::new("push-failure-notify");
        init_repo(&temp.0);
        stage_file(&temp.0, "README.md", b"committed\n");
        let mut notified = false;

        let result = commit_and_push_with_callback(
            test_store(),
            &temp.0,
            &CommitOptions {
                message: "commit before failed push".into(),
                amend: false,
                stage_all: false,
            },
            || notified = true,
        );

        assert!(result.is_err());
        assert!(notified);
        assert_eq!(head_message(&temp.0), "commit before failed push");
    }

    #[test]
    fn empty_message_without_amend_is_rejected() {
        let temp = TestDir::new("empty");
        init_repo(&temp.0);
        let error = commit(
            test_store(),
            &temp.0,
            &CommitOptions {
                message: "   ".into(),
                amend: false,
                stage_all: false,
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Validation);
    }

    #[test]
    fn first_commit_in_an_empty_repository_succeeds() {
        let store = Store::in_memory().unwrap();
        let temp = TestDir::new("first-commit");
        git2::Repository::init(&temp.0).unwrap();
        git(&temp.0, &["config", "user.name", "Branchwork Test"]);
        git(&temp.0, &["config", "user.email", "test@example.com"]);
        fs::write(temp.0.join("a.txt"), b"a\n").unwrap();
        git(&temp.0, &["add", "a.txt"]);

        commit(
            &store,
            &temp.0,
            &CommitOptions {
                message: "first".into(),
                amend: false,
                stage_all: false,
            },
        )
        .unwrap();

        assert_eq!(head_message(&temp.0), "first");
        let path = temp.0.canonicalize().unwrap();
        let row = store.latest_oplog(path.to_str().unwrap()).unwrap();
        let row = row.expect("the first commit records an oplog row");
        assert!(
            !row.undoable,
            "a first commit has no previous HEAD to return to"
        );
    }
}
