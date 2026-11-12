//! Local-git reads for the Repository screen (M4 Task 07).
//!
//! Branch list, latest commit, and top-level tree with per-file history.
//! Fixed `git -C` argv, no shell; every call resolves its worktree through
//! the catalog check so commands never escape a registered worktree.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::AppError;
use crate::status::validate_catalog_worktree;
use crate::store::Store;

const MAX_REPO_FILE_BYTES: usize = 10 * 1024 * 1024;

fn run_git(dir: &Path, args: &[&str]) -> Result<String, AppError> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|error| AppError::io(format!("could not run git: {error}")))?;
    if !output.status.success() {
        return Err(AppError::io(format!(
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn latest_entry_history(
    dir: &Path,
    gitref: &str,
    entries: &[GitTreeEntry],
    entry_paths: &[String],
) -> Vec<Option<(String, i64)>> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .args(["log", "--format=%ct%x01%s", "--name-only", "-z"])
        .arg(gitref)
        .arg("--")
        .args(entry_paths.iter().map(|path| format!(":(literal){path}")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return vec![None; entries.len()],
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return vec![None; entries.len()];
    };

    let entry_by_path: HashMap<&str, usize> = entry_paths
        .iter()
        .enumerate()
        .map(|(index, path)| (path.as_str(), index))
        .collect();
    let mut latest = vec![None; entries.len()];
    let mut found = 0;
    let mut commit: Option<(String, i64)> = None;
    let mut reader = BufReader::new(stdout);
    let mut bytes = Vec::new();

    loop {
        bytes.clear();
        match reader.read_until(0, &mut bytes) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if bytes.last() == Some(&0) {
            bytes.pop();
        }
        let record = String::from_utf8_lossy(&bytes);
        let record = record.strip_prefix('\n').unwrap_or(&record);
        if let Some((epoch, message)) = record.split_once('\x01') {
            commit = Some((message.to_string(), epoch.parse().unwrap_or(0)));
            continue;
        }
        let Some((message, epoch)) = commit.as_ref() else {
            continue;
        };
        if record.is_empty() {
            continue;
        }

        let mut matching_entry = entry_by_path.get(record).copied();
        let mut ancestor_end = record.len();
        while matching_entry.is_none() {
            let Some(separator) = record[..ancestor_end].rfind('/') else {
                break;
            };
            ancestor_end = separator;
            matching_entry = entry_by_path
                .get(&record[..ancestor_end])
                .copied()
                .filter(|index| entries[*index].kind == "dir");
        }
        if let Some(index) = matching_entry
            && latest[index].is_none()
        {
            latest[index] = Some((message.clone(), *epoch));
            found += 1;
            if found == entries.len() {
                let _ = child.kill();
                break;
            }
        }
    }
    let _ = child.wait();
    latest
}

/// Branch, tag, or commit for the Code tab selector. Slashes are allowed
/// (`feature/x`); everything that could escape to a flag, revision range,
/// or another path is rejected.
fn validate_ref(gitref: &str) -> Result<String, AppError> {
    let trimmed = gitref.trim().to_string();
    if trimmed.is_empty() || trimmed.len() > 200 {
        return Err(AppError::validation("ref must not be empty".to_string()));
    }
    if trimmed.starts_with('-')
        || trimmed.starts_with('/')
        || trimmed.contains("..")
        || trimmed.chars().any(|c| c.is_whitespace() || c.is_control())
        || trimmed
            .chars()
            .any(|c| matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
    {
        return Err(AppError::validation(
            "ref is not a valid branch, tag, or commit".to_string(),
        ));
    }
    Ok(trimmed)
}

/// Subdirectory inside the worktree, kept relative and dot-free.
/// A leading `/` is treated as worktree-relative, never as an escape.
fn validate_subdir(subdir: &str) -> Result<String, AppError> {
    let trimmed = subdir.trim().trim_matches('/').to_string();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.len() > 500 {
        return Err(AppError::validation("path is too long".to_string()));
    }
    if trimmed
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(AppError::validation(
            "path must stay inside the worktree".to_string(),
        ));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(AppError::validation(
            "path must stay inside the worktree".to_string(),
        ));
    }
    Ok(trimmed.trim_matches('/').to_string())
}

/// Branch selector data: current branch (None when detached), all local
/// branch names sorted, and the tag count.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GitBranches {
    pub current: Option<String>,
    pub branches: Vec<String>,
    pub tag_count: u32,
}

pub fn branches(store: &Store, worktree_path: &Path) -> Result<GitBranches, AppError> {
    let dir = validate_catalog_worktree(store, worktree_path)?;
    let current = run_git(&dir, &["branch", "--show-current"])?;
    let current = {
        let trimmed = current.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    };
    let listed = run_git(&dir, &["branch", "--format=%(refname:short)"])?;
    let mut branch_names: Vec<String> = listed
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    branch_names.sort();
    branch_names.dedup();
    let tags = run_git(&dir, &["tag"])?;
    let tag_count = tags.lines().filter(|line| !line.trim().is_empty()).count() as u32;
    Ok(GitBranches {
        current,
        branches: branch_names,
        tag_count,
    })
}

/// Latest commit on a ref for the latest-commit bar.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GitCommit {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub epoch: i64,
}

pub fn latest_commit(
    store: &Store,
    worktree_path: &Path,
    gitref: &str,
) -> Result<GitCommit, AppError> {
    let dir = validate_catalog_worktree(store, worktree_path)?;
    let gitref = validate_ref(gitref)?;
    let out = run_git(
        &dir,
        &[
            "log",
            "-1",
            "--format=%H%x01%s%x01%an%x01%ct",
            &gitref,
            "--",
        ],
    )?;
    match out.trim_end().split('\x01').collect::<Vec<_>>()[..] {
        [hash, message, author, epoch] if !hash.is_empty() => Ok(GitCommit {
            hash: hash.to_string(),
            message: message.to_string(),
            author: author.to_string(),
            epoch: epoch.parse().unwrap_or(0),
        }),
        _ => Err(AppError::not_found("ref has no commits".to_string())),
    }
}

/// One file-table row: name, dir-vs-file, and its last commit.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GitTreeEntry {
    pub name: String,
    pub kind: String,
    pub message: String,
    pub epoch: i64,
}

/// Top-level entries of `subdir` at `gitref` (empty subdir = root),
/// each with its last commit message and time. Dirs sort first.
pub fn tree(
    store: &Store,
    worktree_path: &Path,
    gitref: &str,
    subdir: &str,
) -> Result<Vec<GitTreeEntry>, AppError> {
    let dir = validate_catalog_worktree(store, worktree_path)?;
    let gitref = validate_ref(gitref)?;
    let subdir = validate_subdir(subdir)?;
    let spec = if subdir.is_empty() {
        gitref.clone()
    } else {
        format!("{gitref}:{subdir}")
    };
    let out = run_git(&dir, &["ls-tree", &spec])?;
    let mut entries = Vec::new();
    for line in out.lines() {
        let (meta, name) = line.split_once('\t').unwrap_or((line, ""));
        if name.is_empty() {
            continue;
        }
        let kind = match meta.split_whitespace().nth(1) {
            Some("tree") => "dir",
            _ => "file",
        }
        .to_string();
        entries.push(GitTreeEntry {
            name: name.to_string(),
            kind,
            message: String::new(),
            epoch: 0,
        });
    }

    // Resolve the latest commit touching any displayed entry in one Git walk.
    // Running `git log -1` once per row made opening a large repository spawn
    // hundreds of processes and repeatedly traverse the same history.
    if !entries.is_empty() {
        let entry_paths: Vec<String> = entries
            .iter()
            .map(|entry| {
                if subdir.is_empty() {
                    entry.name.clone()
                } else {
                    format!("{subdir}/{}", entry.name)
                }
            })
            .collect();
        let latest = latest_entry_history(&dir, &gitref, &entries, &entry_paths);
        for (entry, history) in entries.iter_mut().zip(latest) {
            if let Some((message, epoch)) = history {
                entry.message = message;
                entry.epoch = epoch;
            }
        }
    }
    entries.sort_by(|a, b| {
        (b.kind == "dir")
            .cmp(&(a.kind == "dir"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Read a committed file from a ref without using the active worktree contents.
pub fn read_file(
    store: &Store,
    worktree_path: &Path,
    gitref: &str,
    path: &str,
) -> Result<Vec<u8>, AppError> {
    let dir = validate_catalog_worktree(store, worktree_path)?;
    let gitref = validate_ref(gitref)?;
    let path = validate_subdir(path)?;
    if path.is_empty() {
        return Err(AppError::validation("file path must not be empty"));
    }

    let repository = git2::Repository::open(dir).map_err(AppError::from)?;
    let object = repository
        .revparse_single(&gitref)
        .map_err(AppError::from)?;
    let tree = object.peel_to_tree().map_err(AppError::from)?;
    let entry = tree.get_path(Path::new(&path)).map_err(|error| {
        if error.code() == git2::ErrorCode::NotFound {
            AppError::not_found("file not found")
        } else {
            AppError::from(error)
        }
    })?;
    if entry.kind() != Some(git2::ObjectType::Blob) {
        return Err(AppError::validation("path is not a file"));
    }
    let blob = repository.find_blob(entry.id()).map_err(AppError::from)?;
    if blob.size() > MAX_REPO_FILE_BYTES {
        return Err(AppError::validation("file is too large to preview"));
    }
    Ok(blob.content().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Project;
    use std::path::PathBuf;

    struct TempRepo(PathBuf);

    impl TempRepo {
        fn fresh(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "branchwork-test-repogit-{}-{name}",
                std::process::id()
            ));
            std::fs::remove_dir_all(&dir).ok();
            std::fs::create_dir_all(&dir).unwrap();
            git(&dir, &["init", "-b", "main"]);
            git(&dir, &["config", "user.email", "test@example.com"]);
            git(&dir, &["config", "user.name", "Branchwork test"]);
            Self(dir)
        }

        fn commit_all(&self, message: &str) {
            git(&self.0, &["add", "-A"]);
            git(&self.0, &["commit", "-m", message, "--quiet"]);
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .stdin(std::process::Stdio::null())
            .status()
            .expect("git must run in tests");
        assert!(status.success(), "git {args:?} must succeed");
    }

    fn registered(path: &Path) -> Store {
        let store = Store::in_memory().unwrap();
        store
            .save_project(&Project {
                id: "p1".into(),
                owner: None,
                name: "Repo".into(),
                local_path: path.to_string_lossy().into_owned(),
                group_id: None,
            })
            .unwrap();
        store
    }

    #[test]
    fn branches_lists_current_and_counts_tags() {
        let repo = TempRepo::fresh("branches");
        std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
        repo.commit_all("first");
        git(&repo.0, &["checkout", "-b", "feature", "--quiet"]);
        git(&repo.0, &["tag", "v1"]);
        let store = registered(&repo.0);
        let info = branches(&store, &repo.0).expect("branches must list");
        assert_eq!(info.current.as_deref(), Some("feature"));
        assert_eq!(
            info.branches,
            vec!["feature".to_string(), "main".to_string()]
        );
        assert_eq!(info.tag_count, 1);
    }

    #[test]
    fn latest_commit_reads_message_and_author() {
        let repo = TempRepo::fresh("commit");
        std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
        repo.commit_all("hello world");
        let store = registered(&repo.0);
        let commit = latest_commit(&store, &repo.0, "main").expect("commit must parse");
        assert_eq!(commit.message, "hello world");
        assert_eq!(commit.author, "Branchwork test");
        assert_eq!(commit.hash.len(), 40);
        assert!(commit.epoch > 0);
        assert!(latest_commit(&store, &repo.0, "nope-missing").is_err());
    }

    #[test]
    fn tree_lists_entries_with_history_dirs_first() {
        let repo = TempRepo::fresh("tree");
        std::fs::write(repo.0.join("z.txt"), "z\n").unwrap();
        std::fs::create_dir_all(repo.0.join("sub")).unwrap();
        std::fs::write(repo.0.join("sub").join("b.txt"), "b\n").unwrap();
        repo.commit_all("add files");
        std::fs::write(repo.0.join("z.txt"), "z2\n").unwrap();
        repo.commit_all("touch z");
        let store = registered(&repo.0);
        let entries = tree(&store, &repo.0, "main", "").expect("tree must list");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "sub");
        assert_eq!(entries[0].kind, "dir");
        assert_eq!(entries[0].message, "add files");
        assert_eq!(entries[1].name, "z.txt");
        assert_eq!(entries[1].kind, "file");
        assert_eq!(entries[1].message, "touch z");
        assert!(entries[1].epoch >= entries[0].epoch);
        let sub = tree(&store, &repo.0, "main", "sub").expect("subdir must list");
        assert_eq!(sub.len(), 1);
        assert_eq!(sub[0].name, "b.txt");
    }

    #[test]
    fn read_file_returns_content_from_the_selected_ref() {
        let repo = TempRepo::fresh("read-file");
        std::fs::write(repo.0.join("README.md"), "# main\n").unwrap();
        repo.commit_all("main readme");
        git(&repo.0, &["checkout", "-b", "feature", "--quiet"]);
        std::fs::write(repo.0.join("README.md"), "# feature\n").unwrap();
        repo.commit_all("feature readme");
        let store = registered(&repo.0);

        assert_eq!(
            read_file(&store, &repo.0, "main", "README.md").unwrap(),
            b"# main\n"
        );
        assert_eq!(
            read_file(&store, &repo.0, "feature", "README.md").unwrap(),
            b"# feature\n"
        );
        assert!(read_file(&store, &repo.0, "main", "../README.md").is_err());
    }

    #[test]
    fn refs_and_paths_stay_inside_the_worktree() {
        let repo = TempRepo::fresh("validate");
        std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
        repo.commit_all("first");
        let store = registered(&repo.0);
        for bad in ["", "../x", "a b", "a~1", "-b", "/abs", "a?b"] {
            assert!(latest_commit(&store, &repo.0, bad).is_err(), "{bad:?}");
        }
        for bad in ["..", "../..", "a/../../b", "a/./b"] {
            assert!(tree(&store, &repo.0, "main", bad).is_err(), "{bad:?}");
        }
        // Unknown worktree paths never reach git.
        let empty = Store::in_memory().unwrap();
        assert!(branches(&empty, &repo.0).is_err());
    }
}
