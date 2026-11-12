//! Local Git write actions (M6-02): checkout, branch create, cherry-pick, revert via the user's
//! `git` CLI. Each undoable write records an oplog entry before it runs (spec §6.8 safety).
use crate::commit::{bounded, combined_text, head_sha, open_worktree, require_success, run_git};
use crate::error::{AppError, ErrorKind};
use crate::oplog;
use crate::store::Store;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{ffi::OsStr, path::Path, process::Output};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CheckoutTarget {
    Branch { name: String },
    Commit { sha: String },
}

pub(crate) fn validate_branch_name(root: &Path, name: &str) -> Result<(), AppError> {
    // `--branch` would expand `@{-N}` shorthands; refuse them and option-like names up front.
    if name.is_empty() || name.starts_with('-') || name.contains("@{") || name == "@" {
        return Err(AppError::validation(format!(
            "\"{name}\" is not a valid branch name"
        )));
    }
    let output = run_git(
        root,
        &[
            OsStr::new("check-ref-format"),
            OsStr::new("--branch"),
            OsStr::new(name),
        ],
    )?;
    if output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == name {
        Ok(())
    } else {
        Err(AppError::validation(format!(
            "\"{name}\" is not a valid branch name"
        )))
    }
}

/// Resolves a full commit SHA from IPC to a commit of this repository.
fn find_commit<'r>(
    repository: &'r git2::Repository,
    sha: &str,
) -> Result<git2::Commit<'r>, AppError> {
    if !(matches!(sha.len(), 40 | 64) && sha.bytes().all(|byte| byte.is_ascii_hexdigit())) {
        return Err(AppError::validation(
            "Commit id must be a full hexadecimal SHA",
        ));
    }
    let oid = git2::Oid::from_str(sha)
        .map_err(|_| AppError::validation("Commit id must be a full hexadecimal SHA"))?;
    repository
        .find_commit(oid)
        .map_err(|_| AppError::not_found(format!("Commit {sha} is not in this repository")))
}

fn checkout_failure(
    root: &Path,
    repository: &git2::Repository,
    output: Output,
) -> Result<(), AppError> {
    if output.status.success() {
        return Ok(());
    }
    let text = combined_text(&output);
    let lower = text.to_ascii_lowercase();
    let message = if lower.contains("would be overwritten") {
        Some("Checkout would overwrite local changes; commit, stash, or discard your changes first")
    } else if lower.contains("already used by worktree") || lower.contains("already checked out") {
        Some("That branch is already checked out in another worktree")
    } else {
        None
    };
    match message {
        Some(message) => {
            let mut error = AppError::new(ErrorKind::Conflict, message);
            error.detail = Some(text);
            error.recoverable = true;
            Err(bounded(error))
        }
        None => require_success(root, repository, "checkout", output),
    }
}

fn write_payload(
    store: &Store,
    record_id: i64,
    payload: serde_json::Value,
) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(&payload)
        .map_err(|error| AppError::internal(format!("Could not encode undo data: {error}")))?;
    if store.update_oplog_payload(record_id, &bytes)? {
        Ok(())
    } else {
        Err(AppError::internal("The undo record could not be found"))
    }
}

/// Runs a HEAD-moving write with an oplog entry recorded before it runs (`beforeHead` is
/// added here). The entry is removed when HEAD did not move (unless `keep_unchanged`, used by
/// checkout, whose undo restores the branch), completed with `afterHead` on success, and marked
/// non-undoable when a failed write already moved HEAD. Returns whether the entry is undoable.
pub(crate) fn recorded_write(
    store: &Store,
    root: &Path,
    repository: &git2::Repository,
    operation: &str,
    mut payload: serde_json::Value,
    keep_unchanged: bool,
    write: impl FnOnce() -> Result<(), AppError>,
) -> Result<bool, AppError> {
    let before = head_sha(repository)?;
    payload["beforeHead"] = json!(before);
    let record_id = oplog::record(store, operation, root, "", payload.clone())?;
    let result = write();
    let after = head_sha(repository)
        .map_err(|error| oplog::remove_failed_record(store, record_id, error))?;
    if let Err(error) = result {
        if after == before {
            return Err(oplog::remove_failed_record(store, record_id, error));
        }
        store.mark_oplog_non_undoable(record_id)?;
        return Err(error);
    }
    match (before, after) {
        (Some(before), Some(after)) if before != after || keep_unchanged => {
            payload["afterHead"] = json!(after);
            payload["path"] = json!("");
            write_payload(store, record_id, payload)?;
            Ok(true)
        }
        // Unchanged HEAD, or an unborn branch (nothing to reset back to).
        _ => {
            store.delete_oplog(record_id)?;
            Ok(false)
        }
    }
}

pub(crate) fn checkout(
    store: &Store,
    worktree_path: &Path,
    target: &CheckoutTarget,
) -> Result<bool, AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    let args: Vec<String> = match target {
        CheckoutTarget::Branch { name } => {
            validate_branch_name(&root, name)?;
            vec!["switch".into(), name.clone()]
        }
        CheckoutTarget::Commit { sha } => {
            find_commit(&repository, sha)?;
            vec!["switch".into(), "--detach".into(), sha.clone()]
        }
    };
    let before_branch = if repository.head_detached().unwrap_or(false) {
        None
    } else {
        repository
            .head()
            .ok()
            .and_then(|head| head.shorthand().ok().map(str::to_owned))
    };
    // Checking out the branch that is already checked out is a no-op; record no Undo for it.
    if matches!(target, CheckoutTarget::Branch { name } if Some(name) == before_branch.as_ref()) {
        return Ok(false);
    }
    let args: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
    recorded_write(
        store,
        &root,
        &repository,
        "checkout",
        json!({ "beforeBranch": before_branch }),
        true,
        || checkout_failure(&root, &repository, run_git(&root, &args)?),
    )
}

pub(crate) fn branch_create(
    worktree_path: &Path,
    name: &str,
    start_sha: &str,
    checkout: bool,
) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    validate_branch_name(&root, name)?;
    find_commit(&repository, start_sha)?;
    if repository
        .find_branch(name, git2::BranchType::Local)
        .is_ok()
    {
        return Err(AppError::new(
            ErrorKind::Conflict,
            format!("A branch named \"{name}\" already exists"),
        ));
    }
    let args: Vec<&OsStr> = if checkout {
        vec![
            "switch".as_ref(),
            "-c".as_ref(),
            name.as_ref(),
            start_sha.as_ref(),
        ]
    } else {
        vec!["branch".as_ref(), name.as_ref(), start_sha.as_ref()]
    };
    let output = run_git(&root, &args)?;
    if checkout {
        checkout_failure(&root, &repository, output)
    } else {
        require_success(&root, &repository, "branch", output)
    }
}

fn pick(store: &Store, worktree_path: &Path, sha: &str, revert: bool) -> Result<bool, AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    let commit = find_commit(&repository, sha)?;
    if commit.parent_count() > 1 {
        return Err(AppError::validation(
            "Cherry-picking or reverting a merge commit is not supported",
        ));
    }
    let (operation, args): (&str, Vec<&OsStr>) = if revert {
        (
            "revert",
            vec!["revert".as_ref(), "--no-edit".as_ref(), sha.as_ref()],
        )
    } else {
        ("cherry_pick", vec!["cherry-pick".as_ref(), sha.as_ref()])
    };
    let label = if revert { "revert" } else { "cherry-pick" };
    recorded_write(
        store,
        &root,
        &repository,
        operation,
        json!({ "sha": sha }),
        false,
        || require_success(&root, &repository, label, run_git(&root, &args)?),
    )
}

pub(crate) fn cherry_pick(
    store: &Store,
    worktree_path: &Path,
    sha: &str,
) -> Result<bool, AppError> {
    pick(store, worktree_path, sha, false)
}

pub(crate) fn revert(store: &Store, worktree_path: &Path, sha: &str) -> Result<bool, AppError> {
    pick(store, worktree_path, sha, true)
}

#[cfg(test)]
mod tests {
    use super::*;
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
                "branchwork-m6-gitops-{label}-{}-{id}",
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

    fn commit_file(path: &Path, name: &str, contents: &str, message: &str) -> String {
        fs::write(path.join(name), contents).unwrap();
        git(path, &["add", name]);
        git(path, &["commit", "-q", "-m", message]);
        git(path, &["rev-parse", "HEAD"])
    }

    /// `main` with two commits and a `feature` branch with one more commit on a separate file.
    fn repo(label: &str) -> (TestDir, String, String) {
        let dir = TestDir::new(label);
        git(&dir.0, &["init", "-q", "-b", "main"]);
        git(&dir.0, &["config", "user.name", "Branchwork Test"]);
        git(&dir.0, &["config", "user.email", "test@example.com"]);
        git(&dir.0, &["config", "commit.gpgsign", "false"]);
        git(&dir.0, &["config", "core.hooksPath", ".git/hooks"]);
        commit_file(&dir.0, "README.md", "one\n", "initial");
        commit_file(&dir.0, "README.md", "two\n", "second");
        git(&dir.0, &["switch", "-q", "-c", "feature"]);
        let feature = commit_file(&dir.0, "feature.txt", "feature\n", "feature work");
        git(&dir.0, &["switch", "-q", "main"]);
        let main = git(&dir.0, &["rev-parse", "HEAD"]);
        (dir, main, feature)
    }

    fn branch(path: &Path) -> String {
        git(path, &["branch", "--show-current"])
    }

    #[test]
    fn checkout_branch_and_undo_returns_to_previous_branch() {
        let store = Store::in_memory().unwrap();
        let (dir, _, _) = repo("checkout");

        let target = CheckoutTarget::Branch {
            name: "feature".into(),
        };
        assert!(checkout(&store, &dir.0, &target).unwrap());
        assert_eq!(branch(&dir.0), "feature");

        oplog::undo_last(&store, &dir.0).unwrap();
        assert_eq!(branch(&dir.0), "main");
    }

    #[test]
    fn checkout_blocked_by_dirty_tree_is_a_conflict_and_keeps_the_file() {
        let store = Store::in_memory().unwrap();
        let (dir, _, _) = repo("checkout-dirty");
        git(&dir.0, &["switch", "-q", "feature"]);
        commit_file(&dir.0, "README.md", "feature readme\n", "feature readme");
        git(&dir.0, &["switch", "-q", "main"]);
        fs::write(dir.0.join("README.md"), "local edit\n").unwrap();

        let target = CheckoutTarget::Branch {
            name: "feature".into(),
        };
        let error = checkout(&store, &dir.0, &target).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Conflict);
        assert_eq!(
            fs::read_to_string(dir.0.join("README.md")).unwrap(),
            "local edit\n"
        );
        assert_eq!(branch(&dir.0), "main");
        assert!(
            store
                .latest_oplog(dir.0.to_str().unwrap())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn checking_out_the_current_branch_records_no_undo() {
        let store = Store::in_memory().unwrap();
        let (dir, _, _) = repo("checkout-current");

        let target = CheckoutTarget::Branch {
            name: "main".into(),
        };
        assert!(!checkout(&store, &dir.0, &target).unwrap());
        assert!(
            store
                .latest_oplog(dir.0.to_str().unwrap())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn detached_checkout_of_a_commit() {
        let store = Store::in_memory().unwrap();
        let (dir, _, feature) = repo("checkout-detached");

        checkout(
            &store,
            &dir.0,
            &CheckoutTarget::Commit {
                sha: feature.clone(),
            },
        )
        .unwrap();

        assert_eq!(branch(&dir.0), "");
        assert_eq!(git(&dir.0, &["rev-parse", "HEAD"]), feature);
    }

    #[test]
    fn invalid_branch_name_is_rejected() {
        let store = Store::in_memory().unwrap();
        let (dir, main, _) = repo("bad-name");

        for name in ["bad..name", "-delete", "@{-1}", "has space"] {
            let target = CheckoutTarget::Branch { name: name.into() };
            assert_eq!(
                checkout(&store, &dir.0, &target).unwrap_err().kind,
                ErrorKind::Validation
            );
            assert_eq!(
                branch_create(&dir.0, name, &main, false).unwrap_err().kind,
                ErrorKind::Validation
            );
        }
    }

    #[test]
    fn branch_create_at_a_commit_with_and_without_checkout() {
        let (dir, _, feature) = repo("branch-create");

        branch_create(&dir.0, "topic", &feature, false).unwrap();
        assert_eq!(git(&dir.0, &["rev-parse", "topic"]), feature);
        assert_eq!(branch(&dir.0), "main");

        branch_create(&dir.0, "topic-2", &feature, true).unwrap();
        assert_eq!(branch(&dir.0), "topic-2");
    }

    #[test]
    fn cherry_pick_then_undo() {
        let store = Store::in_memory().unwrap();
        let (dir, main, feature) = repo("cherry-pick");

        assert!(cherry_pick(&store, &dir.0, &feature).unwrap());
        assert!(dir.0.join("feature.txt").exists());

        oplog::undo_last(&store, &dir.0).unwrap();
        assert_eq!(git(&dir.0, &["rev-parse", "HEAD"]), main);
        assert!(!dir.0.join("feature.txt").exists());
    }

    #[test]
    fn revert_then_undo() {
        let store = Store::in_memory().unwrap();
        let (dir, main, _) = repo("revert");

        assert!(revert(&store, &dir.0, &main).unwrap());
        assert_eq!(
            fs::read_to_string(dir.0.join("README.md")).unwrap(),
            "one\n"
        );

        oplog::undo_last(&store, &dir.0).unwrap();
        assert_eq!(git(&dir.0, &["rev-parse", "HEAD"]), main);
        assert_eq!(
            fs::read_to_string(dir.0.join("README.md")).unwrap(),
            "two\n"
        );
    }

    #[test]
    fn conflicting_cherry_pick_leaves_conflict_state_without_undo_record() {
        let store = Store::in_memory().unwrap();
        let (dir, _, _) = repo("cherry-pick-conflict");
        git(&dir.0, &["switch", "-q", "feature"]);
        let clash = commit_file(&dir.0, "README.md", "feature side\n", "clash");
        git(&dir.0, &["switch", "-q", "main"]);
        commit_file(&dir.0, "README.md", "main side\n", "main side");

        let error = cherry_pick(&store, &dir.0, &clash).unwrap_err();

        assert_eq!(error.kind, ErrorKind::GitConflict);
        assert!(error.detail.unwrap_or_default().contains("CONFLICT"));
        assert!(dir.0.join(".git/CHERRY_PICK_HEAD").exists());
        assert!(
            store
                .latest_oplog(dir.0.to_str().unwrap())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn merge_commit_is_rejected() {
        let store = Store::in_memory().unwrap();
        let (dir, _, _) = repo("merge-commit");
        git(&dir.0, &["merge", "-q", "--no-ff", "--no-edit", "feature"]);
        let merge = git(&dir.0, &["rev-parse", "HEAD"]);

        let error = cherry_pick(&store, &dir.0, &merge).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Validation);
    }
}
