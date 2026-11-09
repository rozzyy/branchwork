//! Agent handover notes (spec §6.6.5).
//!
//! The handover dialog writes `.branchwork/handover.md` into the worktree and
//! makes sure `.branchwork/` stays out of Git via `.git/info/exclude`. Both
//! paths are fixed names inside a catalog-registered worktree; the note
//! content is user-edited text with a size cap.

use crate::error::AppError;
use crate::status::validate_catalog_worktree;
use crate::store::Store;
use std::path::{Path, PathBuf};

pub const HANDOVER_DIR: &str = ".branchwork";
pub const HANDOVER_FILE: &str = "handover.md";
pub const NOTE_CAP_BYTES: usize = 200_000;
pub const DIFF_CAP_BYTES: usize = 100_000;

/// Resolve the git dir for a worktree, following linked-worktree git files.
fn git_dir(worktree: &Path) -> Result<PathBuf, AppError> {
    let dot_git = worktree.join(".git");
    let target = if dot_git.is_dir() {
        dot_git
    } else if dot_git.is_file() {
        let content = std::fs::read_to_string(&dot_git).map_err(|error| {
            AppError::io(format!("Could not read worktree git file: {error}"))
        })?;
        let Some(rest) = content.trim().strip_prefix("gitdir: ") else {
            return Err(AppError::validation(
                "Worktree git file has an unexpected shape",
            ));
        };
        if rest.is_empty() || rest.contains('\0') {
            return Err(AppError::validation(
                "Worktree git file has an unexpected shape",
            ));
        }
        dot_git.parent().unwrap_or(worktree).join(rest)
    } else {
        return Err(AppError::not_found("Worktree has no git dir"));
    };
    target.canonicalize().map_err(|error| {
        AppError::io(format!("Could not resolve worktree git dir: {error}"))
    })
}

/// Append the handover ignore entry when it is missing. Returns true on change.
fn ensure_exclude(git: &Path) -> Result<bool, AppError> {
    let info = git.join("info");
    std::fs::create_dir_all(&info)
        .map_err(|error| AppError::io(format!("Could not create git info dir: {error}")))?;
    let path = info.join("exclude");
    let current = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(AppError::io(format!(
                "Could not read git exclude file: {error}"
            )))
        }
    };
    let covered = current
        .lines()
        .any(|line| line.trim() == HANDOVER_DIR || line.trim() == ".branchwork/");
    if covered {
        return Ok(false);
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(".branchwork/\n");
    std::fs::write(&path, next)
        .map_err(|error| AppError::io(format!("Could not write git exclude file: {error}")))?;
    Ok(true)
}

/// Write the handover note and ensure the exclude entry. Returns true when
/// the exclude file changed.
pub fn write_note(store: &Store, worktree_path: &Path, note: &str) -> Result<bool, AppError> {
    if note.len() > NOTE_CAP_BYTES {
        return Err(AppError::validation("Handover note is too large"));
    }
    let worktree = validate_catalog_worktree(store, worktree_path)?;
    let dir = worktree.join(HANDOVER_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|error| AppError::io(format!("Could not create handover dir: {error}")))?;
    std::fs::write(dir.join(HANDOVER_FILE), note)
        .map_err(|error| AppError::io(format!("Could not write handover note: {error}")))?;
    ensure_exclude(&git_dir(&worktree)?)
}

/// Capped `git diff HEAD` text for the handover note.
pub fn read_diff(store: &Store, worktree_path: &Path) -> Result<String, AppError> {
    let worktree = validate_catalog_worktree(store, worktree_path)?;
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .arg("diff")
        .arg("--no-color")
        .arg("HEAD")
        .arg("--")
        .output()
        .map_err(|error| AppError::io(format!("Could not run git diff: {error}")))?;
    if !output.status.success() {
        return Err(AppError::validation("git diff did not succeed for this worktree"));
    }
    let mut bytes = output.stdout;
    let truncated = bytes.len() > DIFF_CAP_BYTES;
    bytes.truncate(DIFF_CAP_BYTES);
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        text.push_str("\n…[handover diff truncated]");
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Project;

    struct TempDir(PathBuf);
    impl TempDir {
        fn fresh(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "branchwork-test-handover-{}-{}",
                std::process::id(),
                name
            ));
            std::fs::remove_dir_all(&dir).ok();
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn init_repository(path: &Path) {
        let repository = git2::Repository::init(path).unwrap();
        std::fs::write(path.join("tracked.txt"), "initial\n").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Branchwork test", "test@example.com").unwrap();
        repository
            .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
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
    fn writes_note_and_exclude_without_touching_user_content() {
        let home = TempDir::fresh("write");
        init_repository(&home.0);
        std::fs::write(home.0.join(".git").join("info").join("exclude"), "# user\n").unwrap();
        let store = registered(&home.0);
        assert!(write_note(&store, &home.0, "# Handover\n\nHello\n").unwrap());
        assert_eq!(
            std::fs::read_to_string(home.0.join(".branchwork").join("handover.md")).unwrap(),
            "# Handover\n\nHello\n"
        );
        let exclude =
            std::fs::read_to_string(home.0.join(".git").join("info").join("exclude")).unwrap();
        assert!(exclude.contains("# user"));
        assert!(exclude.lines().any(|line| line.trim() == ".branchwork/"));
        // Second run changes nothing.
        assert!(!write_note(&store, &home.0, "# Handover\n\nHello\n").unwrap());
    }

    #[test]
    fn follows_linked_worktree_git_files() {
        let home = TempDir::fresh("linked");
        init_repository(&home.0);
        std::fs::create_dir_all(home.0.join("wt")).unwrap();
        std::fs::write(home.0.join("wt").join(".git"), "gitdir: ../.git/worktrees/wt\n").unwrap();
        let gitdir = home.0.join(".git").join("worktrees").join("wt");
        std::fs::create_dir_all(gitdir.join("info")).unwrap();
        let resolved = git_dir(&home.0.join("wt")).unwrap();
        assert!(resolved.ends_with(Path::new(".git/worktrees/wt")));
        assert!(ensure_exclude(&resolved).unwrap());
        assert!(
            std::fs::read_to_string(gitdir.join("info").join("exclude"))
                .unwrap()
                .contains(".branchwork/")
        );
    }

    #[test]
    fn rejects_unregistered_paths_and_oversized_notes() {
        let home = TempDir::fresh("reject");
        init_repository(&home.0);
        let store = Store::in_memory().unwrap();
        let root = home.0.canonicalize().unwrap();
        assert!(write_note(&store, &root, "x").is_err());
        let big = "x".repeat(NOTE_CAP_BYTES + 1);
        let store = registered(&home.0);
        assert!(write_note(&store, &root, &big).is_err());
        assert!(!home.0.join(".branchwork").exists());
    }

    #[test]
    fn reads_capped_diff_text() {
        let home = TempDir::fresh("diff");
        init_repository(&home.0);
        std::fs::write(home.0.join("tracked.txt"), "changed\n").unwrap();
        let store = registered(&home.0);
        let root = home.0.canonicalize().unwrap();
        let diff = read_diff(&store, &root).unwrap();
        assert!(diff.contains("changed"));
        assert!(read_diff(&Store::in_memory().unwrap(), &root).is_err());
    }
}
