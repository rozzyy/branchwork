//! Remote sync writes (M6-01): fetch / pull / push via the user's `git` CLI, keeping the user's
//! global config so credential helpers apply (spec §2). Failures are classified by
//! `commit::classify_git_failure` (GitAuth / Network / GitHook / GitConflict).
//! Pull shares the oplog lifecycle of `gitops::recorded_write`.
use crate::commit::{head_sha, open_worktree, require_success, run_git};
use crate::error::AppError;
use crate::gitops::recorded_write;
use crate::store::Store;
use std::{ffi::OsStr, path::Path};

pub(crate) fn current_branch(
    repository: &git2::Repository,
    action: &str,
) -> Result<String, AppError> {
    if repository.head_detached().unwrap_or(false) {
        return Err(AppError::validation(format!(
            "Check out a branch before you {action}"
        )));
    }
    let head = repository.head()?;
    head.shorthand()
        .map(str::to_owned)
        .map_err(|_| AppError::validation("The current branch name is not valid UTF-8"))
}

/// A fresh `git init` has no commit; git's own error ("reference not found") is opaque.
pub(crate) fn require_first_commit(
    repository: &git2::Repository,
    action: &str,
) -> Result<(), AppError> {
    if head_sha(repository)?.is_none() {
        return Err(AppError::validation(format!(
            "Make a first commit before {action}"
        )));
    }
    Ok(())
}

pub(crate) fn fetch(worktree_path: &Path) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    let output = run_git(&root, &[OsStr::new("fetch"), OsStr::new("--prune")])?;
    require_success(&root, &repository, "fetch", output)
}

/// Returns whether the pull left an undoable oplog entry (false when already up to date).
pub(crate) fn pull(store: &Store, worktree_path: &Path) -> Result<bool, AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    require_first_commit(&repository, "pulling")?;
    current_branch(&repository, "pull")?;
    recorded_write(
        store,
        &root,
        &repository,
        "pull",
        serde_json::json!({}),
        false,
        || {
            let output = run_git(&root, &[OsStr::new("pull"), OsStr::new("--no-edit")])?;
            require_success(&root, &repository, "pull", output)
        },
    )
}

pub(crate) fn push(worktree_path: &Path) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    require_first_commit(&repository, "pushing")?;
    let branch = current_branch(&repository, "push")?;
    let has_upstream = repository
        .find_branch(&branch, git2::BranchType::Local)
        .and_then(|local| local.upstream())
        .is_ok();
    let args: Vec<&OsStr> = if has_upstream {
        vec![OsStr::new("push")]
    } else if repository.find_remote("origin").is_ok() {
        ["push", "--set-upstream", "origin", "HEAD"]
            .into_iter()
            .map(OsStr::new)
            .collect()
    } else {
        return Err(AppError::validation(
            "This branch has no upstream and the repository has no origin remote",
        ));
    };
    let output = run_git(&root, &args)?;
    require_success(&root, &repository, "push", output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use crate::oplog;
    use std::{
        fs,
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
                "branchwork-m6-sync-{label}-{}-{id}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn configure(path: &Path) {
        git(path, &["config", "user.name", "Branchwork Test"]);
        git(path, &["config", "user.email", "test@example.com"]);
        git(path, &["config", "commit.gpgsign", "false"]);
        git(path, &["config", "pull.rebase", "false"]);
    }

    fn commit_file(path: &Path, name: &str, contents: &str, message: &str) -> String {
        fs::write(path.join(name), contents).unwrap();
        git(path, &["add", name]);
        git(path, &["commit", "-q", "-m", message]);
        git(path, &["rev-parse", "HEAD"])
    }

    /// A bare remote with one commit on `main`, plus two clones of it.
    struct Remote {
        bare: TestDir,
        a: TestDir,
        b: TestDir,
    }

    fn remote(label: &str) -> Remote {
        let bare = TestDir::new(&format!("{label}-bare"));
        git(&bare.0, &["init", "-q", "--bare", "-b", "main"]);
        let a = TestDir::new(&format!("{label}-a"));
        git(&a.0, &["init", "-q", "-b", "main"]);
        configure(&a.0);
        commit_file(&a.0, "README.md", "one\n", "initial");
        git(&a.0, &["remote", "add", "origin", bare.0.to_str().unwrap()]);
        git(&a.0, &["push", "-q", "-u", "origin", "main"]);
        let b = TestDir::new(&format!("{label}-b"));
        git(
            &b.0,
            &[
                "clone",
                "-q",
                bare.0.to_str().unwrap(),
                b.0.to_str().unwrap(),
            ],
        );
        configure(&b.0);
        Remote { bare, a, b }
    }

    #[test]
    fn fetch_updates_the_remote_tracking_ref() {
        let remote = remote("fetch");
        let pushed = commit_file(&remote.a.0, "a.txt", "a\n", "from a");
        git(&remote.a.0, &["push", "-q"]);

        fetch(&remote.b.0).unwrap();

        assert_eq!(git(&remote.b.0, &["rev-parse", "origin/main"]), pushed);
    }

    #[test]
    fn pull_fast_forwards_and_undo_restores_the_previous_head() {
        let store = Store::in_memory().unwrap();
        let remote = remote("pull");
        let before = git(&remote.b.0, &["rev-parse", "HEAD"]);
        let pushed = commit_file(&remote.a.0, "a.txt", "a\n", "from a");
        git(&remote.a.0, &["push", "-q"]);

        assert!(pull(&store, &remote.b.0).unwrap());
        assert_eq!(git(&remote.b.0, &["rev-parse", "HEAD"]), pushed);

        oplog::undo_last(&store, &remote.b.0).unwrap();
        assert_eq!(git(&remote.b.0, &["rev-parse", "HEAD"]), before);
        assert!(!remote.b.0.join("a.txt").exists());
    }

    #[test]
    fn up_to_date_pull_records_nothing() {
        let store = Store::in_memory().unwrap();
        let remote = remote("pull-noop");

        assert!(!pull(&store, &remote.b.0).unwrap());

        let path = remote.b.0.to_str().unwrap();
        assert!(store.latest_oplog(path).unwrap().is_none());
    }

    #[test]
    fn push_updates_the_remote() {
        let remote = remote("push");
        let local = commit_file(&remote.b.0, "b.txt", "b\n", "from b");

        push(&remote.b.0).unwrap();

        assert_eq!(git(&remote.bare.0, &["rev-parse", "main"]), local);
    }

    #[test]
    fn push_of_a_new_branch_sets_its_upstream() {
        let remote = remote("push-new");
        git(&remote.b.0, &["switch", "-q", "-c", "feature"]);
        let local = commit_file(&remote.b.0, "f.txt", "f\n", "feature");

        push(&remote.b.0).unwrap();

        assert_eq!(git(&remote.bare.0, &["rev-parse", "feature"]), local);
        assert_eq!(
            git(
                &remote.b.0,
                &["rev-parse", "--abbrev-ref", "feature@{upstream}"]
            ),
            "origin/feature"
        );
    }

    #[test]
    fn failing_pre_push_hook_maps_to_git_hook() {
        let remote = remote("push-hook");
        commit_file(&remote.b.0, "b.txt", "b\n", "from b");
        // Pin the repo-local hooks dir: remote ops keep the developer's global config.
        git(&remote.b.0, &["config", "core.hooksPath", ".git/hooks"]);
        let hook = remote.b.0.join(".git/hooks/pre-push");
        fs::write(&hook, "#!/bin/sh\necho 'blocked by policy' >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let error = push(&remote.b.0).unwrap_err();

        assert_eq!(error.kind, ErrorKind::GitHook);
        assert!(
            error
                .detail
                .unwrap_or_default()
                .contains("blocked by policy")
        );
    }

    #[test]
    fn rejected_non_fast_forward_push_keeps_stderr_in_detail() {
        let remote = remote("push-rejected");
        commit_file(&remote.a.0, "a.txt", "a\n", "from a");
        git(&remote.a.0, &["push", "-q"]);
        commit_file(&remote.b.0, "b.txt", "b\n", "from b");

        let error = push(&remote.b.0).unwrap_err();

        assert_eq!(error.message, "Git push failed");
        assert!(error.detail.unwrap_or_default().contains("rejected"));
    }

    // Regression: conflict output naming `.pre-commit-config.yaml` (and a `403` in a path) was
    // reported as a pre-commit hook / auth failure instead of a conflict.
    #[test]
    fn conflicting_pull_is_a_conflict_even_when_paths_look_like_hooks_or_http_codes() {
        let store = Store::in_memory().unwrap();
        let remote = remote("pull-conflict");
        for dir in [&remote.a.0, &remote.b.0] {
            git(dir, &["config", "core.hooksPath", ".git/hooks"]);
        }
        commit_file(&remote.a.0, ".pre-commit-config.yaml", "a\n", "a 403");
        commit_file(&remote.a.0, "docs-403.md", "a\n", "a docs");
        git(&remote.a.0, &["push", "-q"]);
        commit_file(&remote.b.0, ".pre-commit-config.yaml", "b\n", "b 403");
        commit_file(&remote.b.0, "docs-403.md", "b\n", "b docs");

        let error = pull(&store, &remote.b.0).unwrap_err();

        assert_eq!(error.kind, ErrorKind::GitConflict);
        assert!(error.detail.unwrap_or_default().contains("CONFLICT"));
        assert!(remote.b.0.join(".git/MERGE_HEAD").exists());
    }

    #[test]
    fn unreachable_remote_maps_to_network() {
        let remote = remote("fetch-network");
        git(
            &remote.b.0,
            &[
                "remote",
                "set-url",
                "origin",
                "https://127.0.0.1:1/missing.git",
            ],
        );

        let error = fetch(&remote.b.0).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Network);
        assert!(error.detail.is_some());
    }

    #[test]
    fn push_and_pull_on_a_branch_with_no_commits_ask_for_a_first_commit() {
        let store = Store::in_memory().unwrap();
        let dir = TestDir::new("unborn-sync");
        git(&dir.0, &["init", "-q", "-b", "main"]);

        for error in [push(&dir.0).unwrap_err(), pull(&store, &dir.0).unwrap_err()] {
            assert_eq!(error.kind, ErrorKind::Validation);
            assert!(error.message.contains("first commit"), "{}", error.message);
        }
    }
}
