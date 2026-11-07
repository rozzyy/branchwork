use crate::{
    error::{AppError, ErrorKind},
    store::Store,
    worktree,
};
use git2::{DiffDelta, Repository, Status, StatusOptions};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

const LARGE_FILE_BYTES: u64 = 1_048_576;

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub bytes: u64,
    pub large: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusSummary {
    pub staged: Vec<StatusEntry>,
    pub unstaged: Vec<StatusEntry>,
}

pub fn validate_catalog_worktree(store: &Store, path: &Path) -> Result<PathBuf, AppError> {
    if !path.is_absolute() {
        return Err(AppError::validation("Worktree path must be absolute"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve worktree path: {error}")))?;
    let projects = store.list_projects()?;
    let mut project_error = None;
    for project in projects {
        match worktree::validate_pin(Path::new(&project.local_path), &canonical) {
            Ok(known_path) => return Ok(PathBuf::from(known_path)),
            Err(error) if error.kind == ErrorKind::NotFound => {}
            Err(error) => {
                project_error.get_or_insert(error);
            }
        }
    }
    if let Some(error) = project_error {
        return Err(error);
    }
    Err(AppError::not_found(format!(
        "Path {} is not a registered worktree",
        canonical.display()
    )))
}

pub fn read(path: &Path) -> Result<StatusSummary, AppError> {
    if !path.is_absolute() {
        return Err(AppError::validation("Worktree path must be absolute"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve worktree path: {error}")))?;
    let repository = Repository::open(&canonical)
        .map_err(|error| AppError::not_a_repo(format!("Invalid worktree: {error}")))?;
    reject_locked_index(&repository)?;

    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repository
        .statuses(Some(&mut options))
        .map_err(AppError::from)?;

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    for entry in statuses.iter() {
        let flags = entry.status();
        let index_status = status_letter(flags, true);
        let worktree_status = status_letter(flags, false);
        if index_status.is_none() && worktree_status.is_none() {
            continue;
        }

        let head_to_index = entry.head_to_index();
        let index_to_workdir = entry.index_to_workdir();
        let path = index_to_workdir
            .as_ref()
            .and_then(|delta| delta.new_file().path())
            .or_else(|| {
                head_to_index
                    .as_ref()
                    .and_then(|delta| delta.new_file().path())
            });
        let path = if let Some(path) = path {
            path.to_str()
                .ok_or_else(|| AppError::validation("Git status returned a non-UTF-8 path"))?
                .to_owned()
        } else {
            entry
                .path()
                .map_err(|_| AppError::validation("Git status returned a non-UTF-8 path"))?
                .to_owned()
        };

        let rename_delta = if flags.contains(Status::WT_RENAMED) {
            index_to_workdir.as_ref()
        } else if flags.contains(Status::INDEX_RENAMED) {
            head_to_index.as_ref()
        } else {
            None
        };
        let old_path = rename_delta
            .and_then(|delta| delta.old_file().path())
            .map(|path| {
                path.to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| AppError::validation("Git status returned a non-UTF-8 path"))
            })
            .transpose()?;

        let bytes = delta_bytes(head_to_index.as_ref()).max(delta_bytes(index_to_workdir.as_ref()));
        let entry = StatusEntry {
            path,
            old_path,
            index_status: index_status.map_or_else(String::new, |letter| letter.to_string()),
            worktree_status: worktree_status.map_or_else(String::new, |letter| letter.to_string()),
            bytes,
            large: bytes > LARGE_FILE_BYTES,
        };
        if index_status.is_some() {
            staged.push(entry.clone());
        }
        if worktree_status.is_some() {
            unstaged.push(entry);
        }
    }
    reject_locked_index(&repository)?;
    staged.sort_by(|left, right| left.path.cmp(&right.path));
    unstaged.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(StatusSummary { staged, unstaged })
}

fn reject_locked_index(repository: &Repository) -> Result<(), AppError> {
    match fs::metadata(repository.path().join("index.lock")) {
        Ok(_) => Err(AppError::io("Git index is locked by another operation")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::io(format!(
            "Cannot inspect Git index lock: {error}"
        ))),
    }
}

fn delta_bytes(delta: Option<&DiffDelta<'_>>) -> u64 {
    delta.map_or(0, |delta| {
        delta.old_file().size().max(delta.new_file().size())
    })
}

fn status_letter(flags: Status, index: bool) -> Option<char> {
    if flags.contains(Status::CONFLICTED) {
        return Some('U');
    }
    let relevant = if index {
        [
            (Status::INDEX_NEW, 'A'),
            (Status::INDEX_MODIFIED, 'M'),
            (Status::INDEX_DELETED, 'D'),
            (Status::INDEX_RENAMED, 'R'),
            (Status::INDEX_TYPECHANGE, 'T'),
        ]
    } else {
        [
            (Status::WT_NEW, '?'),
            (Status::WT_MODIFIED, 'M'),
            (Status::WT_DELETED, 'D'),
            (Status::WT_RENAMED, 'R'),
            (Status::WT_TYPECHANGE, 'T'),
        ]
    };
    relevant
        .into_iter()
        .find_map(|(flag, letter)| flags.contains(flag).then_some(letter))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Project;
    use git2::{Index, Repository, Signature};
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("branchwork-m2-status-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn init_repository(path: &Path, files: &[(&str, &str)]) -> Repository {
        let repository = Repository::init(path).unwrap();
        let signature = Signature::now("Branchwork test", "test@example.com").unwrap();
        let mut index = repository.index().unwrap();
        for (name, contents) in files {
            fs::write(path.join(name), contents).unwrap();
            index.add_path(Path::new(name)).unwrap();
        }
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        repository
            .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
        drop(tree);
        repository
    }

    fn find<'a>(entries: &'a [StatusEntry], path: &str) -> &'a StatusEntry {
        entries.iter().find(|entry| entry.path == path).unwrap()
    }

    #[test]
    fn reports_staged_and_unstaged_file_states_and_renames() {
        let dir = TestDir::new();
        let repository = init_repository(
            &dir.0,
            &[
                ("modified.txt", "before\n"),
                ("deleted.txt", "remove\n"),
                ("rename-old.txt", "rename contents\n"),
            ],
        );

        fs::write(dir.0.join("modified.txt"), "after\n").unwrap();
        fs::remove_file(dir.0.join("deleted.txt")).unwrap();
        fs::write(dir.0.join("added.txt"), "added\n").unwrap();
        fs::write(dir.0.join("untracked.txt"), "untracked\n").unwrap();
        fs::rename(dir.0.join("rename-old.txt"), dir.0.join("rename-new.txt")).unwrap();
        let mut index: Index = repository.index().unwrap();
        index.add_path(Path::new("added.txt")).unwrap();
        index.remove_path(Path::new("rename-old.txt")).unwrap();
        index.add_path(Path::new("rename-new.txt")).unwrap();
        index.write().unwrap();

        let status = read(&dir.0).unwrap();
        assert_eq!(find(&status.unstaged, "modified.txt").worktree_status, "M");
        assert_eq!(find(&status.unstaged, "deleted.txt").worktree_status, "D");
        assert_eq!(find(&status.staged, "added.txt").index_status, "A");
        assert_eq!(find(&status.unstaged, "untracked.txt").worktree_status, "?");
        let rename = find(&status.staged, "rename-new.txt");
        assert_eq!(rename.index_status, "R");
        assert_eq!(rename.old_path.as_deref(), Some("rename-old.txt"));
        assert!(
            status
                .staged
                .windows(2)
                .all(|pair| pair[0].path <= pair[1].path)
        );
        assert!(
            status
                .unstaged
                .windows(2)
                .all(|pair| pair[0].path <= pair[1].path)
        );
    }

    #[test]
    fn partially_staged_file_appears_in_both_lists() {
        let dir = TestDir::new();
        let repository = init_repository(&dir.0, &[("partial.txt", "first\nsecond\n")]);
        fs::write(dir.0.join("partial.txt"), "staged first\nsecond\n").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("partial.txt")).unwrap();
        index.write().unwrap();
        fs::write(dir.0.join("partial.txt"), "staged first\nunstaged second\n").unwrap();

        let status = read(&dir.0).unwrap();
        let staged = find(&status.staged, "partial.txt");
        let unstaged = find(&status.unstaged, "partial.txt");
        assert_eq!(staged.index_status, "M");
        assert_eq!(staged.worktree_status, "M");
        assert_eq!(unstaged.index_status, "M");
        assert_eq!(unstaged.worktree_status, "M");
    }

    #[test]
    fn marks_files_larger_than_one_megabyte() {
        let dir = TestDir::new();
        let _repository = init_repository(&dir.0, &[]);
        fs::write(dir.0.join("large.bin"), vec![b'x'; 1_048_577]).unwrap();

        let status = read(&dir.0).unwrap();
        let entry = find(&status.unstaged, "large.bin");
        assert_eq!(entry.bytes, 1_048_577);
        assert!(entry.large);
    }

    #[test]
    fn returns_empty_lists_for_a_clean_worktree() {
        let dir = TestDir::new();
        let _repository = init_repository(&dir.0, &[("tracked.txt", "clean\n")]);
        assert_eq!(
            read(&dir.0).unwrap(),
            StatusSummary {
                staged: Vec::new(),
                unstaged: Vec::new(),
            }
        );
    }

    #[test]
    fn refuses_a_locked_index() {
        let dir = TestDir::new();
        let repository = init_repository(&dir.0, &[("tracked.txt", "clean\n")]);
        fs::write(repository.path().join("index.lock"), "").unwrap();

        let error = read(&dir.0).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Io);
        assert!(error.message.contains("index is locked"));
    }

    #[test]
    fn reports_unknown_worktrees_and_invalid_repository_paths() {
        let dir = TestDir::new();
        let _repository = init_repository(&dir.0, &[("tracked.txt", "clean\n")]);
        let unknown_path = dir.0.join("unknown");
        fs::create_dir(&unknown_path).unwrap();
        let store = Store::in_memory().unwrap();
        store
            .save_project(&Project {
                id: "p1".into(),
                owner: None,
                name: "Repo".into(),
                local_path: dir.0.to_string_lossy().into_owned(),
                group_id: None,
            })
            .unwrap();

        let error = validate_catalog_worktree(&store, &unknown_path).unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);

        let non_repository = dir.0.join("not-a-repository");
        fs::create_dir(&non_repository).unwrap();
        let error = read(&non_repository).unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotARepo);
    }

    #[test]
    fn reports_io_failure_when_worktree_path_cannot_be_resolved() {
        let dir = TestDir::new();
        let error = read(&dir.0.join("missing")).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Io);
    }

    /// §9 perf gate — M2 Stage 2: `status::read` on a 10 000-file worktree (200 dirty) must
    /// complete in under 200 ms (wall clock, median over 5 runs). This is a release-mode test;
    /// run with `cargo test --release status::tests::status_refresh_is_under_200ms_for_10k_files`.
    ///
    /// Kept `#[ignore]` so it does not slow the default `./init.sh` loop.  The M2.2 gate
    /// runs it explicitly via `cargo test --release -- --ignored status::tests::status_refresh`.
    #[test]
    #[ignore = "perf gate: run with cargo test --release -- --ignored"]
    fn status_refresh_is_under_200ms_for_10k_files() {
        use git2::Signature;
        use std::time::Instant;

        let dir = TestDir::new();
        let repository = git2::Repository::init(&dir.0).unwrap();
        let mut index = repository.index().unwrap();

        // Create and commit 10 000 files.
        for i in 0u32..10_000 {
            let name = format!("file_{i:05}.txt");
            fs::write(dir.0.join(&name), format!("line1\nline2\nfile {i}\n")).unwrap();
            index.add_path(std::path::Path::new(&name)).unwrap();
        }
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let sig = Signature::now("Perf Test", "perf@test.com").unwrap();
        repository
            .commit(Some("HEAD"), &sig, &sig, "initial 10k files", &tree, &[])
            .unwrap();
        drop(tree);

        // Dirty 200 of the files (every 50th).
        for i in (0u32..10_000).step_by(50) {
            let name = format!("file_{i:05}.txt");
            fs::write(dir.0.join(&name), format!("modified\nline2\nfile {i}\n")).unwrap();
        }

        const RUNS: usize = 5;
        let mut durations = Vec::with_capacity(RUNS);
        for _ in 0..RUNS {
            let t = Instant::now();
            let summary = read(&dir.0).unwrap();
            durations.push(t.elapsed());
            // Sanity: 200 files dirtied → 200 unstaged entries.
            assert_eq!(summary.unstaged.len(), 200);
            assert!(summary.staged.is_empty());
        }
        durations.sort();
        let median_ms = durations[RUNS / 2].as_secs_f64() * 1000.0;
        let max_ms = durations.last().unwrap().as_secs_f64() * 1000.0;
        println!(
            "[m2-stage2-perf] status::read 10k files (200 dirty), {RUNS} runs: \
             samples={} ms  median={median_ms:.1} ms  max={max_ms:.1} ms",
            durations
                .iter()
                .map(|d| format!("{:.1}", d.as_secs_f64() * 1000.0))
                .collect::<Vec<_>>()
                .join(", ")
        );
        // §9 budget: median must be under 200 ms on the baseline Intel i5-1038NG7.
        assert!(
            median_ms < 200.0,
            "status::read median {median_ms:.1} ms exceeds the 200 ms §9 budget"
        );
    }
}
