//! Blame and file history IPC (Task 12): per-line authorship via `git2::Blame`, and per-file
//! commit history via `git2::Revwalk` scoped to a path.
//!
//! Rename-follow is **off** by default. libgit2 ships four `GIT_BLAME_TRACK_COPIES_*` flags for
//! this, but its own `blame.h` marks every one of them "not yet implemented and reserved for
//! future use" — there is currently no way for this API to actually follow a file across a
//! rename. `BlameRequest.follow_renames: true` still sets them, so the IPC contract (and the
//! eventual UI toggle — Task 13 does not expose it yet) won't need to change once libgit2 catches
//! up; until then it is a no-op.
use crate::{diff, error::AppError};
use git2::{BlameOptions, DiffOptions, ErrorCode, Repository, Sort, Tree};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const HOUR_SECS: i64 = 3_600;
const DAY_SECS: i64 = 24 * HOUR_SECS;
const WEEK_SECS: i64 = 7 * DAY_SECS;
const MONTH_SECS: i64 = 30 * DAY_SECS;
const SIX_MONTHS_SECS: i64 = 6 * MONTH_SECS;

#[derive(Debug, Clone, Copy, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BlameRequest {
    pub follow_renames: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryRequest {
    pub limit: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AgeBucket {
    Hours,
    Days,
    Weeks,
    Months,
    Older,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line: u32,
    pub sha: String,
    pub author: String,
    pub time: i64,
    pub summary: String,
    pub age_bucket: AgeBucket,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BlameGroup {
    pub sha: String,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BlameResult {
    pub lines: Vec<BlameLine>,
    pub groups: Vec<BlameGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub sha: String,
    pub author: String,
    pub message: String,
    pub time: i64,
}

/// Author-time age bucket for the UI's heat stripe (spec §6.4), computed against `now` rather
/// than reaching for `SystemTime::now()` internally so boundary behavior is directly testable.
fn age_bucket(commit_time: i64, now: i64) -> AgeBucket {
    let age = (now - commit_time).max(0);
    if age < DAY_SECS {
        AgeBucket::Hours
    } else if age < WEEK_SECS {
        AgeBucket::Days
    } else if age < MONTH_SECS {
        AgeBucket::Weeks
    } else if age < SIX_MONTHS_SECS {
        AgeBucket::Months
    } else {
        AgeBucket::Older
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// Opens `worktree_path`, validates `file_path` the same way `diff::read` does, and confirms the
/// path is tracked at `HEAD` — the common precondition for both `blame` and `file_history`.
fn open_tracked(worktree_path: &Path, file_path: &str) -> Result<(Repository, PathBuf), AppError> {
    let relative = diff::validate_file_path(file_path)?;
    let root = worktree_path
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve worktree path: {error}")))?;
    let repository = Repository::open(&root)
        .map_err(|error| AppError::not_a_repo(format!("Invalid worktree: {error}")))?;
    diff::ensure_path_stays_in_worktree(&root, &relative, &repository)?;
    ensure_tracked(&repository, &relative)?;
    Ok((repository, relative))
}

fn head_tree(repository: &Repository) -> Result<Tree<'_>, AppError> {
    match repository.head() {
        Ok(head) => head.peel_to_tree().map_err(AppError::from),
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            Err(AppError::not_found("Repository has no commits yet"))
        }
        Err(error) => Err(error.into()),
    }
}

fn ensure_tracked(repository: &Repository, relative: &Path) -> Result<(), AppError> {
    let tree = head_tree(repository)?;
    tree.get_path(relative)
        .map_err(|_| AppError::not_found(format!("{} is not tracked", relative.display())))?;
    Ok(())
}

pub fn blame(
    worktree_path: &Path,
    file_path: &str,
    request: BlameRequest,
) -> Result<BlameResult, AppError> {
    let (repository, relative) = open_tracked(worktree_path, file_path)?;

    let mut options = BlameOptions::new();
    if request.follow_renames {
        options
            .track_copies_same_commit_moves(true)
            .track_copies_same_commit_copies(true)
            .track_copies_any_commit_copies(true);
    }
    let blame = repository
        .blame_file(&relative, Some(&mut options))
        .map_err(AppError::from)?;

    let now = now_unix();
    let mut lines = Vec::new();
    for hunk in blame.iter() {
        let sha = hunk.final_commit_id().to_string();
        let signature = hunk.final_signature();
        let author = signature
            .as_ref()
            .and_then(|sig| sig.name().ok())
            .unwrap_or_default()
            .to_string();
        let time = signature
            .as_ref()
            .map(|sig| sig.when().seconds())
            .unwrap_or(0);
        let summary = hunk
            .summary()
            .ok()
            .flatten()
            .unwrap_or_default()
            .to_string();
        let start = hunk.final_start_line() as u32;
        for offset in 0..hunk.lines_in_hunk() as u32 {
            lines.push(BlameLine {
                line: start + offset,
                sha: sha.clone(),
                author: author.clone(),
                time,
                summary: summary.clone(),
                age_bucket: age_bucket(time, now),
            });
        }
    }
    lines.sort_by_key(|line| line.line);
    let groups = collapse_groups(&lines);
    Ok(BlameResult { lines, groups })
}

fn collapse_groups(lines: &[BlameLine]) -> Vec<BlameGroup> {
    let mut groups: Vec<BlameGroup> = Vec::new();
    for line in lines {
        match groups.last_mut() {
            Some(last) if last.sha == line.sha && last.end + 1 == line.line => {
                last.end = line.line;
            }
            _ => groups.push(BlameGroup {
                sha: line.sha.clone(),
                start: line.line,
                end: line.line,
            }),
        }
    }
    groups
}

pub fn file_history(
    worktree_path: &Path,
    file_path: &str,
    request: FileHistoryRequest,
) -> Result<Vec<FileHistoryEntry>, AppError> {
    // No commits yet: there is no history, which is not an error.
    diff::validate_file_path(file_path)?;
    if let Ok(repository) = Repository::open(worktree_path)
        && crate::worktree::unborn_branch(&repository).is_some()
    {
        return Ok(Vec::new());
    }
    let (repository, relative) = open_tracked(worktree_path, file_path)?;

    let mut revwalk = repository.revwalk().map_err(AppError::from)?;
    revwalk
        .set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(AppError::from)?;
    revwalk.push_head().map_err(AppError::from)?;

    let mut entries = Vec::new();
    for oid in revwalk {
        if entries.len() as u32 >= request.limit {
            break;
        }
        let oid = oid.map_err(AppError::from)?;
        let commit = repository.find_commit(oid).map_err(AppError::from)?;
        if !commit_touches_path(&repository, &commit, &relative)? {
            continue;
        }
        entries.push(FileHistoryEntry {
            sha: oid.to_string(),
            author: commit.author().name().unwrap_or_default().to_string(),
            message: commit
                .summary()
                .ok()
                .flatten()
                .unwrap_or_default()
                .to_string(),
            time: commit.time().seconds(),
        });
    }
    Ok(entries)
}

/// `true` when `commit`'s tree differs from any parent's at `relative` (or, for a root commit,
/// when the path exists at all) — the same "did this commit touch this path" test `git log --
/// <path>` uses to decide what to show.
fn commit_touches_path(
    repository: &Repository,
    commit: &git2::Commit<'_>,
    relative: &Path,
) -> Result<bool, AppError> {
    let tree = commit.tree().map_err(AppError::from)?;
    let path_text = relative.to_string_lossy();
    let mut options = DiffOptions::new();
    options
        .pathspec(path_text.as_ref())
        .disable_pathspec_match(true);

    if commit.parent_count() == 0 {
        let diff = repository
            .diff_tree_to_tree(None, Some(&tree), Some(&mut options))
            .map_err(AppError::from)?;
        return Ok(diff.deltas().len() > 0);
    }
    for parent in commit.parents() {
        let parent_tree = parent.tree().map_err(AppError::from)?;
        let diff = repository
            .diff_tree_to_tree(Some(&parent_tree), Some(&tree), Some(&mut options))
            .map_err(AppError::from)?;
        if diff.deltas().len() > 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use git2::Signature;
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("branchwork-m2-blame-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    /// Writes `contents` to `name` and commits it, returning the new commit's SHA.
    fn commit_file(repository: &Repository, root: &Path, name: &str, contents: &str) -> String {
        fs::write(root.join(name), contents).unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = Signature::now("Branchwork test", "test@example.com").unwrap();
        let parent = repository
            .head()
            .ok()
            .and_then(|head| head.peel_to_commit().ok());
        let parents: Vec<_> = parent.iter().collect();
        let oid = repository
            .commit(Some("HEAD"), &signature, &signature, name, &tree, &parents)
            .unwrap();
        oid.to_string()
    }

    fn init_repository(path: &Path) -> Repository {
        Repository::init(path).unwrap()
    }

    #[test]
    fn blame_of_three_commit_file_assigns_correct_sha_per_line_and_groups() {
        let dir = TestDir::new();
        let repository = init_repository(&dir.0);
        let c1 = commit_file(&repository, &dir.0, "file.txt", "a\nb\nc\n");
        let c2 = commit_file(&repository, &dir.0, "file.txt", "a\nB\nc\n");
        let c3 = commit_file(&repository, &dir.0, "file.txt", "a\nB\nc\nd\n");

        let result = blame(&dir.0, "file.txt", BlameRequest::default()).unwrap();

        let shas: Vec<&str> = result.lines.iter().map(|line| line.sha.as_str()).collect();
        assert_eq!(
            shas,
            vec![c1.as_str(), c2.as_str(), c1.as_str(), c3.as_str()]
        );

        assert_eq!(
            result.groups,
            vec![
                BlameGroup {
                    sha: c1.clone(),
                    start: 1,
                    end: 1
                },
                BlameGroup {
                    sha: c2.clone(),
                    start: 2,
                    end: 2
                },
                BlameGroup {
                    sha: c1,
                    start: 3,
                    end: 3
                },
                BlameGroup {
                    sha: c3,
                    start: 4,
                    end: 4
                },
            ]
        );
    }

    #[test]
    fn file_history_orders_newest_first_and_respects_limit() {
        let dir = TestDir::new();
        let repository = init_repository(&dir.0);
        let c1 = commit_file(&repository, &dir.0, "a.txt", "1\n");
        let _unrelated = commit_file(&repository, &dir.0, "b.txt", "x\n");
        let c2 = commit_file(&repository, &dir.0, "a.txt", "2\n");
        let c3 = commit_file(&repository, &dir.0, "a.txt", "3\n");

        let all = file_history(&dir.0, "a.txt", FileHistoryRequest { limit: 10 }).unwrap();
        let shas: Vec<&str> = all.iter().map(|entry| entry.sha.as_str()).collect();
        assert_eq!(shas, vec![c3.as_str(), c2.as_str(), c1.as_str()]);

        let limited = file_history(&dir.0, "a.txt", FileHistoryRequest { limit: 2 }).unwrap();
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].sha, c3);
        assert_eq!(limited[1].sha, c2);
    }

    #[test]
    fn age_bucket_boundaries_use_now_relative_tolerance() {
        let now = 1_700_000_000_i64;
        assert_eq!(age_bucket(now, now), AgeBucket::Hours);
        assert_eq!(age_bucket(now - DAY_SECS + 1, now), AgeBucket::Hours);
        assert_eq!(age_bucket(now - DAY_SECS, now), AgeBucket::Days);
        assert_eq!(age_bucket(now - WEEK_SECS, now), AgeBucket::Weeks);
        assert_eq!(age_bucket(now - MONTH_SECS, now), AgeBucket::Months);
        assert_eq!(age_bucket(now - SIX_MONTHS_SECS, now), AgeBucket::Older);
    }

    #[test]
    fn returns_not_found_for_untracked_path() {
        let dir = TestDir::new();
        let repository = init_repository(&dir.0);
        commit_file(&repository, &dir.0, "tracked.txt", "hi\n");

        let blame_error = blame(&dir.0, "missing.txt", BlameRequest::default()).unwrap_err();
        assert_eq!(blame_error.kind, ErrorKind::NotFound);

        let history_error =
            file_history(&dir.0, "missing.txt", FileHistoryRequest { limit: 10 }).unwrap_err();
        assert_eq!(history_error.kind, ErrorKind::NotFound);
    }

    #[test]
    fn history_of_a_repository_with_no_commits_is_empty() {
        let temp = TestDir::new();
        let repository = Repository::init(&temp.0).unwrap();
        repository.set_head("refs/heads/main").unwrap();
        fs::write(temp.0.join("new.txt"), "n\n").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("new.txt")).unwrap();
        index.write().unwrap();

        let history = file_history(&temp.0, "new.txt", FileHistoryRequest { limit: 50 }).unwrap();

        assert!(history.is_empty());
    }
}
