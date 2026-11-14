//! Interactive rebase (M6-10..11, spec §6.8). M6-10: the read model — commits `base..HEAD` in
//! todo order and whether the branch is already pushed.
use crate::commit::{head_sha, open_worktree, require_success};
use crate::error::{AppError, ErrorKind};
use crate::gitops;
use crate::oplog;
use crate::store::Store;
use crate::sync::current_branch;
use crate::worktree;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Commits returned by `rebase_plan`; longer ranges are truncated (the UI refuses them).
const MAX_PLAN_COMMITS: usize = 500;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
    pub timestamp: i64,
    pub is_merge: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlan {
    pub branch: String,
    pub base: String,
    /// Oldest first, the order of a rebase todo list.
    pub commits: Vec<RebaseCommit>,
    pub truncated: bool,
    /// The upstream already contains a commit of the range, so a rebase rewrites published history.
    pub pushed: bool,
}

pub(crate) fn parse_sha(sha: &str) -> Result<git2::Oid, AppError> {
    if !(matches!(sha.len(), 40 | 64) && sha.bytes().all(|byte| byte.is_ascii_hexdigit())) {
        return Err(AppError::validation(
            "Commit id must be a full hexadecimal SHA",
        ));
    }
    git2::Oid::from_str(sha)
        .map_err(|_| AppError::validation("Commit id must be a full hexadecimal SHA"))
}

/// Text git stores as bytes; invalid UTF-8 is kept (lossily) rather than dropped.
fn lossy(bytes: &[u8]) -> Option<String> {
    (!bytes.is_empty()).then(|| String::from_utf8_lossy(bytes).into_owned())
}

pub(crate) fn plan(worktree_path: &Path, base: &str) -> Result<RebasePlan, AppError> {
    let base_oid = parse_sha(base)?;
    let (_, repository) = open_worktree(worktree_path)?;
    crate::sync::require_first_commit(&repository, "rebasing")?;
    let branch = current_branch(&repository, "rebase")?;
    let head = repository
        .head()?
        .target()
        .ok_or_else(|| AppError::validation("HEAD has no commit"))?;
    repository
        .find_commit(base_oid)
        .map_err(|_| AppError::validation(format!("Commit {base} is not in this repository")))?;
    if base_oid == head || !repository.graph_descendant_of(head, base_oid)? {
        return Err(AppError::validation(
            "Choose a commit below the current branch tip to rebase from",
        ));
    }

    // Newest first, capped; reversed afterwards into todo order.
    let mut walk = repository.revwalk()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL)?;
    walk.push(head)?;
    walk.hide(base_oid)?;
    let mut commits = Vec::new();
    let mut truncated = false;
    for oid in walk {
        if commits.len() == MAX_PLAN_COMMITS {
            truncated = true;
            break;
        }
        let commit = repository.find_commit(oid?)?;
        let author = commit.author();
        commits.push(RebaseCommit {
            sha: commit.id().to_string(),
            short_sha: commit.id().to_string()[..7].to_owned(),
            subject: lossy(commit.summary_bytes().unwrap_or_default()).unwrap_or_default(),
            author_name: lossy(author.name_bytes()),
            author_email: lossy(author.email_bytes()),
            timestamp: commit.time().seconds(),
            is_merge: commit.parent_count() > 1,
        });
    }
    commits.reverse();

    let pushed = repository
        .find_branch(&branch, git2::BranchType::Local)
        .and_then(|local| local.upstream())
        .ok()
        .and_then(|upstream| upstream.get().target())
        .and_then(|upstream| repository.merge_base(head, upstream).ok())
        .is_some_and(|merge_base| {
            merge_base != base_oid
                && repository
                    .graph_descendant_of(merge_base, base_oid)
                    .unwrap_or(false)
        });

    Ok(RebasePlan {
        branch,
        base: base_oid.to_string(),
        commits,
        truncated,
        pushed,
    })
}

const HELPER_FLAG: &str = "--branchwork-rebase-todo";

/// Where prepared todo and message files live; the helper copies only from here.
fn temp_root() -> PathBuf {
    std::env::temp_dir().join("branchwork-rebase")
}

/// The rebase temp root must be a real directory owned by this user and closed to others, so
/// another local user can't plant a todo (with `exec` lines) for the helper to copy.
fn check_private_root(root: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(root).map_err(|error| error.to_string())?;
    if !metadata.is_dir() {
        return Err("the Branchwork rebase directory isn't a plain directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions and can't fail.
        let uid = unsafe { libc::geteuid() };
        if metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
            return Err("the Branchwork rebase directory isn't private to this user".into());
        }
    }
    Ok(())
}

fn copy_prepared(prepared: &Path, target: &Path, root: &Path) -> Result<(), String> {
    check_private_root(root)?;
    // Git hands its sequence editor `<git-dir>/rebase-merge/git-rebase-todo`; write nothing else.
    if target.file_name() != Some(OsStr::new("git-rebase-todo")) {
        return Err("the target isn't a git rebase todo".into());
    }
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let prepared = prepared.canonicalize().map_err(|error| error.to_string())?;
    if !prepared.starts_with(&root) {
        return Err("prepared todo is outside the Branchwork rebase directory".into());
    }
    fs::copy(&prepared, target)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// `Branchwork --branchwork-rebase-todo <prepared> <git-todo>`: git's sequence editor for an
/// interactive rebase (Decision 2, amended). `None` when the process wasn't started that way.
pub(crate) fn todo_helper(args: &[OsString]) -> Option<i32> {
    todo_helper_in(args, &temp_root())
}

fn todo_helper_in(args: &[OsString], root: &Path) -> Option<i32> {
    if args.first().map(OsString::as_os_str) != Some(OsStr::new(HELPER_FLAG)) {
        return None;
    }
    Some(match (args.get(1), args.get(2)) {
        (Some(prepared), Some(target)) => {
            match copy_prepared(Path::new(prepared), Path::new(target), root) {
                Ok(()) => 0,
                Err(error) => {
                    eprintln!("branchwork rebase helper: {error}");
                    1
                }
            }
        }
        _ => 2,
    })
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RebaseAction {
    Pick,
    Reword { message: String },
    Squash,
    Fixup,
    Drop,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    pub sha: String,
    pub action: RebaseAction,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseRequest {
    pub base: String,
    /// One step per commit of the plan, in the new order.
    pub steps: Vec<RebaseStep>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RebaseStatus {
    Done,
    Conflict,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseOutcome {
    pub status: RebaseStatus,
    /// `refs/branchwork/backup/<branch>/<ts>`, the pre-rebase HEAD.
    pub backup_ref: Option<String>,
    pub undoable: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseProgress {
    pub worktree_path: String,
    pub step: u32,
    pub total: u32,
}

/// Upper bound for one reword message (a commit message, not a file).
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

fn validate_steps(plan: &RebasePlan, steps: &[RebaseStep]) -> Result<(), AppError> {
    if steps.len() > MAX_PLAN_COMMITS {
        return Err(AppError::validation("Too many rebase steps"));
    }
    if steps.iter().any(|step| {
        matches!(&step.action, RebaseAction::Reword { message }
            if message.len() > MAX_MESSAGE_BYTES || message.contains('\0'))
    }) {
        return Err(AppError::validation(
            "A reworded message is too long or contains a NUL character",
        ));
    }
    if plan.truncated {
        return Err(AppError::validation(
            "This range is too long to rebase here; choose a closer commit",
        ));
    }
    if plan.commits.iter().any(|commit| commit.is_merge) {
        return Err(AppError::validation(
            "The range contains a merge commit; rebasing merges isn't supported here",
        ));
    }
    let mut expected: Vec<&str> = plan
        .commits
        .iter()
        .map(|commit| commit.sha.as_str())
        .collect();
    let mut given: Vec<&str> = steps.iter().map(|step| step.sha.as_str()).collect();
    expected.sort_unstable();
    given.sort_unstable();
    if expected != given {
        return Err(AppError::validation(
            "The rebase steps must list every commit of the range exactly once",
        ));
    }
    let mut kept = steps
        .iter()
        .filter(|step| !matches!(step.action, RebaseAction::Drop));
    match kept.next() {
        None => return Err(AppError::validation("A rebase can't drop every commit")),
        Some(first) if matches!(first.action, RebaseAction::Squash | RebaseAction::Fixup) => {
            return Err(AppError::validation(
                "The first kept commit can't be squashed or fixed up",
            ));
        }
        Some(_) => {}
    }
    if steps
        .iter()
        .any(|step| matches!(&step.action, RebaseAction::Reword { message } if message.trim().is_empty()))
    {
        return Err(AppError::validation("A reworded commit needs a message"));
    }
    Ok(())
}

fn require_clean(repository: &git2::Repository) -> Result<(), AppError> {
    if repository.state() != git2::RepositoryState::Clean {
        return Err(AppError::validation(
            "Finish or abort the merge, cherry-pick, revert, or rebase in progress first",
        ));
    }
    let mut options = git2::StatusOptions::new();
    options.include_untracked(false).include_ignored(false);
    if !repository.statuses(Some(&mut options))?.is_empty() {
        return Err(AppError::validation(
            "Commit or stash your changes before rebasing",
        ));
    }
    Ok(())
}

/// POSIX single-quoting for the two paths git puts in its editor command line.
fn sh_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// Creates `dir` (and parents) readable only by the user from the start (no chmod-after race).
fn private_dir(dir: &Path) -> Result<(), AppError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .map_err(|error| AppError::io(format!("Could not prepare the rebase: {error}")))
}

/// Reword message files live in the worktree's git dir: an `exec` line can run during a later
/// `--continue`, long after the per-run temp dir is gone. Removed when the rebase ends.
fn messages_dir(repository: &git2::Repository) -> PathBuf {
    repository.path().join("branchwork-rebase")
}

fn clear_messages(repository: &git2::Repository) {
    let _ = fs::remove_dir_all(messages_dir(repository));
}

/// A private per-run directory for the prepared todo, removed on drop.
struct RunDir(PathBuf);

impl RunDir {
    fn create() -> Result<Self, AppError> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = temp_root();
        private_dir(&root)?;
        check_private_root(&root)
            .map_err(|error| AppError::io(format!("Could not prepare the rebase: {error}")))?;
        let dir = root.join(format!("run-{}-{stamp}", std::process::id()));
        private_dir(&dir)?;
        Ok(Self(dir))
    }
}

impl Drop for RunDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The amended message for a reword: the UI edits the subject line only, so the original body
/// is kept unless the new message brings its own.
fn reword_message(message: &str, body: Option<&str>) -> String {
    let message = message.trim_end();
    match body.map(str::trim_end).filter(|body| !body.is_empty()) {
        Some(body) if !message.contains('\n') => format!("{message}\n\n{body}\n"),
        _ => format!("{message}\n"),
    }
}

fn write_todo(
    dir: &Path,
    messages: &Path,
    steps: &[RebaseStep],
    body: impl Fn(&str) -> Option<String>,
) -> Result<PathBuf, AppError> {
    let io = |error: std::io::Error| AppError::io(format!("Could not prepare the rebase: {error}"));
    // Git reads the todo line by line: a line break in the path would add commands.
    if messages.to_string_lossy().contains(['\n', '\r']) {
        return Err(AppError::validation(
            "Rebasing isn't supported in a repository whose path contains a line break",
        ));
    }
    let mut todo = String::new();
    for (index, step) in steps.iter().enumerate() {
        let sha = &step.sha;
        match &step.action {
            RebaseAction::Pick => todo.push_str(&format!("pick {sha}\n")),
            RebaseAction::Squash => todo.push_str(&format!("squash {sha}\n")),
            RebaseAction::Fixup => todo.push_str(&format!("fixup {sha}\n")),
            // Explicit, so `rebase.missingCommitsCheck=error` accepts the todo.
            RebaseAction::Drop => todo.push_str(&format!("drop {sha}\n")),
            RebaseAction::Reword { message } => {
                private_dir(messages)?;
                let file = messages.join(format!("message-{index}"));
                fs::write(&file, reword_message(message, body(sha).as_deref())).map_err(io)?;
                todo.push_str(&format!(
                    "pick {sha}\nexec git commit --amend --only --quiet -F {}\n",
                    sh_quote(&file)
                ));
            }
        }
    }
    let path = dir.join("todo");
    fs::write(&path, todo).map_err(io)?;
    Ok(path)
}

/// Polls `rebase-merge/msgnum` / `end` while git runs and reports changes.
fn watch_progress(git_dir: &Path, done: &AtomicBool, progress: &(dyn Fn(u32, u32) + Sync)) {
    let read = |name: &str| {
        fs::read_to_string(git_dir.join("rebase-merge").join(name))
            .ok()
            .and_then(|text| text.trim().parse::<u32>().ok())
    };
    let mut last = None;
    while !done.load(Ordering::Acquire) {
        if let (Some(step), Some(total)) = (read("msgnum"), read("end"))
            && last != Some(step)
        {
            last = Some(step);
            progress(step, total);
        }
        // Woken early by `unpark` when git exits.
        std::thread::park_timeout(Duration::from_millis(200));
    }
}

fn run_rebase(
    root: &Path,
    repository: &git2::Repository,
    label: &str,
    args: &[&str],
    env: &[(&str, String)],
    progress: &(dyn Fn(u32, u32) + Sync),
) -> Result<RebaseStatus, AppError> {
    let filters = worktree::configured_checkout_filters(root)?;
    let argv: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
    let done = AtomicBool::new(false);
    let git_dir = repository.path().to_path_buf();
    let output = std::thread::scope(|scope| {
        let poller = scope.spawn(|| watch_progress(&git_dir, &done, progress));
        let output = worktree::invoke_git_with_env(root, &argv, &filters, env);
        done.store(true, Ordering::Release);
        poller.thread().unpark();
        output
    })?;
    if output.status.success() {
        return Ok(RebaseStatus::Done);
    }
    let in_rebase = matches!(
        repository.state(),
        git2::RepositoryState::RebaseInteractive
            | git2::RepositoryState::RebaseMerge
            | git2::RepositoryState::Rebase
    );
    if in_rebase && !crate::conflict::list(root)?.files.is_empty() {
        return Ok(RebaseStatus::Conflict);
    }
    // A stop without conflicts (e.g. a commit-msg hook rejecting a reword): report it; the
    // rebase stays in progress for Continue / Abort.
    require_success(root, repository, label, output).map(|()| RebaseStatus::Done)
}

/// Runs the interactive rebase described by `request`. `editor_exe` is the binary that handles
/// `--branchwork-rebase-todo` (the app itself in production).
pub(crate) fn interactive(
    store: &Store,
    worktree_path: &Path,
    request: &RebaseRequest,
    editor_exe: &Path,
    progress: &(dyn Fn(u32, u32) + Sync),
) -> Result<RebaseOutcome, AppError> {
    let plan = plan(worktree_path, &request.base)?;
    validate_steps(&plan, &request.steps)?;
    let (root, repository) = open_worktree(worktree_path)?;
    require_clean(&repository)?;
    let before =
        head_sha(&repository)?.ok_or_else(|| AppError::validation("HEAD has no commit"))?;
    let run_dir = RunDir::create()?;
    clear_messages(&repository);
    let body = |sha: &str| {
        let commit = repository.find_commit(parse_sha(sha).ok()?).ok()?;
        commit.body().ok().flatten().map(str::to_owned)
    };
    let todo = write_todo(&run_dir.0, &messages_dir(&repository), &request.steps, body)?;
    let editor = format!("{} {HELPER_FLAG} {}", sh_quote(editor_exe), sh_quote(&todo));

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut backup_ref = format!("refs/branchwork/backup/{}/{stamp}", plan.branch);
    let mut suffix = 1;
    while repository.find_reference(&backup_ref).is_ok() {
        backup_ref = format!("refs/branchwork/backup/{}/{stamp}-{suffix}", plan.branch);
        suffix += 1;
    }
    repository.reference(
        &backup_ref,
        parse_sha(&before)?,
        false,
        "branchwork: pre-rebase backup",
    )?;
    let record_id = oplog::record(
        store,
        "rebase",
        &root,
        "",
        json!({ "beforeHead": before, "backupRef": backup_ref }),
    )?;
    let status = run_rebase(
        &root,
        &repository,
        "rebase -i",
        &["rebase", "-i", &plan.base],
        &[
            ("GIT_SEQUENCE_EDITOR", editor),
            ("GIT_EDITOR", "true".into()),
        ],
        progress,
    );
    finish(store, &root, record_id, &before, backup_ref, status)
}

fn finish(
    store: &Store,
    root: &Path,
    record_id: i64,
    before: &str,
    backup_ref: String,
    status: Result<RebaseStatus, AppError>,
) -> Result<RebaseOutcome, AppError> {
    let (_, repository) = open_worktree(root)?;
    let after = head_sha(&repository)?;
    // Reword message files are needed only while a rebase is still in progress.
    if repository.state() == git2::RepositoryState::Clean {
        clear_messages(&repository);
    }
    let drop_backup = || {
        if let Ok(mut reference) = repository.find_reference(&backup_ref) {
            let _ = reference.delete();
        }
    };
    match status {
        // Nothing moved (e.g. every commit picked in order): no Undo, no backup to keep.
        Ok(RebaseStatus::Done) if after.as_deref() == Some(before) => {
            store.delete_oplog(record_id)?;
            drop_backup();
            Ok(RebaseOutcome {
                status: RebaseStatus::Done,
                backup_ref: None,
                undoable: false,
            })
        }
        Ok(RebaseStatus::Done) => {
            let after =
                after.ok_or_else(|| AppError::internal("Rebase finished without a HEAD"))?;
            gitops::write_payload(
                store,
                record_id,
                json!({ "path": "", "beforeHead": before, "afterHead": after, "backupRef": backup_ref }),
            )?;
            Ok(RebaseOutcome {
                status: RebaseStatus::Done,
                backup_ref: Some(backup_ref),
                undoable: true,
            })
        }
        // Mid-rebase: the backup ref is the way back; Undo would act on a moving HEAD.
        Ok(RebaseStatus::Conflict) => {
            store.mark_oplog_non_undoable(record_id)?;
            Ok(RebaseOutcome {
                status: RebaseStatus::Conflict,
                backup_ref: Some(backup_ref),
                undoable: false,
            })
        }
        Err(error)
            if after.as_deref() == Some(before)
                && repository.state() == git2::RepositoryState::Clean =>
        {
            drop_backup();
            Err(oplog::remove_failed_record(store, record_id, error))
        }
        Err(error) => {
            store.mark_oplog_non_undoable(record_id)?;
            Err(error)
        }
    }
}

fn require_rebase(repository: &git2::Repository) -> Result<(), AppError> {
    if matches!(
        repository.state(),
        git2::RepositoryState::RebaseInteractive
            | git2::RepositoryState::RebaseMerge
            | git2::RepositoryState::Rebase
    ) {
        Ok(())
    } else {
        Err(AppError::validation("No rebase is in progress"))
    }
}

/// `git rebase --continue` once no path is conflicted.
pub(crate) fn continue_rebase(
    worktree_path: &Path,
    progress: &(dyn Fn(u32, u32) + Sync),
) -> Result<RebaseOutcome, AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    require_rebase(&repository)?;
    let remaining = crate::conflict::list(&root)?.files.len();
    if remaining > 0 {
        return Err(AppError::new(
            ErrorKind::Conflict,
            format!("{remaining} file(s) still have conflicts"),
        ));
    }
    let status = run_rebase(
        &root,
        &repository,
        "rebase --continue",
        &["rebase", "--continue"],
        &[("GIT_EDITOR", "true".into())],
        progress,
    )?;
    if status == RebaseStatus::Done {
        clear_messages(&repository);
    }
    Ok(RebaseOutcome {
        status,
        backup_ref: None,
        undoable: false,
    })
}

/// `git rebase --abort` (the UI confirms first).
pub(crate) fn abort_rebase(worktree_path: &Path) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    require_rebase(&repository)?;
    let output = crate::commit::run_git(&root, &[OsStr::new("rebase"), OsStr::new("--abort")])?;
    require_success(&root, &repository, "rebase --abort", output)?;
    clear_messages(&repository);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use std::{
        fs,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    pub(crate) struct TestDir(pub PathBuf);

    impl TestDir {
        pub(crate) fn new(label: &str) -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "branchwork-m6-rebase-{label}-{}-{id}",
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

    pub(crate) fn git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_EDITOR", "true")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    pub(crate) fn commit(path: &Path, name: &str, contents: &str, message: &str) -> String {
        fs::write(path.join(name), contents).unwrap();
        git(path, &["add", name]);
        git(path, &["commit", "-q", "-m", message]);
        git(path, &["rev-parse", "HEAD"])
    }

    /// `main` with a base commit and three more on top; returns (dir, base sha).
    pub(crate) fn repo(label: &str) -> (TestDir, String) {
        let dir = TestDir::new(label);
        git(&dir.0, &["init", "-q", "-b", "main"]);
        git(&dir.0, &["config", "user.name", "Branchwork Test"]);
        git(&dir.0, &["config", "user.email", "test@example.com"]);
        let base = commit(&dir.0, "base.txt", "base\n", "base");
        commit(&dir.0, "a.txt", "a\n", "add a");
        commit(&dir.0, "b.txt", "b\n", "add b\n\nbody text");
        commit(&dir.0, "c.txt", "c\n", "add c");
        (dir, base)
    }

    #[test]
    fn lists_base_to_head_oldest_first_with_subjects_and_authors() {
        let (dir, base) = repo("list");

        let plan = plan(&dir.0, &base).unwrap();

        assert_eq!(plan.branch, "main");
        let subjects: Vec<_> = plan.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["add a", "add b", "add c"]);
        assert_eq!(
            plan.commits[0].author_name.as_deref(),
            Some("Branchwork Test")
        );
        assert_eq!(plan.commits[2].sha, git(&dir.0, &["rev-parse", "HEAD"]));
        assert!(!plan.truncated && !plan.pushed);
    }

    #[test]
    fn refuses_head_non_ancestor_and_detached_head() {
        let (dir, base) = repo("refuse");
        let head = git(&dir.0, &["rev-parse", "HEAD"]);
        assert_eq!(plan(&dir.0, &head).unwrap_err().kind, ErrorKind::Validation);

        git(&dir.0, &["switch", "-q", "-c", "side", &base]);
        let side = commit(&dir.0, "s.txt", "s\n", "side");
        git(&dir.0, &["switch", "-q", "main"]);
        assert_eq!(plan(&dir.0, &side).unwrap_err().kind, ErrorKind::Validation);

        git(&dir.0, &["switch", "-q", "--detach", "HEAD"]);
        assert_eq!(plan(&dir.0, &base).unwrap_err().kind, ErrorKind::Validation);
    }

    #[test]
    fn caps_long_ranges_and_flags_merges() {
        let (dir, base) = repo("cap");
        git(&dir.0, &["switch", "-q", "-c", "topic", &base]);
        commit(&dir.0, "t.txt", "t\n", "topic");
        git(&dir.0, &["switch", "-q", "main"]);
        git(&dir.0, &["merge", "-q", "--no-ff", "--no-edit", "topic"]);
        let merged = plan(&dir.0, &base).unwrap();
        assert!(merged.commits.iter().any(|c| c.is_merge));

        // In-process empty commits: 500 `git commit` processes would load the machine.
        let repository = git2::Repository::open(&dir.0).unwrap();
        let signature = git2::Signature::now("Branchwork Test", "test@example.com").unwrap();
        for index in 0..MAX_PLAN_COMMITS {
            let parent = repository.head().unwrap().peel_to_commit().unwrap();
            let tree = parent.tree().unwrap();
            repository
                .commit(
                    Some("HEAD"),
                    &signature,
                    &signature,
                    &format!("e{index}"),
                    &tree,
                    &[&parent],
                )
                .unwrap();
        }
        let capped = plan(&dir.0, &base).unwrap();
        assert!(capped.truncated);
        assert_eq!(capped.commits.len(), MAX_PLAN_COMMITS);
    }

    #[test]
    fn pushed_reflects_whether_the_upstream_contains_the_range() {
        let (dir, base) = repo("pushed");
        let bare = TestDir::new("pushed-bare");
        git(&bare.0, &["init", "-q", "--bare", "-b", "main"]);
        git(
            &dir.0,
            &["remote", "add", "origin", bare.0.to_str().unwrap()],
        );
        assert!(!plan(&dir.0, &base).unwrap().pushed, "no upstream");

        git(
            &dir.0,
            &[
                "push",
                "-q",
                "-u",
                "origin",
                &format!("{base}:refs/heads/main"),
            ],
        );
        git(
            &dir.0,
            &["branch", "-q", "--set-upstream-to", "origin/main"],
        );
        assert!(!plan(&dir.0, &base).unwrap().pushed, "upstream at base");

        git(&dir.0, &["push", "-q", "origin", "HEAD~1:refs/heads/main"]);
        git(&dir.0, &["fetch", "-q"]);
        assert!(
            plan(&dir.0, &base).unwrap().pushed,
            "upstream contains a commit of the range"
        );
    }

    use crate::store::Store;

    /// Stand-in for the app binary: same argument shape as `--branchwork-rebase-todo`.
    fn editor(dir: &TestDir) -> PathBuf {
        let path = dir.0.join("editor.sh");
        fs::write(
            &path,
            "#!/bin/sh\n[ \"$1\" = \"--branchwork-rebase-todo\" ] || exit 9\ncp \"$2\" \"$3\"\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    fn no_progress(_: u32, _: u32) {}

    fn step(sha: &str, action: RebaseAction) -> RebaseStep {
        RebaseStep {
            sha: sha.into(),
            action,
        }
    }

    fn subjects(dir: &Path, base: &str) -> Vec<String> {
        git(
            dir,
            &["log", "--reverse", "--format=%s", &format!("{base}..HEAD")],
        )
        .lines()
        .map(str::to_owned)
        .collect()
    }

    #[test]
    fn reword_keeps_the_body_and_an_unchanged_plan_is_not_undoable() {
        let store = Store::in_memory().unwrap();
        let (dir, base) = repo("reword-body");
        let shas: Vec<String> = plan(&dir.0, &base)
            .unwrap()
            .commits
            .into_iter()
            .map(|c| c.sha)
            .collect();

        // Regression (code review): the UI edits only the subject; the body must survive.
        let request = RebaseRequest {
            base: base.clone(),
            steps: vec![
                step(&shas[0], RebaseAction::Pick),
                step(
                    &shas[1],
                    RebaseAction::Reword {
                        message: "B renamed".into(),
                    },
                ),
                step(&shas[2], RebaseAction::Pick),
            ],
        };
        interactive(&store, &dir.0, &request, &editor(&dir), &no_progress).unwrap();
        assert_eq!(
            git(&dir.0, &["log", "-1", "--format=%B", "HEAD~1"]),
            "B renamed\n\nbody text"
        );

        // Regression (code review): picking everything in order moves nothing → no Undo, no backup.
        let head = git(&dir.0, &["rev-parse", "HEAD"]);
        let shas: Vec<String> = plan(&dir.0, &base)
            .unwrap()
            .commits
            .into_iter()
            .map(|c| c.sha)
            .collect();
        let request = RebaseRequest {
            base: base.clone(),
            steps: shas
                .iter()
                .map(|sha| step(sha, RebaseAction::Pick))
                .collect(),
        };
        let outcome = interactive(&store, &dir.0, &request, &editor(&dir), &no_progress).unwrap();
        assert!(!outcome.undoable && outcome.backup_ref.is_none());
        assert_eq!(git(&dir.0, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            git(
                &dir.0,
                &["for-each-ref", "--count=9", "refs/branchwork/backup"]
            )
            .lines()
            .count(),
            1,
            "only the first run's backup remains"
        );
    }

    #[test]
    fn helper_copies_the_prepared_todo_and_refuses_files_elsewhere() {
        let root = TestDir::new("helper-root");
        let other = TestDir::new("helper-other");
        fs::write(root.0.join("todo"), "pick abc\n").unwrap();
        fs::write(other.0.join("todo"), "drop abc\n").unwrap();
        let target = other.0.join("git-rebase-todo");
        let args = |prepared: &Path| {
            vec![
                OsString::from(HELPER_FLAG),
                prepared.as_os_str().to_owned(),
                target.as_os_str().to_owned(),
            ]
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root.0, fs::Permissions::from_mode(0o755)).unwrap();
            // Regression (security review): a root open to others is refused.
            assert_eq!(
                todo_helper_in(&args(&root.0.join("todo")), &root.0),
                Some(1)
            );
            fs::set_permissions(&root.0, fs::Permissions::from_mode(0o700)).unwrap();
        }

        assert_eq!(
            todo_helper_in(&args(&root.0.join("todo")), &root.0),
            Some(0)
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "pick abc\n");
        assert_eq!(
            todo_helper_in(&args(&other.0.join("todo")), &root.0),
            Some(1)
        );
        assert_eq!(todo_helper_in(&["--other".into()], &root.0), None);
        // Only git's todo file is ever written.
        let elsewhere = vec![
            OsString::from(HELPER_FLAG),
            root.0.join("todo").into_os_string(),
            other.0.join("notes").into_os_string(),
        ];
        assert_eq!(todo_helper_in(&elsewhere, &root.0), Some(1));
    }

    #[test]
    fn one_run_reorders_rewords_squashes_fixes_up_and_drops_and_undo_restores() {
        let store = Store::in_memory().unwrap();
        let (dir, base) = repo("full");
        commit(&dir.0, "d.txt", "d\n", "add d");
        commit(&dir.0, "e.txt", "e\n", "add e");
        let old_head = git(&dir.0, &["rev-parse", "HEAD"]);
        let plan = plan(&dir.0, &base).unwrap();
        let [a, b, c, d, e] = [0, 1, 2, 3, 4].map(|index| plan.commits[index].sha.clone());
        let request = RebaseRequest {
            base: base.clone(),
            steps: vec![
                step(&c, RebaseAction::Pick),
                step(
                    &a,
                    RebaseAction::Reword {
                        message: "A reworded".into(),
                    },
                ),
                step(&b, RebaseAction::Fixup),
                step(&d, RebaseAction::Squash),
                step(&e, RebaseAction::Drop),
            ],
        };

        let outcome = interactive(&store, &dir.0, &request, &editor(&dir), &no_progress).unwrap();

        assert_eq!(outcome.status, RebaseStatus::Done);
        assert!(outcome.undoable);
        assert_eq!(subjects(&dir.0, &base), ["add c", "A reworded"]);
        let message = git(&dir.0, &["log", "-1", "--format=%B"]);
        assert!(
            message.contains("add d") && !message.contains("add b"),
            "{message}"
        );
        assert!(!dir.0.join("e.txt").exists() && dir.0.join("b.txt").exists());
        let backup = outcome.backup_ref.unwrap();
        assert_eq!(git(&dir.0, &["rev-parse", &backup]), old_head);

        oplog::undo_last(&store, &dir.0).unwrap();
        assert_eq!(git(&dir.0, &["rev-parse", "HEAD"]), old_head);
    }

    #[test]
    fn invalid_requests_are_refused_without_touching_head() {
        let store = Store::in_memory().unwrap();
        let (dir, base) = repo("invalid");
        let head = git(&dir.0, &["rev-parse", "HEAD"]);
        let shas: Vec<String> = plan(&dir.0, &base)
            .unwrap()
            .commits
            .into_iter()
            .map(|c| c.sha)
            .collect();
        let picks = |actions: [RebaseAction; 3]| -> Vec<RebaseStep> {
            shas.iter()
                .zip(actions)
                .map(|(sha, action)| step(sha, action))
                .collect()
        };
        let editor = editor(&dir);
        let refused = |steps: Vec<RebaseStep>| {
            let request = RebaseRequest {
                base: base.clone(),
                steps,
            };
            interactive(&store, &dir.0, &request, &editor, &no_progress)
                .unwrap_err()
                .kind
        };
        use RebaseAction::*;

        assert_eq!(
            refused(picks([Pick, Pick, Pick])[..2].to_vec()),
            ErrorKind::Validation,
            "missing sha"
        );
        let mut duplicate = picks([Pick, Pick, Pick]);
        duplicate[2].sha = shas[0].clone();
        assert_eq!(refused(duplicate), ErrorKind::Validation, "duplicate");
        assert_eq!(
            refused(picks([Squash, Pick, Pick])),
            ErrorKind::Validation,
            "squash first"
        );
        assert_eq!(
            refused(picks([Drop, Drop, Drop])),
            ErrorKind::Validation,
            "all dropped"
        );
        fs::write(dir.0.join("a.txt"), "dirty\n").unwrap();
        assert_eq!(
            refused(picks([Pick, Pick, Pick])),
            ErrorKind::Validation,
            "dirty tree"
        );
        git(&dir.0, &["checkout", "--", "a.txt"]);
        git(&dir.0, &["switch", "-q", "-c", "topic", &base]);
        commit(&dir.0, "t.txt", "t\n", "topic");
        git(&dir.0, &["switch", "-q", "main"]);
        git(&dir.0, &["merge", "-q", "--no-ff", "--no-edit", "topic"]);
        let merged = plan(&dir.0, &base).unwrap();
        let steps = merged.commits.iter().map(|c| step(&c.sha, Pick)).collect();
        assert_eq!(refused(steps), ErrorKind::Validation, "merge in range");
        git(&dir.0, &["reset", "-q", "--hard", &head]);
        assert_eq!(git(&dir.0, &["rev-parse", "HEAD"]), head);
    }

    /// `base`, then `p` and `q` both rewriting `f.txt`; reordering them conflicts.
    fn conflicting(label: &str) -> (TestDir, String, Vec<RebaseStep>, String) {
        let dir = TestDir::new(label);
        git(&dir.0, &["init", "-q", "-b", "main"]);
        git(&dir.0, &["config", "user.name", "Branchwork Test"]);
        git(&dir.0, &["config", "user.email", "test@example.com"]);
        let base = commit(&dir.0, "f.txt", "base\n", "base");
        let p = commit(&dir.0, "f.txt", "p\n", "p");
        let q = commit(&dir.0, "f.txt", "q\n", "q");
        let steps = vec![step(&q, RebaseAction::Pick), step(&p, RebaseAction::Pick)];
        (dir, base, steps, q)
    }

    #[test]
    fn a_conflicting_rebase_stops_and_continues_after_resolving() {
        let store = Store::in_memory().unwrap();
        let (dir, base, steps, _) = conflicting("conflict");

        let outcome = interactive(
            &store,
            &dir.0,
            &RebaseRequest {
                base: base.clone(),
                steps,
            },
            &editor(&dir),
            &no_progress,
        )
        .unwrap();
        assert_eq!(outcome.status, RebaseStatus::Conflict);
        assert!(!outcome.undoable);
        assert_eq!(
            continue_rebase(&dir.0, &no_progress).unwrap_err().kind,
            ErrorKind::Conflict
        );

        let mut status = RebaseStatus::Conflict;
        // Distinct content per round, or git drops the now-empty second commit.
        for round in 0..3 {
            if status == RebaseStatus::Done {
                break;
            }
            fs::write(dir.0.join("f.txt"), format!("resolved {round}\n")).unwrap();
            git(&dir.0, &["add", "f.txt"]);
            status = continue_rebase(&dir.0, &no_progress).unwrap().status;
        }
        assert_eq!(status, RebaseStatus::Done);
        assert_eq!(subjects(&dir.0, &base).len(), 2);
    }

    #[test]
    fn abort_restores_the_old_head() {
        let store = Store::in_memory().unwrap();
        let (dir, base, steps, old_head) = conflicting("abort");
        let outcome = interactive(
            &store,
            &dir.0,
            &RebaseRequest { base, steps },
            &editor(&dir),
            &no_progress,
        )
        .unwrap();
        assert_eq!(outcome.status, RebaseStatus::Conflict);

        abort_rebase(&dir.0).unwrap();

        assert_eq!(git(&dir.0, &["rev-parse", "HEAD"]), old_head);
        assert_eq!(
            abort_rebase(&dir.0).unwrap_err().kind,
            ErrorKind::Validation
        );
    }

    #[test]
    fn force_with_lease_updates_a_rewritten_branch_and_refuses_when_the_remote_moved() {
        let store = Store::in_memory().unwrap();
        let (dir, base) = repo("lease");
        let bare = TestDir::new("lease-bare");
        git(&bare.0, &["init", "-q", "--bare", "-b", "main"]);
        git(
            &dir.0,
            &["remote", "add", "origin", bare.0.to_str().unwrap()],
        );
        git(&dir.0, &["push", "-q", "-u", "origin", "main"]);
        let shas: Vec<String> = plan(&dir.0, &base)
            .unwrap()
            .commits
            .into_iter()
            .map(|c| c.sha)
            .collect();
        let request = RebaseRequest {
            base: base.clone(),
            steps: vec![
                step(
                    &shas[0],
                    RebaseAction::Reword {
                        message: "rewritten a".into(),
                    },
                ),
                step(&shas[1], RebaseAction::Pick),
                step(&shas[2], RebaseAction::Pick),
            ],
        };
        interactive(&store, &dir.0, &request, &editor(&dir), &no_progress).unwrap();
        assert!(
            crate::sync::push(&dir.0).is_err(),
            "a plain push is rejected after a rewrite"
        );

        crate::sync::push_force_with_lease(&dir.0).unwrap();
        assert_eq!(
            git(&bare.0, &["rev-parse", "main"]),
            git(&dir.0, &["rev-parse", "HEAD"])
        );

        let other = TestDir::new("lease-other");
        git(
            &other.0,
            &[
                "clone",
                "-q",
                bare.0.to_str().unwrap(),
                other.0.to_str().unwrap(),
            ],
        );
        git(&other.0, &["config", "user.name", "Other"]);
        git(&other.0, &["config", "user.email", "o@example.com"]);
        commit(&other.0, "o.txt", "o\n", "other change");
        git(&other.0, &["push", "-q"]);
        git(&dir.0, &["commit", "-q", "--amend", "-m", "amended again"]);
        assert!(
            crate::sync::push_force_with_lease(&dir.0).is_err(),
            "remote moved since the last fetch"
        );

        // Regression (security review): a branch tracking a differently named upstream is
        // refused instead of force-overwriting that branch.
        let main_before = git(&bare.0, &["rev-parse", "main"]);
        git(
            &dir.0,
            &["switch", "-q", "-c", "feature", "--track", "origin/main"],
        );
        assert!(crate::sync::push_force_with_lease(&dir.0).is_err());
        assert_eq!(git(&bare.0, &["rev-parse", "main"]), main_before);
    }

    // Regression (spec review): reword message files were deleted when the first call returned,
    // so a reword after a conflicting step was lost on continue.
    #[test]
    fn a_reword_after_a_conflict_survives_continue() {
        let store = Store::in_memory().unwrap();
        let (dir, base, mut steps, _) = conflicting("reword-after-conflict");
        steps[1].action = RebaseAction::Reword {
            message: "p reworded".into(),
        };

        let outcome = interactive(
            &store,
            &dir.0,
            &RebaseRequest {
                base: base.clone(),
                steps,
            },
            &editor(&dir),
            &no_progress,
        )
        .unwrap();
        assert_eq!(outcome.status, RebaseStatus::Conflict);
        let mut status = RebaseStatus::Conflict;
        for round in 0..3 {
            if status == RebaseStatus::Done {
                break;
            }
            fs::write(dir.0.join("f.txt"), format!("resolved {round}\n")).unwrap();
            git(&dir.0, &["add", "f.txt"]);
            status = continue_rebase(&dir.0, &no_progress).unwrap().status;
        }

        assert_eq!(status, RebaseStatus::Done);
        assert_eq!(
            subjects(&dir.0, &base).last().map(String::as_str),
            Some("p reworded")
        );
        assert!(
            !dir.0.join(".git/branchwork-rebase").exists(),
            "message files cleaned up"
        );
    }
}
