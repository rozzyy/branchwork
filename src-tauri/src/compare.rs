//! Compare two registered worktrees without modifying either checkout (M6-13, spec §6.8).
use crate::{diff, error::AppError, store::Store};
use git2::{Delta, Diff, DiffFormat, DiffOptions, Oid, Repository};
use serde::Serialize;
use std::{
    ffi::OsStr,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

pub const MAX_COMPARE_FILES: usize = 2_000;
pub const MAX_COMPARE_PATCH_BYTES: usize = 2 * 1024 * 1024;
const LARGE_FILE_BYTES: u64 = 1_048_576;
const MAX_SNAPSHOT_STDOUT_BYTES: usize = 128;
const MAX_SNAPSHOT_STDERR_BYTES: usize = 4 * 1024;
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);
static SNAPSHOT_GATE: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CompareFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: CompareFileStatus,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum CompareFileStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
    Typechange,
    Unreadable,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CompareSummary {
    pub files: Vec<CompareFile>,
    pub truncated: bool,
    /// Untracked files are intentionally excluded from stash-create snapshots.
    pub untracked_excluded: bool,
}

struct WorktreePair {
    repository: Repository,
    a_path: PathBuf,
    a_tree: Oid,
    b_tree: Oid,
    untracked_excluded: bool,
}

fn compare_pair(
    store: &Store,
    a: &str,
    b: &str,
    include_uncommitted: bool,
) -> Result<WorktreePair, AppError> {
    let a_path = crate::status::validate_catalog_worktree(store, Path::new(a))?;
    let b_path = crate::status::validate_catalog_worktree(store, Path::new(b))?;
    if a_path == b_path {
        return Err(AppError::validation("Choose two different worktrees"));
    }

    let a_repo = Repository::open(&a_path).map_err(AppError::from)?;
    let b_repo = Repository::open(&b_path).map_err(AppError::from)?;
    let a_common = a_repo
        .commondir()
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve repository: {error}")))?;
    let b_common = b_repo
        .commondir()
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve repository: {error}")))?;
    if a_common != b_common {
        return Err(AppError::validation(
            "Compare worktrees must belong to the same repository",
        ));
    }

    let (a_tree, b_tree) = if include_uncommitted {
        let _snapshot_guard = SNAPSHOT_GATE
            .lock()
            .map_err(|_| AppError::internal("Compare snapshot worker is unavailable"))?;
        (
            snapshot_tree(&a_repo, &a_path, true)?,
            snapshot_tree(&b_repo, &b_path, true)?,
        )
    } else {
        (
            snapshot_tree(&a_repo, &a_path, false)?,
            snapshot_tree(&b_repo, &b_path, false)?,
        )
    };
    Ok(WorktreePair {
        repository: a_repo,
        a_path,
        a_tree,
        b_tree,
        untracked_excluded: include_uncommitted,
    })
}

/// Return HEAD's tree, or a stored empty tree for an unborn repository. When requested, a
/// `git stash create` commit captures tracked worktree/index changes without changing either.
fn snapshot_tree(
    repository: &Repository,
    worktree_path: &Path,
    include_uncommitted: bool,
) -> Result<Oid, AppError> {
    let head_tree = match repository.head() {
        Ok(head) => Some(head.peel_to_tree().map_err(AppError::from)?.id()),
        Err(error)
            if matches!(
                error.code(),
                git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
            ) =>
        {
            None
        }
        Err(error) => return Err(error.into()),
    };
    let Some(head_tree) = head_tree else {
        return repository
            .treebuilder(None)
            .and_then(|builder| builder.write())
            .map_err(AppError::from);
    };

    if include_uncommitted {
        let output = run_snapshot_git(worktree_path)?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::internal(format!(
                "Git could not snapshot tracked worktree changes: {}",
                detail.trim().chars().take(500).collect::<String>()
            )));
        }
        if output.stdout.len() > 128 {
            return Err(AppError::internal("Git returned an invalid snapshot id"));
        }
        let snapshot = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !snapshot.is_empty() {
            let oid = Oid::from_str(&snapshot)
                .map_err(|_| AppError::internal("Git returned an invalid snapshot id"))?;
            let commit = repository
                .find_commit(oid)
                .map_err(|error| AppError::internal(format!("Cannot read snapshot: {error}")))?;
            return Ok(commit.tree().map_err(AppError::from)?.id());
        }
    }

    Ok(head_tree)
}

fn run_snapshot_git(worktree_path: &Path) -> Result<Output, AppError> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(worktree_path)
        .args([OsStr::new("-c"), OsStr::new("core.fsmonitor=false")])
        .args([OsStr::new("-c"), OsStr::new("core.hooksPath=/dev/null")])
        .args([OsStr::new("stash"), OsStr::new("create")])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| AppError::io(format!("Cannot snapshot worktree: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::internal("Git snapshot output is unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::internal("Git snapshot error output is unavailable"))?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout, MAX_SNAPSHOT_STDOUT_BYTES));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, MAX_SNAPSHOT_STDERR_BYTES));
    let deadline = Instant::now() + SNAPSHOT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                kill_snapshot_process_tree(&mut child);
                let _ = child.wait();
                return Err(AppError::internal(
                    "Git snapshot timed out after 30 seconds",
                ));
            }
            Err(error) => {
                kill_snapshot_process_tree(&mut child);
                let _ = child.wait();
                return Err(AppError::io(format!(
                    "Cannot wait for Git snapshot: {error}"
                )));
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| AppError::internal("Git snapshot output reader stopped unexpectedly"))?
        .map_err(|error| AppError::io(format!("Cannot read Git snapshot output: {error}")))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| AppError::internal("Git snapshot error reader stopped unexpectedly"))?
        .map_err(|error| AppError::io(format!("Cannot read Git snapshot errors: {error}")))?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn kill_snapshot_process_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let process_group = child.id() as i32;
        // SAFETY: the process group id was created for this child immediately before spawn.
        unsafe {
            libc::kill(-process_group, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

fn read_bounded(mut reader: impl Read, limit: usize) -> io::Result<Vec<u8>> {
    let mut output = Vec::with_capacity(limit.min(1024));
    let mut buffer = [0_u8; 4096];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..count.min(remaining)]);
    }
    Ok(output)
}

fn diff_trees<'repo>(pair: &'repo WorktreePair) -> Result<Diff<'repo>, AppError> {
    let a_tree = pair
        .repository
        .find_tree(pair.a_tree)
        .map_err(AppError::from)?;
    let b_tree = pair
        .repository
        .find_tree(pair.b_tree)
        .map_err(AppError::from)?;
    let mut options = DiffOptions::new();
    options
        .patience(true)
        .context_lines(3)
        .interhunk_lines(0)
        .include_typechange(true);
    pair.repository
        .diff_tree_to_tree(Some(&a_tree), Some(&b_tree), Some(&mut options))
        .map_err(AppError::from)
}

pub fn list(
    store: &Store,
    a: &str,
    b: &str,
    include_uncommitted: bool,
) -> Result<CompareSummary, AppError> {
    let pair = compare_pair(store, a, b, include_uncommitted)?;
    let diff = diff_trees(&pair)?;
    let total = diff.deltas().len();
    let mut files = Vec::with_capacity(total.min(MAX_COMPARE_FILES));
    for index in 0..total.min(MAX_COMPARE_FILES) {
        let delta = diff
            .get_delta(index)
            .ok_or_else(|| AppError::internal("Git comparison entry disappeared"))?;
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .ok_or_else(|| AppError::validation("Git returned a pathless comparison entry"))?;
        let path = path
            .to_str()
            .ok_or_else(|| AppError::validation("Git returned a non-UTF-8 path"))?
            .to_owned();
        diff::validate_file_path(&path)?;
        let old_path = delta
            .old_file()
            .path()
            .filter(|old| Some(*old) != delta.new_file().path())
            .map(|old| {
                old.to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| AppError::validation("Git returned a non-UTF-8 old path"))
            })
            .transpose()?;
        if let Some(old_path) = &old_path {
            diff::validate_file_path(old_path)?;
        }

        let is_large = diff::delta_bytes(&pair.repository, &delta)? > LARGE_FILE_BYTES;
        let binary = delta.flags().contains(git2::DiffFlags::BINARY)
            || (!is_large && diff::blob_is_binary(&pair.repository, &delta)?);
        let (additions, deletions) = if is_large || binary {
            (0, 0)
        } else if let Some(patch) = git2::Patch::from_diff(&diff, index).map_err(AppError::from)? {
            let (_, additions, deletions) = patch.line_stats().map_err(AppError::from)?;
            (
                additions.min(u32::MAX as usize) as u32,
                deletions.min(u32::MAX as usize) as u32,
            )
        } else {
            (0, 0)
        };
        files.push(CompareFile {
            path,
            old_path,
            status: status_kind(delta.status())?,
            additions,
            deletions,
            binary,
            truncated: is_large,
        });
    }
    Ok(CompareSummary {
        files,
        truncated: total > MAX_COMPARE_FILES,
        untracked_excluded: pair.untracked_excluded,
    })
}

fn status_kind(status: Delta) -> Result<CompareFileStatus, AppError> {
    match status {
        Delta::Added => Ok(CompareFileStatus::Added),
        Delta::Deleted => Ok(CompareFileStatus::Deleted),
        Delta::Modified => Ok(CompareFileStatus::Modified),
        Delta::Renamed => Ok(CompareFileStatus::Renamed),
        Delta::Copied => Ok(CompareFileStatus::Copied),
        Delta::Typechange => Ok(CompareFileStatus::Typechange),
        Delta::Unreadable => Ok(CompareFileStatus::Unreadable),
        Delta::Conflicted => Ok(CompareFileStatus::Conflicted),
        _ => Err(AppError::validation(
            "Git returned an unsupported comparison entry",
        )),
    }
}

pub fn file_diff(
    store: &Store,
    a: &str,
    b: &str,
    path: &str,
    include_uncommitted: bool,
) -> Result<diff::DiffModel, AppError> {
    diff::validate_file_path(path)?;
    let pair = compare_pair(store, a, b, include_uncommitted)?;
    let diff = diff_trees(&pair)?;
    diff::model_from_diff(&pair.repository, &pair.a_path, &diff, path, None)
}

pub fn patch(
    store: &Store,
    a: &str,
    b: &str,
    include_uncommitted: bool,
) -> Result<String, AppError> {
    let pair = compare_pair(store, a, b, include_uncommitted)?;
    let diff = diff_trees(&pair)?;
    for delta in diff.deltas() {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .ok_or_else(|| AppError::validation("Git returned a pathless comparison entry"))?;
        let path = path
            .to_str()
            .ok_or_else(|| AppError::validation("Git returned a non-UTF-8 path"))?;
        diff::validate_file_path(path)?;
        if let Some(old) = delta.old_file().path() {
            let old = old
                .to_str()
                .ok_or_else(|| AppError::validation("Git returned a non-UTF-8 old path"))?;
            diff::validate_file_path(old)?;
        }
        let file_bytes = diff::delta_bytes(&pair.repository, &delta)?;
        if file_bytes > MAX_COMPARE_PATCH_BYTES as u64 {
            return Err(AppError::validation(format!(
                "Patch exceeds the {} MiB size limit",
                MAX_COMPARE_PATCH_BYTES / 1024 / 1024
            )));
        }
        let large = file_bytes > LARGE_FILE_BYTES;
        if delta.flags().contains(git2::DiffFlags::BINARY)
            || (!large && diff::blob_is_binary(&pair.repository, &delta)?)
        {
            return Err(AppError::validation(
                "Copy patch is unavailable when the comparison contains binary files",
            ));
        }
    }
    let mut bytes = Vec::with_capacity(16 * 1024);
    let mut too_large = false;
    let result = diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        let prefix = matches!(origin, '+' | '-' | ' ').then_some(origin as u8);
        let line_size = line.content().len() + usize::from(prefix.is_some());
        if bytes.len().saturating_add(line_size) > MAX_COMPARE_PATCH_BYTES {
            too_large = true;
            return false;
        }
        if let Some(prefix) = prefix {
            bytes.push(prefix);
        }
        bytes.extend_from_slice(line.content());
        true
    });
    if too_large {
        return Err(AppError::validation(format!(
            "Patch exceeds the {} MiB size limit",
            MAX_COMPARE_PATCH_BYTES / 1024 / 1024
        )));
    }
    result.map_err(AppError::from)?;
    String::from_utf8(bytes).map_err(|_| {
        AppError::validation("Patch contains non-UTF-8 text and cannot be copied safely")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Project;
    use std::{
        fs,
        io::Write,
        path::PathBuf,
        process::{Command, Stdio},
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "branchwork-m6-compare-{label}-{}-{id}",
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

    fn commit(root: &Path, message: &str) {
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", message]);
    }

    fn pair(label: &str) -> (TestDir, PathBuf, Store) {
        let dir = TestDir::new(label);
        let root = dir.0.join("repo");
        let side = dir.0.join("side");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.name", "Branchwork Test"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        fs::write(root.join("shared.txt"), "base\n").unwrap();
        commit(&root, "base");
        git(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "compare-side",
                side.to_str().unwrap(),
                "HEAD",
            ],
        );
        fs::write(root.join("shared.txt"), "from main\n").unwrap();
        commit(&root, "main change");
        fs::write(side.join("shared.txt"), "from side\n").unwrap();
        commit(&side, "side change");

        let store = Store::in_memory().unwrap();
        store
            .save_project(&Project {
                id: "compare-project".into(),
                owner: None,
                name: "Compare test".into(),
                local_path: root.to_string_lossy().into_owned(),
                group_id: None,
            })
            .unwrap();
        (dir, side, store)
    }

    #[test]
    fn lists_commit_differences_and_returns_shared_file_diff_and_applyable_patch() {
        let (dir, side, store) = pair("commits");
        let root = dir.0.join("repo");
        let summary = list(
            &store,
            root.to_str().unwrap(),
            side.to_str().unwrap(),
            false,
        )
        .unwrap();
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].path, "shared.txt");
        assert_eq!(summary.files[0].status, CompareFileStatus::Modified);
        assert_eq!(summary.files[0].additions, 1);
        assert_eq!(summary.files[0].deletions, 1);
        assert!(!summary.untracked_excluded);

        let model = file_diff(
            &store,
            root.to_str().unwrap(),
            side.to_str().unwrap(),
            "shared.txt",
            false,
        )
        .unwrap();
        assert!(!model.hunks.is_empty());
        let patch = patch(
            &store,
            root.to_str().unwrap(),
            side.to_str().unwrap(),
            false,
        )
        .unwrap();
        assert!(patch.starts_with("diff --git a/shared.txt b/shared.txt"));
        assert!(patch.contains("+from side"), "unexpected patch: {patch:?}");
        let mut child = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["apply", "--check", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(patch.as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn tracked_dirty_snapshots_include_both_sides_without_changing_either_worktree() {
        let (dir, side, store) = pair("dirty");
        let root = dir.0.join("repo");
        fs::write(root.join("shared.txt"), "main dirty\n").unwrap();
        git(&root, &["add", "shared.txt"]);
        fs::write(root.join("untracked-main.txt"), "not included\n").unwrap();
        fs::write(side.join("shared.txt"), "side dirty\n").unwrap();
        fs::write(side.join("untracked-side.txt"), "not included\n").unwrap();

        let before = [&root, &side].map(|path| {
            (
                git(path, &["rev-parse", "HEAD"]),
                git(path, &["write-tree"]),
                git(path, &["status", "--porcelain=v1"]),
                fs::read(path.join("shared.txt")).unwrap(),
            )
        });
        let summary = list(&store, root.to_str().unwrap(), side.to_str().unwrap(), true).unwrap();
        assert!(summary.untracked_excluded);
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].path, "shared.txt");
        let after = [&root, &side].map(|path| {
            (
                git(path, &["rev-parse", "HEAD"]),
                git(path, &["write-tree"]),
                git(path, &["status", "--porcelain=v1"]),
                fs::read(path.join("shared.txt")).unwrap(),
            )
        });
        assert_eq!(before, after);

        let model = file_diff(
            &store,
            root.to_str().unwrap(),
            side.to_str().unwrap(),
            "shared.txt",
            true,
        )
        .unwrap();
        assert!(!model.hunks.is_empty());
    }

    #[test]
    fn refuses_same_worktree_different_repositories_and_invalid_paths() {
        let (dir, side, store) = pair("validation");
        let root = dir.0.join("repo");
        let same = list(
            &store,
            root.to_str().unwrap(),
            root.to_str().unwrap(),
            false,
        )
        .unwrap_err();
        assert_eq!(same.kind, crate::error::ErrorKind::Validation);

        let other_dir = TestDir::new("other-repository");
        let other = other_dir.0.join("other");
        fs::create_dir_all(&other).unwrap();
        git(&other, &["init", "-q", "-b", "main"]);
        git(&other, &["config", "user.name", "Branchwork Test"]);
        git(&other, &["config", "user.email", "test@example.com"]);
        fs::write(other.join("other.txt"), "other\n").unwrap();
        commit(&other, "other");
        store
            .save_project(&Project {
                id: "other-project".into(),
                owner: None,
                name: "Other".into(),
                local_path: other.to_string_lossy().into_owned(),
                group_id: None,
            })
            .unwrap();
        let different = list(
            &store,
            root.to_str().unwrap(),
            other.to_str().unwrap(),
            false,
        )
        .unwrap_err();
        assert_eq!(different.kind, crate::error::ErrorKind::Validation);

        let invalid = file_diff(
            &store,
            root.to_str().unwrap(),
            side.to_str().unwrap(),
            "../outside",
            false,
        )
        .unwrap_err();
        assert_eq!(invalid.kind, crate::error::ErrorKind::Validation);
    }

    #[test]
    fn summarizes_large_files_and_caps_the_file_list() {
        let (dir, side, store) = pair("caps");
        let root = dir.0.join("repo");
        fs::write(
            root.join("large.txt"),
            vec![b'a'; LARGE_FILE_BYTES as usize + 1],
        )
        .unwrap();
        fs::write(
            side.join("large.txt"),
            vec![b'b'; LARGE_FILE_BYTES as usize + 1],
        )
        .unwrap();
        commit(&root, "large file on main");
        commit(&side, "large file on side");
        let large_summary = list(
            &store,
            root.to_str().unwrap(),
            side.to_str().unwrap(),
            false,
        )
        .unwrap();
        let large = large_summary
            .files
            .iter()
            .find(|file| file.path == "large.txt")
            .unwrap();
        assert!(large.truncated);
        assert_eq!(large.additions, 0);
        assert_eq!(large.deletions, 0);
        let files = (0..=MAX_COMPARE_FILES)
            .map(|index| format!("many/{index:04}.txt"))
            .collect::<Vec<_>>();
        for file in &files {
            let path = root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "a\n").unwrap();
        }
        commit(&root, "many files on main");
        for file in &files {
            let path = side.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "b\n").unwrap();
        }
        commit(&side, "many files on side");

        let summary = list(
            &store,
            root.to_str().unwrap(),
            side.to_str().unwrap(),
            false,
        )
        .unwrap();
        assert_eq!(summary.files.len(), MAX_COMPARE_FILES);
        assert!(summary.truncated);
    }

    #[test]
    fn marks_binary_files_and_refuses_to_create_a_partial_text_patch() {
        let (dir, side, store) = pair("binary");
        let root = dir.0.join("repo");
        fs::write(root.join("image.bin"), [0, 1, 2, 0, 4]).unwrap();
        fs::write(side.join("image.bin"), [0, 1, 3, 0, 4]).unwrap();
        commit(&root, "binary main");
        commit(&side, "binary side");

        let summary = list(
            &store,
            root.to_str().unwrap(),
            side.to_str().unwrap(),
            false,
        )
        .unwrap();
        let file = summary
            .files
            .iter()
            .find(|file| file.path == "image.bin")
            .unwrap();
        assert!(file.binary);
        let model = file_diff(
            &store,
            root.to_str().unwrap(),
            side.to_str().unwrap(),
            "image.bin",
            false,
        )
        .unwrap();
        assert!(model.binary);
        assert!(
            patch(
                &store,
                root.to_str().unwrap(),
                side.to_str().unwrap(),
                false,
            )
            .is_err()
        );
    }

    #[test]
    fn refuses_patch_output_over_the_byte_limit() {
        let (dir, side, store) = pair("patch-cap");
        let root = dir.0.join("repo");
        let contents = format!("{}\n", "x".repeat(MAX_COMPARE_PATCH_BYTES + 32));
        fs::write(root.join("large-patch.txt"), &contents).unwrap();
        commit(&root, "large patch main");
        fs::write(
            side.join("large-patch.txt"),
            format!("{}\n", "y".repeat(MAX_COMPARE_PATCH_BYTES + 32)),
        )
        .unwrap();
        commit(&side, "large patch side");

        let error = patch(
            &store,
            root.to_str().unwrap(),
            side.to_str().unwrap(),
            false,
        )
        .unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Validation);
        assert!(error.message.contains("size limit"));
    }
}
