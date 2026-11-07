use crate::error::AppError;
use crate::store::{Project, Store};
use git2::Repository;
use std::{
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

/// Expands a leading `~/` (or a bare `~`) against `home`, leaving every other path
/// untouched. Pulled out as a pure function, parameterized on `home`, so tests don't
/// race on the process-wide `HOME` env var.
fn expand_tilde(path: &Path, home: Option<&OsStr>) -> Result<PathBuf, AppError> {
    let Some(text) = path.to_str() else {
        return Ok(path.to_path_buf());
    };
    if text != "~" && !text.starts_with("~/") {
        return Ok(path.to_path_buf());
    }
    let home = home.ok_or_else(|| {
        AppError::internal("Cannot expand ~: the HOME environment variable is not set")
    })?;
    let home = Path::new(home);
    Ok(if text == "~" {
        home.to_path_buf()
    } else {
        home.join(&text[2..])
    })
}

fn expand_home(path: &Path) -> Result<PathBuf, AppError> {
    expand_tilde(path, std::env::var_os("HOME").as_deref())
}

/// Walks up from `path` to the nearest existing ancestor, canonicalizes it, and
/// rebuilds `path` on top of that canonical root. Every not-yet-existing component
/// must be `Component::Normal` (rejects `..`, `.`, and root segments), so the only
/// thing left for the caller to create is a chain of plain directory names.
fn resolve_missing_ancestor(path: &Path) -> Result<PathBuf, AppError> {
    let mut missing = Vec::new();
    let mut current = path;
    loop {
        let component = current
            .components()
            .next_back()
            .ok_or_else(|| AppError::validation("Clone destination path is invalid"))?;
        let Component::Normal(part) = component else {
            return Err(AppError::validation(
                "Clone destination contains an invalid path segment",
            ));
        };
        missing.push(part);
        let parent = current.parent().ok_or_else(|| {
            AppError::validation("Clone destination has no existing ancestor directory")
        })?;
        if parent.exists() {
            let mut destination = parent.canonicalize().map_err(|error| {
                AppError::io(format!("Clone destination parent is unavailable: {error}"))
            })?;
            missing.reverse();
            for part in missing {
                destination.push(part);
            }
            return Ok(destination);
        }
        current = parent;
    }
}

fn inspect_repository(path: &Path) -> Result<Project, AppError> {
    let repository = Repository::open(path).map_err(|error| {
        AppError::not_a_repo(format!(
            "Cannot open Git repository at {}: {error}",
            path.display()
        ))
    })?;
    let workdir = repository
        .workdir()
        .ok_or_else(|| AppError::not_a_repo("Bare repositories cannot be opened as projects"))?;
    let canonical = workdir
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve repository path: {error}")))?;
    let local_path = canonical.to_string_lossy().into_owned();
    let name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::validation("Repository path has no valid directory name"))?
        .to_string();
    Ok(Project {
        id: local_path.clone(),
        owner: None,
        name,
        local_path,
        group_id: None,
    })
}

fn clone_destination(path: &Path) -> Result<PathBuf, AppError> {
    if !path.is_absolute() {
        return Err(AppError::validation(
            "Clone destination must be an absolute path",
        ));
    }
    if path.file_name().filter(|name| !name.is_empty()).is_none() {
        return Err(AppError::validation(
            "Clone destination must name a directory",
        ));
    }
    let destination = resolve_missing_ancestor(path)?;
    if destination.exists() {
        if !destination.is_dir() {
            return Err(AppError::validation(
                "Clone destination already exists and is not a directory",
            ));
        }
        let mut entries = fs::read_dir(&destination)
            .map_err(|error| AppError::io(format!("Cannot inspect clone destination: {error}")))?;
        if entries.next().is_some() {
            return Err(AppError::validation("Clone destination must be empty"));
        }
        return destination
            .canonicalize()
            .map_err(|error| AppError::io(format!("Cannot resolve clone destination: {error}")));
    }
    Ok(destination)
}

/// Read-only check: `true` only if `path` itself is a Git repository root/worktree. Uses
/// `Repository::open` (no parent search), so a subfolder of a repo returns `false`. Never
/// executes anything from the repository.
pub fn is_repository(path: &Path) -> Result<bool, AppError> {
    let path = expand_home(path)?;
    if !path.is_absolute() {
        return Err(AppError::validation(
            "Repository path must be an absolute path",
        ));
    }
    Ok(Repository::open(&path).is_ok())
}

pub fn open_and_register(path: &Path, store: &Store) -> Result<Project, AppError> {
    let path = expand_home(path)?;
    if !path.is_absolute() {
        return Err(AppError::validation(
            "Repository path must be an absolute path",
        ));
    }
    let project = inspect_repository(&path)?;
    if let Some(existing) = store.project_by_path(&project.local_path)? {
        return Ok(existing);
    }
    store.save_project(&project)?;
    Ok(project)
}

pub fn clone_and_register(url: &str, path: &Path, store: &Store) -> Result<Project, AppError> {
    if url.trim().is_empty() {
        return Err(AppError::validation("Clone source must not be empty"));
    }
    let path = expand_home(path)?;
    let destination = clone_destination(&path)?;
    let destination_text = destination
        .to_str()
        .ok_or_else(|| AppError::validation("Clone destination path is not valid UTF-8"))?;
    if store.project_by_path(destination_text)?.is_some() {
        return Err(AppError::validation(
            "A project is already registered at the clone destination",
        ));
    }

    let output = Command::new("git")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "http.lowSpeedLimit=1000",
            "-c",
            "http.lowSpeedTime=60",
            "clone",
            "--",
            url,
            destination_text,
        ])
        .output()
        .map_err(|error| AppError::io(format!("Could not start Git clone: {error}")))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::internal(if detail.is_empty() {
            format!("Git clone failed with status {}", output.status)
        } else {
            format!("Git clone failed: {detail}")
        }));
    }

    let project = inspect_repository(&destination)?;
    store.save_project(&project)?;
    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use git2::{Repository, Signature};
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "branchwork-m1-repository-{}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn init_repository(path: &Path) {
        let repository = Repository::init(path).unwrap();
        let mut index = repository.index().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = Signature::now("Branchwork test", "test@example.com").unwrap();
        repository
            .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
    }

    #[test]
    fn opens_and_registers_a_repository_idempotently() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        fs::create_dir(&path).unwrap();
        init_repository(&path);
        let store = Store::in_memory().unwrap();

        let project = open_and_register(&path, &store).unwrap();
        assert_eq!(project.name, "repo");
        assert_eq!(store.list_projects().unwrap(), vec![project.clone()]);
        assert_eq!(open_and_register(&path, &store).unwrap(), project);
        assert_eq!(store.list_projects().unwrap().len(), 1);
    }

    #[test]
    fn rejects_a_non_repository_path() {
        let temp = TestDir::new();
        let path = temp.0.join("not-a-repository");
        fs::create_dir(&path).unwrap();
        let error = open_and_register(&path, &Store::in_memory().unwrap()).unwrap_err();
        assert!(error.message.contains("Cannot open Git repository"));
    }

    #[test]
    fn clones_and_registers_without_overwriting_occupied_destinations() {
        let temp = TestDir::new();
        let source = temp.0.join("source");
        fs::create_dir(&source).unwrap();
        init_repository(&source);
        let destination = temp.0.join("clone");
        let store = Store::in_memory().unwrap();

        let project = clone_and_register(source.to_str().unwrap(), &destination, &store).unwrap();
        assert_eq!(
            project.local_path,
            destination.canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(store.list_projects().unwrap(), vec![project]);

        let occupied = temp.0.join("occupied");
        fs::create_dir(&occupied).unwrap();
        fs::write(occupied.join("keep.txt"), "keep").unwrap();
        assert!(
            clone_and_register(source.to_str().unwrap(), &occupied, &store)
                .unwrap_err()
                .message
                .contains("must be empty")
        );
        assert_eq!(
            fs::read_to_string(occupied.join("keep.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn clone_errors_are_returned_and_empty_source_is_rejected() {
        let temp = TestDir::new();
        let destination = temp.0.join("clone");
        let store = Store::in_memory().unwrap();
        assert!(
            clone_and_register(" ", &destination, &store)
                .unwrap_err()
                .message
                .contains("must not be empty")
        );
        assert!(clone_and_register("/not/a/repository", &destination, &store).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn expand_tilde_resolves_against_the_given_home_and_requires_one() {
        let home = Path::new("/Users/example");
        assert_eq!(
            expand_tilde(Path::new("~/clients/repo"), Some(home.as_os_str())).unwrap(),
            PathBuf::from("/Users/example/clients/repo")
        );
        assert_eq!(
            expand_tilde(Path::new("~"), Some(home.as_os_str())).unwrap(),
            PathBuf::from("/Users/example")
        );
        assert_eq!(
            expand_tilde(Path::new("/already/absolute"), Some(home.as_os_str())).unwrap(),
            PathBuf::from("/already/absolute")
        );
        assert!(
            expand_tilde(Path::new("~/clients/repo"), None)
                .unwrap_err()
                .message
                .contains("HOME")
        );
    }

    #[test]
    fn clone_creates_missing_parent_directories() {
        let temp = TestDir::new();
        let source = temp.0.join("source");
        fs::create_dir(&source).unwrap();
        init_repository(&source);
        let destination = temp.0.join("a").join("b").join("clone");
        let store = Store::in_memory().unwrap();

        let project = clone_and_register(source.to_str().unwrap(), &destination, &store).unwrap();
        assert_eq!(
            project.local_path,
            destination.canonicalize().unwrap().to_string_lossy()
        );
    }

    #[test]
    fn clone_rejects_a_destination_with_dotdot_in_the_missing_part() {
        let temp = TestDir::new();
        let destination = temp.0.join("a").join("..").join("clone");
        assert!(
            clone_destination(&destination)
                .unwrap_err()
                .message
                .contains("invalid path segment")
        );
    }

    #[test]
    fn open_rejects_a_relative_path() {
        let error = open_and_register(Path::new("relative/repo"), &Store::in_memory().unwrap())
            .unwrap_err();
        assert!(error.message.contains("absolute path"));
    }

    #[test]
    fn is_repository_detects_a_repository_root_only() {
        let temp = TestDir::new();
        let repo = temp.0.join("repo");
        fs::create_dir(&repo).unwrap();
        init_repository(&repo);
        assert!(is_repository(&repo).unwrap());

        let plain = temp.0.join("plain");
        fs::create_dir(&plain).unwrap();
        assert!(!is_repository(&plain).unwrap());

        let nested = repo.join("src");
        fs::create_dir(&nested).unwrap();
        assert!(!is_repository(&nested).unwrap());

        assert!(
            is_repository(Path::new("relative/repo"))
                .unwrap_err()
                .message
                .contains("absolute path")
        );
    }
}
