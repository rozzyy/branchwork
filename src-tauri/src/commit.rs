//! Commit / push / sync writes via the user's `git` CLI (Task 07).
use crate::error::AppError;
use crate::oplog;
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

fn open_worktree(worktree_path: &Path) -> Result<(std::path::PathBuf, git2::Repository), AppError> {
    let root = worktree_path
        .canonicalize()
        .map_err(|error| AppError::io(format!("Could not resolve worktree path: {error}")))?;
    let repository = git2::Repository::open(&root).map_err(AppError::from)?;
    Ok((root, repository))
}

fn head_sha(repository: &git2::Repository) -> Result<Option<String>, AppError> {
    match repository.head() {
        Ok(head) => Ok(Some(head.peel_to_commit()?.id().to_string())),
        Err(error) if error.code() == git2::ErrorCode::UnbornBranch => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn stderr_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

fn combined_text(output: &Output) -> String {
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
        if lower.contains(hook)
            && (lower.contains("hook") || lower.contains("failed") || lower.contains("declined"))
        {
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
        || lower.contains("403")
        || lower.contains("401")
        || lower.contains("terminal prompts disabled")
        || lower.contains("could not resolve host")
        || lower.contains("failed to connect")
        || lower.contains("connection refused")
        || lower.contains("repository not found")
}

fn classify_git_failure(
    root: &Path,
    repository: &git2::Repository,
    operation: &str,
    output: &Output,
) -> AppError {
    let detail = stderr_text(output);
    let combined = combined_text(output);
    let lower = combined.to_ascii_lowercase();
    if let Some(hook) = looks_like_hook_failure(&combined) {
        return AppError::git_hook(hook, detail);
    }
    if looks_like_auth_failure(&combined) {
        return AppError::git_auth(
            format!("Git {operation} failed: authentication required"),
            detail,
        );
    }
    if lower.contains("conflict") {
        return AppError::git_conflict(format!("Git {operation} conflicted"), detail);
    }
    if let Some(hook) =
        installed_hook(root, repository, operation).filter(|_| !looks_like_plain_git_error(&lower))
    {
        return AppError::git_hook(hook, detail);
    }
    AppError::internal(if detail.is_empty() {
        format!("Git {operation} failed with status {}", output.status)
    } else {
        format!("Git {operation} failed: {detail}")
    })
}

fn run_git(root: &Path, args: &[&OsStr]) -> Result<Output, AppError> {
    let filters = worktree::configured_checkout_filters(root)?;
    worktree::invoke_git_allowing_hooks(root, args, &filters)
}

fn require_success(
    root: &Path,
    repository: &git2::Repository,
    operation: &str,
    output: Output,
) -> Result<(), AppError> {
    if output.status.success() {
        Ok(())
    } else {
        Err(classify_git_failure(root, repository, operation, &output))
    }
}

fn record_before_head(
    root: &Path,
    repository: &git2::Repository,
    operation: &str,
) -> Result<(), AppError> {
    let before = head_sha(repository)?;
    oplog::record(
        operation,
        root,
        "",
        serde_json::json!({ "beforeHead": before }),
    )
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

pub(crate) fn commit(worktree_path: &Path, options: &CommitOptions) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    let message = options.message.trim();
    if message.is_empty() && !options.amend {
        return Err(AppError::validation("Commit message must not be empty"));
    }

    record_before_head(&root, &repository, "commit")?;
    write_commit(&root, &repository, options)
}

pub(crate) fn commit_and_push(
    worktree_path: &Path,
    options: &CommitOptions,
) -> Result<(), AppError> {
    commit(worktree_path, options)?;
    let (root, repository) = open_worktree(worktree_path)?;
    let output = run_git(&root, &[OsStr::new("push")])?;
    require_success(&root, &repository, "push", output)
}

pub(crate) fn commit_and_sync(
    worktree_path: &Path,
    options: &CommitOptions,
) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;

    // Record before fetch/rebase/commit so undo can return to the pre-sync HEAD.
    record_before_head(&root, &repository, "sync")?;

    let fetch = run_git(&root, &[OsStr::new("fetch"), OsStr::new("--prune")])?;
    require_success(&root, &repository, "fetch", fetch)?;

    let rebase = run_git(&root, &[OsStr::new("rebase")])?;
    if !rebase.status.success() {
        let detail = combined_text(&rebase);
        let aborted = run_git(&root, &[OsStr::new("rebase"), OsStr::new("--abort")]);
        if let Err(error) = aborted {
            return Err(AppError::internal(format!(
                "Rebase conflicted and could not be aborted: {error}"
            )));
        }
        let lower = detail.to_ascii_lowercase();
        if lower.contains("conflict") || lower.contains("could not apply") {
            return Err(AppError::git_conflict(
                "Rebase conflicted while syncing; the rebase was aborted",
                stderr_text(&rebase),
            ));
        }
        return Err(classify_git_failure(&root, &repository, "rebase", &rebase));
    }

    let message = options.message.trim();
    let should_commit = options.amend || !message.is_empty();
    if should_commit {
        write_commit(&root, &repository, options)?;
    }

    let push = run_git(&root, &[OsStr::new("push")])?;
    require_success(&root, &repository, "push", push)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use git2::Signature;
    use std::{
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

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
            &temp.0,
            &CommitOptions {
                message: "update readme".into(),
                amend: false,
                stage_all: false,
            },
        )
        .unwrap();

        assert_eq!(head_message(&temp.0), "update readme");
        let entry = oplog::entries_for(&temp.0.canonicalize().unwrap())
            .into_iter()
            .rev()
            .find(|entry| entry.operation == "commit")
            .expect("oplog commit row");
        assert_eq!(entry.payload["beforeHead"], before);
        drop(repository);
    }

    #[test]
    fn amend_with_empty_message_reuses_previous_message() {
        let temp = TestDir::new("amend");
        init_repo(&temp.0);
        stage_file(&temp.0, "README.md", b"two\n");
        commit(
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
        commit_and_push(
            &work.0,
            &CommitOptions {
                message: "push me".into(),
                amend: false,
                stage_all: false,
            },
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
    fn push_auth_failure_surfaces_as_git_auth() {
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
        let error = commit_and_push(
            &temp.0,
            &CommitOptions {
                message: "auth fail".into(),
                amend: false,
                stage_all: false,
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::GitAuth);
    }

    #[test]
    fn empty_message_without_amend_is_rejected() {
        let temp = TestDir::new("empty");
        init_repo(&temp.0);
        let error = commit(
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
}
