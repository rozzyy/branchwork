use crate::error::AppError;
use crate::store::{Project, Store, WorktreePin};
use git2::{BranchType, ErrorCode, Repository, RepositoryState, Status, StatusOptions};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeState {
    Clean,
    Dirty,
    Conflict,
    Rebasing,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub ahead: usize,
    pub behind: usize,
    pub dirty_count: usize,
    pub state: WorktreeState,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeChanged {
    pub worktree: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSummary {
    pub total: usize,
    pub worktrees: Vec<Worktree>,
}

struct PendingChange {
    deadline: Instant,
    index_lock: PathBuf,
}

struct DebounceState {
    pending: HashMap<PathBuf, PendingChange>,
    stopped: bool,
}

struct Debouncer {
    state: Arc<(Mutex<DebounceState>, Condvar)>,
    worker: Option<JoinHandle<()>>,
    delay: Duration,
}

impl Debouncer {
    fn new(delay: Duration, emit: impl Fn(WorktreeChanged) + Send + Sync + 'static) -> Self {
        let state = Arc::new((
            Mutex::new(DebounceState {
                pending: HashMap::new(),
                stopped: false,
            }),
            Condvar::new(),
        ));
        let worker_state = Arc::clone(&state);
        let emit = Arc::new(emit);
        let worker = thread::spawn(move || {
            loop {
                let due = {
                    let (lock, changed) = &*worker_state;
                    let mut state = lock.lock().unwrap();
                    loop {
                        if state.stopped {
                            return;
                        }
                        let Some(deadline) = state.pending.values().map(|item| item.deadline).min()
                        else {
                            state = changed.wait(state).unwrap();
                            continue;
                        };
                        let now = Instant::now();
                        if deadline > now {
                            let (next_state, _) =
                                changed.wait_timeout(state, deadline - now).unwrap();
                            state = next_state;
                            continue;
                        }
                        let due_paths: Vec<_> = state
                            .pending
                            .iter()
                            .filter(|(_, item)| item.deadline <= now)
                            .map(|(path, _)| path.clone())
                            .collect();
                        break due_paths
                            .into_iter()
                            .filter_map(|path| state.pending.remove(&path).map(|item| (path, item)))
                            .collect::<Vec<_>>();
                    }
                };

                for (path, item) in due {
                    if item.index_lock.exists() {
                        let (lock, changed) = &*worker_state;
                        let mut state = lock.lock().unwrap();
                        state.pending.entry(path).or_insert(PendingChange {
                            deadline: Instant::now() + delay,
                            index_lock: item.index_lock,
                        });
                        changed.notify_one();
                    } else {
                        emit(WorktreeChanged {
                            worktree: path.to_string_lossy().into_owned(),
                        });
                    }
                }
            }
        });
        Self {
            state,
            worker: Some(worker),
            delay,
        }
    }

    fn schedule(&self, path: PathBuf, index_lock: PathBuf) {
        let (lock, changed) = &*self.state;
        let mut state = lock.lock().unwrap();
        state.pending.insert(
            path,
            PendingChange {
                deadline: Instant::now() + self.delay,
                index_lock,
            },
        );
        changed.notify_one();
    }
}

impl Drop for Debouncer {
    fn drop(&mut self) {
        let (lock, changed) = &*self.state;
        lock.lock().unwrap().stopped = true;
        changed.notify_one();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

type WatcherDiagnostic = dyn Fn(&Path, &notify::Error) + Send + Sync;

pub struct WorktreeWatcher {
    watchers: Mutex<HashMap<PathBuf, WatchRegistration>>,
    debouncer: Arc<Debouncer>,
    diagnose: Arc<WatcherDiagnostic>,
}

struct WatchRegistration {
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    watched_paths: Arc<Mutex<HashSet<PathBuf>>>,
}

impl WorktreeWatcher {
    pub fn new(emit: impl Fn(WorktreeChanged) + Send + Sync + 'static) -> Self {
        Self::with_diagnostic(emit, |path, error| {
            eprintln!("Worktree watcher error at {}: {error}", path.display());
        })
    }

    fn with_diagnostic(
        emit: impl Fn(WorktreeChanged) + Send + Sync + 'static,
        diagnose: impl Fn(&Path, &notify::Error) + Send + Sync + 'static,
    ) -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
            debouncer: Arc::new(Debouncer::new(DEBOUNCE, emit)),
            diagnose: Arc::new(diagnose),
        }
    }

    fn watch(&self, repository: &Repository, worktree_path: &Path) -> Result<(), AppError> {
        let worktree_path = worktree_path
            .canonicalize()
            .map_err(|error| AppError::io(format!("Cannot resolve worktree path: {error}")))?;
        let git_dir = repository
            .path()
            .canonicalize()
            .map_err(|error| AppError::io(format!("Cannot resolve Git directory: {error}")))?;
        let common_dir = repository.commondir().canonicalize().map_err(|error| {
            AppError::io(format!("Cannot resolve common Git directory: {error}"))
        })?;
        let mut metadata_paths = HashMap::new();
        metadata_paths.insert(git_dir.clone(), RecursiveMode::NonRecursive);
        metadata_paths.insert(common_dir.clone(), RecursiveMode::NonRecursive);
        for directory in ["refs", "reftable"] {
            let path = common_dir.join(directory);
            metadata_paths.insert(path, RecursiveMode::Recursive);
        }
        for directory in ["rebase-merge", "rebase-apply"] {
            let path = git_dir.join(directory);
            metadata_paths.insert(path, RecursiveMode::Recursive);
        }
        let metadata_paths: Vec<_> = metadata_paths.into_iter().collect();
        let existing_metadata_paths = metadata_paths
            .iter()
            .filter(|(path, _)| path.is_dir())
            .cloned()
            .collect::<Vec<_>>();
        let worktree_paths = worktree_watch_paths(&worktree_path)?;
        let index_lock = git_dir.join("index.lock");
        let mut watchers = self.watchers.lock().unwrap();
        if let Some(registration) = watchers.get_mut(&worktree_path) {
            let mut watcher = registration.watcher.lock().unwrap();
            let watcher = watcher
                .as_mut()
                .ok_or_else(|| "Worktree watcher is not initialized".to_string())?;
            let mut watched_paths = registration.watched_paths.lock().unwrap();
            register_paths(
                watcher,
                &mut watched_paths,
                worktree_paths
                    .into_iter()
                    .chain(existing_metadata_paths.iter().cloned()),
                &worktree_path,
            )?;
            return Ok(());
        }

        let worktree_root = worktree_path.clone();
        let debouncer = Arc::clone(&self.debouncer);
        let diagnose = Arc::clone(&self.diagnose);
        let watcher_slot: Arc<Mutex<Option<RecommendedWatcher>>> = Arc::new(Mutex::new(None));
        let watched_paths_slot = Arc::new(Mutex::new(HashSet::new()));
        let callback_watcher = Arc::downgrade(&watcher_slot);
        let callback_watched_paths = Arc::downgrade(&watched_paths_slot);
        let callback_worktree = worktree_root.clone();
        let callback_git_dir = git_dir.clone();
        let callback_metadata_paths = metadata_paths.clone();
        let watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                let new_directory_watcher = callback_watcher.clone();
                let new_directory_paths = callback_watched_paths.clone();
                let new_directory_root = callback_worktree.clone();
                let new_directory_diagnose = Arc::clone(&diagnose);
                handle_notification(
                    result,
                    &callback_worktree,
                    &callback_git_dir,
                    &callback_metadata_paths,
                    |path| {
                        let directory_watcher = new_directory_watcher.clone();
                        let directory_paths = new_directory_paths.clone();
                        let root = new_directory_root.clone();
                        let failure_root = root.clone();
                        let diagnose = Arc::clone(&new_directory_diagnose);
                        let path = path.to_path_buf();
                        let directory = path.clone();
                        if let Err(error) = thread::Builder::new()
                            .name("branchwork-worktree-watch".into())
                            .spawn(move || {
                                let (Some(watcher), Some(watched_paths)) =
                                    (directory_watcher.upgrade(), directory_paths.upgrade())
                                else {
                                    return;
                                };
                                let mut watcher = watcher.lock().unwrap();
                                let Some(watcher) = watcher.as_mut() else {
                                    return;
                                };
                                let mut watched_paths = watched_paths.lock().unwrap();
                                if watched_paths.contains(&path) {
                                    return;
                                }
                                match watcher.watch(&path, RecursiveMode::Recursive) {
                                    Ok(()) => {
                                        watched_paths.insert(path);
                                    }
                                    Err(error) => diagnose(&root, &error),
                                }
                            })
                        {
                            eprintln!(
                                "Could not schedule watcher for {} in {}: {error}",
                                directory.display(),
                                failure_root.display()
                            );
                        }
                    },
                    || debouncer.schedule(worktree_root.clone(), index_lock.clone()),
                    |error| diagnose(&callback_worktree, error),
                );
            },
            Config::default(),
        )
        .map_err(|error| format!("Cannot watch worktree: {error}"))?;

        *watcher_slot.lock().unwrap() = Some(watcher);
        {
            let mut watcher = watcher_slot.lock().unwrap();
            let mut watched_paths = watched_paths_slot.lock().unwrap();
            register_paths(
                watcher
                    .as_mut()
                    .ok_or_else(|| "Worktree watcher is not initialized".to_string())?,
                &mut watched_paths,
                worktree_paths.into_iter().chain(existing_metadata_paths),
                &worktree_path,
            )?;
        }
        watchers.insert(
            worktree_path,
            WatchRegistration {
                watcher: watcher_slot,
                watched_paths: watched_paths_slot,
            },
        );
        Ok(())
    }

    #[cfg(test)]
    fn schedule_for_test(&self, path: PathBuf, index_lock: PathBuf) {
        self.debouncer.schedule(path, index_lock);
    }

    #[cfg(test)]
    fn with_test_delay(
        delay: Duration,
        emit: impl Fn(WorktreeChanged) + Send + Sync + 'static,
    ) -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
            debouncer: Arc::new(Debouncer::new(delay, emit)),
            diagnose: Arc::new(|path, error| {
                eprintln!("Worktree watcher error at {}: {error}", path.display());
            }),
        }
    }
}

fn worktree_watch_paths(worktree_path: &Path) -> Result<Vec<(PathBuf, RecursiveMode)>, AppError> {
    let mut paths = vec![(worktree_path.to_path_buf(), RecursiveMode::NonRecursive)];
    for entry in fs::read_dir(worktree_path)
        .map_err(|error| AppError::io(format!("Cannot inspect worktree directories: {error}")))?
    {
        let entry = entry
            .map_err(|error| AppError::io(format!("Cannot inspect worktree directory: {error}")))?;
        if entry.file_name() != ".git"
            && entry
                .file_type()
                .map_err(|error| AppError::io(format!("Cannot inspect worktree entry: {error}")))?
                .is_dir()
        {
            paths.push((entry.path(), RecursiveMode::Recursive));
        }
    }
    Ok(paths)
}

fn register_paths(
    watcher: &mut RecommendedWatcher,
    registered: &mut HashSet<PathBuf>,
    paths: impl IntoIterator<Item = (PathBuf, RecursiveMode)>,
    worktree_path: &Path,
) -> Result<(), AppError> {
    for (path, mode) in paths {
        if !registered.insert(path.clone()) {
            continue;
        }
        if let Err(error) = watcher.watch(&path, mode) {
            registered.remove(&path);
            return Err(AppError::internal(format!(
                "Cannot watch {} for worktree {}: {error}",
                path.display(),
                worktree_path.display()
            )));
        }
    }
    Ok(())
}

fn handle_notification(
    result: notify::Result<Event>,
    worktree_path: &Path,
    git_dir: &Path,
    metadata_paths: &[(PathBuf, RecursiveMode)],
    on_new_directory: impl Fn(&Path),
    on_change: impl FnOnce(),
    on_error: impl FnOnce(&notify::Error),
) {
    let event = match result {
        Ok(event) => event,
        Err(error) => {
            on_error(&error);
            return;
        }
    };
    if matches!(event.kind, EventKind::Access(_)) {
        return;
    }

    for path in &event.paths {
        if path.parent() == Some(worktree_path)
            && path != &worktree_path.join(".git")
            && !path.starts_with(git_dir)
            && fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
        {
            on_new_directory(path);
        }
    }

    let relevant = event.paths.is_empty()
        || event.paths.iter().any(|path| {
            let metadata_event = metadata_paths
                .iter()
                .any(|(watched_path, mode)| path_matches_watch(path, watched_path, mode));
            let worktree_file_event = path.starts_with(worktree_path)
                && !path.starts_with(git_dir)
                && path != &worktree_path.join(".git");
            metadata_event || worktree_file_event
        });
    if relevant {
        on_change();
    }
}

fn path_matches_watch(path: &Path, watched_path: &Path, mode: &RecursiveMode) -> bool {
    match mode {
        RecursiveMode::Recursive => path.starts_with(watched_path),
        RecursiveMode::NonRecursive => path == watched_path || path.parent() == Some(watched_path),
    }
}

pub fn list(path: &Path, watcher: &WorktreeWatcher) -> Result<Vec<Worktree>, AppError> {
    let repository = Repository::open(path).map_err(|error| {
        AppError::not_a_repo(format!(
            "Invalid Git repository at {}: {error}",
            path.display()
        ))
    })?;
    let main_path = if repository.is_worktree() {
        repository
            .commondir()
            .parent()
            .ok_or_else(|| AppError::internal("Cannot resolve main worktree path"))?
    } else {
        repository
            .workdir()
            .ok_or_else(|| AppError::not_a_repo("Bare repositories do not have worktrees"))?
    }
    .canonicalize()
    .map_err(|error| AppError::io(format!("Cannot resolve repository worktree: {error}")))?;
    let main_repository = Repository::open(&main_path)
        .map_err(|error| AppError::not_a_repo(format!("Cannot open main worktree: {error}")))?;
    let names = main_repository
        .worktrees()
        .map_err(|error| format!("Cannot list linked worktrees: {error}"))?;
    let mut linked_repositories = Vec::new();
    for name in names.iter() {
        let name = name
            .map_err(|error| format!("Cannot decode linked worktree name: {error}"))?
            .ok_or_else(|| "Linked worktree has no name".to_string())?;
        let linked = main_repository
            .find_worktree(name)
            .map_err(|error| format!("Cannot find linked worktree {name}: {error}"))?;
        let linked_repository = Repository::open_from_worktree(&linked).map_err(|error| {
            AppError::not_a_repo(format!("Cannot open linked worktree {name}: {error}"))
        })?;
        let linked_path = linked.path().canonicalize().map_err(|error| {
            AppError::io(format!("Cannot resolve linked worktree {name}: {error}"))
        })?;
        linked_repositories.push((linked_path, linked_repository));
    }
    let mut repositories = vec![(main_path, main_repository)];
    repositories.extend(linked_repositories);

    repositories
        .into_iter()
        .map(|(worktree_path, repository)| {
            let metadata = read_metadata(&repository, &worktree_path)?;
            watcher.watch(&repository, &worktree_path)?;
            Ok(metadata)
        })
        .collect()
}

/// Bounded Launchpad view: count every registered worktree but read metadata for at most `limit`.
pub fn summary(path: &Path, limit: usize) -> Result<WorktreeSummary, AppError> {
    let repository = Repository::open(path).map_err(|error| {
        AppError::not_a_repo(format!(
            "Invalid Git repository at {}: {error}",
            path.display()
        ))
    })?;
    let main_path = if repository.is_worktree() {
        repository
            .commondir()
            .parent()
            .ok_or_else(|| AppError::internal("Cannot resolve main worktree path"))?
    } else {
        repository
            .workdir()
            .ok_or_else(|| AppError::not_a_repo("Bare repositories do not have worktrees"))?
    }
    .canonicalize()
    .map_err(|error| AppError::io(format!("Cannot resolve repository worktree: {error}")))?;
    let main_repository = Repository::open(&main_path)
        .map_err(|error| AppError::not_a_repo(format!("Cannot open main worktree: {error}")))?;
    let names = main_repository
        .worktrees()
        .map_err(|error| AppError::io(format!("Cannot list linked worktrees: {error}")))?;
    let total = names.len().saturating_add(1);
    let mut worktrees = Vec::with_capacity(limit.min(total));
    if limit > 0 {
        worktrees.push(read_metadata(&main_repository, &main_path)?);
    }
    for name in names.iter().take(limit.saturating_sub(1)) {
        let name = name
            .map_err(|error| AppError::io(format!("Cannot decode linked worktree name: {error}")))?
            .ok_or_else(|| AppError::io("Linked worktree has no name"))?;
        let linked = main_repository.find_worktree(name).map_err(|error| {
            AppError::io(format!("Cannot find linked worktree {name}: {error}"))
        })?;
        let linked_repository = Repository::open_from_worktree(&linked).map_err(|error| {
            AppError::not_a_repo(format!("Cannot open linked worktree {name}: {error}"))
        })?;
        let linked_path = linked.path().canonicalize().map_err(|error| {
            AppError::io(format!("Cannot resolve linked worktree {name}: {error}"))
        })?;
        worktrees.push(read_metadata(&linked_repository, &linked_path)?);
    }
    Ok(WorktreeSummary { total, worktrees })
}

fn project_main_repository(path: &Path) -> Result<(PathBuf, Repository), AppError> {
    if !path.is_absolute() {
        return Err(AppError::validation("Project path must be absolute"));
    }
    let project_path = path.canonicalize().map_err(|error| {
        AppError::io(format!(
            "Cannot resolve project path {}: {error}",
            path.display()
        ))
    })?;
    let project_repository = Repository::open(&project_path).map_err(|error| {
        AppError::not_a_repo(format!(
            "Invalid Git repository at {}: {error}",
            path.display()
        ))
    })?;
    let workdir = project_repository
        .workdir()
        .ok_or_else(|| {
            AppError::not_a_repo("Bare repositories cannot be used for worktree operations")
        })?
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve project worktree: {error}")))?;
    if workdir != project_path {
        return Err(AppError::validation(
            "Project path must be the root of a registered worktree",
        ));
    }
    let main_path = if project_repository.is_worktree() {
        project_repository
            .commondir()
            .parent()
            .ok_or_else(|| AppError::internal("Cannot resolve main worktree path"))?
    } else {
        project_repository
            .workdir()
            .ok_or_else(|| AppError::not_a_repo("Bare repositories do not have worktrees"))?
    }
    .canonicalize()
    .map_err(|error| AppError::io(format!("Cannot resolve main worktree path: {error}")))?;
    let main_repository = Repository::open(&main_path)
        .map_err(|error| AppError::not_a_repo(format!("Cannot open main worktree: {error}")))?;
    Ok((main_path, main_repository))
}

fn registered_worktree_paths(repository: &Repository) -> Result<Vec<PathBuf>, AppError> {
    let mut paths = Vec::new();
    let main = repository
        .workdir()
        .ok_or_else(|| AppError::not_a_repo("Bare repositories do not have worktrees"))?
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve main worktree path: {error}")))?;
    paths.push(main);
    let names = repository
        .worktrees()
        .map_err(|error| format!("Cannot list linked worktrees: {error}"))?;
    for name in names.iter() {
        let name = name
            .map_err(|error| format!("Cannot decode linked worktree name: {error}"))?
            .ok_or_else(|| "Linked worktree has no name".to_string())?;
        let linked = repository
            .find_worktree(name)
            .map_err(|error| format!("Cannot find linked worktree {name}: {error}"))?;
        if let Ok(path) = linked.path().canonicalize() {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn resolve_worktree_destination(path: &Path) -> Result<PathBuf, AppError> {
    if !path.is_absolute() {
        return Err(AppError::validation(
            "Worktree destination must be an absolute path",
        ));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(AppError::validation(
            "Worktree destination contains an invalid path segment",
        ));
    }
    let mut missing = Vec::new();
    let mut current = path;
    loop {
        let component = current
            .components()
            .next_back()
            .ok_or_else(|| AppError::validation("Worktree destination path is invalid"))?;
        let Component::Normal(part) = component else {
            return Err(AppError::validation(
                "Worktree destination must name a directory",
            ));
        };
        missing.push(part.to_os_string());
        let parent = current
            .parent()
            .ok_or_else(|| AppError::validation("Worktree destination has no existing ancestor"))?;
        if parent.exists() {
            let mut destination = parent.canonicalize().map_err(|error| {
                AppError::io(format!(
                    "Cannot resolve worktree destination parent: {error}"
                ))
            })?;
            missing.reverse();
            destination.extend(missing);
            return Ok(destination);
        }
        current = parent;
    }
}

fn ensure_destination_missing(path: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(AppError::validation(format!(
            "Worktree destination already exists: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::io(format!(
            "Cannot inspect worktree destination {}: {error}",
            path.display()
        ))),
    }
}

fn resolve_existing_worktree_path(path: &Path) -> Result<PathBuf, AppError> {
    if !path.is_absolute() {
        return Err(AppError::validation(
            "Worktree path must be an absolute path",
        ));
    }
    let canonical = path.canonicalize().map_err(|error| {
        AppError::io(format!(
            "Cannot resolve worktree path {}: {error}",
            path.display()
        ))
    })?;
    Ok(canonical)
}

/// Resolves a pin only when it names the selected project's main or linked worktree.
pub fn validate_pin(project_path: &Path, worktree_path: &Path) -> Result<String, AppError> {
    let (_, repository) = project_main_repository(project_path)?;
    let worktree_path = resolve_existing_worktree_path(worktree_path)?;
    if !registered_worktree_paths(&repository)?.contains(&worktree_path) {
        return Err(AppError::not_found(format!(
            "Path {} is not a registered worktree for this project",
            worktree_path.display()
        )));
    }
    worktree_path
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::validation("Worktree path is not valid UTF-8"))
}

fn git_command(repository_path: &Path) -> Command {
    let mut command = git_command_with_user_config(repository_path);
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null");
    command
}

/// Like [`git_command`], but keeps the user's global/system config (identity, credential
/// helpers, signing) so user-facing writes behave as they do in a terminal (spec §2).
fn git_command_with_user_config(repository_path: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        // No TTY: a configured editor (e.g. `code --wait` for `pull.rebase=interactive`) would
        // block the worker forever. Callers that need an editor set these explicitly.
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_CONFIG_COUNT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_NAMESPACE")
        .env_remove("GIT_CONFIG")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_SYSTEM");
    command
}

pub(crate) fn configured_checkout_filters(
    repository_path: &Path,
) -> Result<HashSet<String>, AppError> {
    let mut filters = HashSet::new();
    let worktree_config = git_command(repository_path)
        .args([
            "config",
            "--local",
            "--bool",
            "--get",
            "extensions.worktreeConfig",
        ])
        .output()
        .map_err(|error| {
            AppError::io(format!(
                "Could not inspect Git worktree configuration: {error}"
            ))
        })?;
    let worktree_config_enabled = if worktree_config.status.success() {
        String::from_utf8_lossy(&worktree_config.stdout)
            .trim()
            .eq_ignore_ascii_case("true")
    } else if worktree_config.status.code() == Some(1) {
        false
    } else {
        let detail = String::from_utf8_lossy(&worktree_config.stderr)
            .trim()
            .to_string();
        return Err(AppError::internal(if detail.is_empty() {
            format!(
                "Could not inspect Git worktree configuration: status {}",
                worktree_config.status
            )
        } else {
            format!("Could not inspect Git worktree configuration: {detail}")
        }));
    };
    let scopes = if worktree_config_enabled {
        vec!["--local", "--worktree"]
    } else {
        vec!["--local"]
    };
    for scope in scopes {
        let output = git_command(repository_path)
            .args([
                "config",
                scope,
                "--name-only",
                "--get-regexp",
                r"^filter\..*\.(smudge|process)$",
            ])
            .output()
            .map_err(|error| {
                AppError::io(format!("Could not inspect Git checkout filters: {error}"))
            })?;
        if !output.status.success() {
            if output.status.code() == Some(1) {
                continue;
            }
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(AppError::internal(if detail.is_empty() {
                format!(
                    "Could not inspect Git checkout filters: status {}",
                    output.status
                )
            } else {
                format!("Could not inspect Git checkout filters: {detail}")
            }));
        }
        for key in String::from_utf8_lossy(&output.stdout).lines() {
            let Some(filter_key) = key.strip_prefix("filter.") else {
                continue;
            };
            let Some((name, operation)) = filter_key.rsplit_once('.') else {
                continue;
            };
            if !name.is_empty() && matches!(operation, "smudge" | "process") {
                filters.insert(name.to_owned());
            }
        }
    }
    Ok(filters)
}

pub(crate) fn run_git_write_with_filters(
    repository_path: &Path,
    args: &[&OsStr],
    filters: &HashSet<String>,
) -> Result<Output, AppError> {
    let output = invoke_git_with_filters(repository_path, args, filters, true)?;
    if output.status.success() {
        return Ok(output);
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(AppError::internal(if detail.is_empty() {
        format!(
            "Git worktree operation failed with status {}",
            output.status
        )
    } else {
        format!("Git worktree operation failed: {detail}")
    }))
}

/// Like [`run_git_write_with_filters`], but keeps the user's hooks and global/system config
/// (commit/push/sync/stash need the user's identity, credential helper and signing), and returns
/// the raw process output even on non-zero exit so callers can classify hook/auth/conflict
/// failures. Local checkout filters stay neutralized.
pub(crate) fn invoke_git_allowing_hooks(
    repository_path: &Path,
    args: &[&OsStr],
    filters: &HashSet<String>,
) -> Result<Output, AppError> {
    run_with_filters(
        git_command_with_user_config(repository_path),
        args,
        filters,
        false,
    )
}

fn invoke_git_with_filters(
    repository_path: &Path,
    args: &[&OsStr],
    filters: &HashSet<String>,
    disable_hooks: bool,
) -> Result<Output, AppError> {
    run_with_filters(git_command(repository_path), args, filters, disable_hooks)
}

fn run_with_filters(
    command: Command,
    args: &[&OsStr],
    filters: &HashSet<String>,
    disable_hooks: bool,
) -> Result<Output, AppError> {
    run_with_config(command, args, filters, disable_hooks, &[])
}

/// Like [`invoke_git_allowing_hooks`], plus `extra` config entries passed only through the
/// child's `GIT_CONFIG_*` environment (never argv or stored config). Used for the publish push,
/// whose auth header must not leak: trace variables that could log it are removed.
pub(crate) fn invoke_git_with_extra_config(
    repository_path: &Path,
    args: &[&OsStr],
    filters: &HashSet<String>,
    extra: &[(String, String)],
) -> Result<Output, AppError> {
    let mut command = git_command_with_user_config(repository_path);
    // Every trace channel that can print config values or HTTP headers (trace2 with
    // `GIT_TRACE2_CONFIG_PARAMS`/`GIT_TRACE2_ENV_VARS` echoes the Authorization header).
    for name in [
        "GIT_TRACE",
        "GIT_TRACE_CURL",
        "GIT_TRACE_PACKET",
        "GIT_TRACE_SETUP",
        "GIT_CURL_VERBOSE",
        "GIT_TRACE2_CONFIG_PARAMS",
        "GIT_TRACE2_ENV_VARS",
    ] {
        command.env_remove(name);
    }
    // trace2 targets can also come from the user's global config, which `-c`/GIT_CONFIG_* can't
    // override early enough; "0" in the environment disables each target outright.
    for name in ["GIT_TRACE2", "GIT_TRACE2_EVENT", "GIT_TRACE2_PERF"] {
        command.env(name, "0");
    }
    run_with_config(command, args, filters, false, extra)
}

/// Like [`invoke_git_allowing_hooks`], with extra environment variables applied last (so they
/// override the defaults, e.g. `GIT_SEQUENCE_EDITOR` for an interactive rebase).
pub(crate) fn invoke_git_with_env(
    repository_path: &Path,
    args: &[&OsStr],
    filters: &HashSet<String>,
    env: &[(&str, String)],
) -> Result<Output, AppError> {
    let mut command = git_command_with_user_config(repository_path);
    for (name, value) in env {
        command.env(name, value);
    }
    run_with_config(command, args, filters, false, &[])
}

fn run_with_config(
    mut command: Command,
    args: &[&OsStr],
    filters: &HashSet<String>,
    disable_hooks: bool,
    extra: &[(String, String)],
) -> Result<Output, AppError> {
    command
        .env(
            "GIT_CONFIG_COUNT",
            (filters.len() * 2 + extra.len()).to_string(),
        )
        .arg("-c")
        .arg("core.fsmonitor=false");
    if disable_hooks {
        command.arg("-c").arg("core.hooksPath=/dev/null");
    }
    for (index, filter) in filters.iter().enumerate() {
        for (offset, operation) in ["smudge", "process"].iter().enumerate() {
            let config_index = index * 2 + offset;
            command
                .env(
                    format!("GIT_CONFIG_KEY_{config_index}"),
                    format!("filter.{filter}.{operation}"),
                )
                .env(format!("GIT_CONFIG_VALUE_{config_index}"), "");
        }
    }
    for (offset, (key, value)) in extra.iter().enumerate() {
        let config_index = filters.len() * 2 + offset;
        command
            .env(format!("GIT_CONFIG_KEY_{config_index}"), key)
            .env(format!("GIT_CONFIG_VALUE_{config_index}"), value);
    }
    command
        .args(args)
        .output()
        .map_err(|error| AppError::io(format!("Could not start Git worktree operation: {error}")))
}

fn run_git_write(repository_path: &Path, args: &[&OsStr]) -> Result<Output, AppError> {
    run_git_write_with_filters(repository_path, args, &HashSet::new())
}

pub fn create(
    project: &Project,
    destination: &Path,
    branch: &str,
    store: &Store,
    watcher: &WorktreeWatcher,
) -> Result<Worktree, AppError> {
    create_from(project, destination, branch, None, store, watcher)
}

pub fn create_at_commit(
    project: &Project,
    destination: &Path,
    branch: &str,
    commit: &str,
    store: &Store,
    watcher: &WorktreeWatcher,
) -> Result<Worktree, AppError> {
    let commit = git2::Oid::from_str(commit).map_err(|error| {
        AppError::validation(format!("Selected commit SHA is invalid: {error}"))
    })?;
    create_from(project, destination, branch, Some(commit), store, watcher)
}

fn create_from(
    project: &Project,
    destination: &Path,
    branch: &str,
    start_point: Option<git2::Oid>,
    store: &Store,
    watcher: &WorktreeWatcher,
) -> Result<Worktree, AppError> {
    if branch.trim().is_empty() || !git2::Reference::is_valid_name(&format!("refs/heads/{branch}"))
    {
        return Err(AppError::validation("Branch name is invalid"));
    }
    let (main_path, repository) = project_main_repository(Path::new(&project.local_path))?;
    if start_point.is_none() && unborn_branch(&repository).is_some() {
        return Err(AppError::validation(
            "Make a first commit before creating worktrees",
        ));
    }
    let mut destination = resolve_worktree_destination(destination)?;
    ensure_destination_missing(&destination)?;
    if registered_worktree_paths(&repository)?
        .iter()
        .any(|worktree| destination.starts_with(worktree))
    {
        return Err(AppError::validation(
            "Worktree destination cannot be inside an existing worktree",
        ));
    }
    let checkout_filters = configured_checkout_filters(&main_path)?;
    if let Some(start_point) = start_point {
        repository
            .find_commit(start_point)
            .map_err(|error| format!("Cannot use selected commit {start_point}: {error}"))?;
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "Worktree destination has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| {
        AppError::io(format!(
            "Cannot create worktree destination parent: {error}"
        ))
    })?;
    let canonical_parent = parent.canonicalize().map_err(|error| {
        AppError::io(format!(
            "Cannot resolve worktree destination parent: {error}"
        ))
    })?;
    let name = destination
        .file_name()
        .ok_or_else(|| "Worktree destination must name a directory".to_string())?
        .to_os_string();
    destination = canonical_parent.join(name);
    ensure_destination_missing(&destination)?;
    if registered_worktree_paths(&repository)?
        .iter()
        .any(|worktree| destination.starts_with(worktree))
    {
        return Err(AppError::validation(
            "Worktree destination cannot be inside an existing worktree",
        ));
    }
    destination
        .to_str()
        .ok_or_else(|| "Worktree destination path is not valid UTF-8".to_string())?;
    let destination_arg = destination.as_os_str();
    let branch_arg = OsStr::new(branch);
    let mut args = vec![
        OsStr::new("worktree"),
        OsStr::new("add"),
        OsStr::new("-b"),
        branch_arg,
        OsStr::new("--"),
        destination_arg,
    ];
    let start_point_text = start_point.map(|commit| commit.to_string());
    if let Some(start_point) = start_point_text.as_deref() {
        args.push(OsStr::new(start_point));
    }
    run_git_write_with_filters(&main_path, &args, &checkout_filters)?;
    let destination = destination.canonicalize().map_err(|error| {
        AppError::io(format!("Git created an unresolved worktree path: {error}"))
    })?;
    let destination_text = destination
        .to_str()
        .ok_or_else(|| "Worktree path is not valid UTF-8".to_string())?
        .to_owned();
    let pin = WorktreePin {
        project_id: project.id.clone(),
        worktree_path: destination_text.clone(),
    };
    if let Err(error) = store.pin_worktree(&pin) {
        let rollback = run_git_write(
            &main_path,
            &[
                OsStr::new("worktree"),
                OsStr::new("remove"),
                OsStr::new("--"),
                OsStr::new(&destination_text),
            ],
        );
        return Err(AppError::internal(match rollback {
            Ok(_) => {
                format!("Worktree pin could not be saved, so the new worktree was removed: {error}")
            }
            Err(rollback_error) => format!(
                "Could not save the worktree pin: {error}; removing the new worktree also failed: {rollback_error}"
            ),
        }));
    }
    list(&main_path, watcher)
        .map_err(|error| {
            format!("Worktree created and pinned, but metadata could not be read: {error}")
        })?
        .into_iter()
        .find(|worktree| worktree.path == destination_text)
        .ok_or_else(|| {
            "Git created the worktree, but it was not returned by the worktree list".into()
        })
}

/// Branch checked out in a worktree that the caller asked to delete with it.
/// Returns `None` for detached worktrees (nothing to delete). Refuses to
/// delete the branch checked out in the main worktree.
fn branch_to_delete(
    main_repository: &git2::Repository,
    worktree_path: &Path,
) -> Result<Option<String>, AppError> {
    let worktree_repo = git2::Repository::open(worktree_path).map_err(|error| {
        AppError::validation(format!("Cannot read worktree git state: {error}"))
    })?;
    let head = worktree_repo
        .head()
        .map_err(|error| AppError::validation(format!("Cannot read worktree branch: {error}")))?;
    if !head.is_branch() {
        return Ok(None);
    }
    let name = head
        .shorthand()
        .map_err(|_| AppError::validation("Worktree branch name is not valid UTF-8"))?
        .to_owned();
    if !git2::Reference::is_valid_name(&format!("refs/heads/{name}")) {
        return Err(AppError::validation("Worktree branch name is invalid"));
    }
    if let Ok(main_head) = main_repository.head()
        && main_head.is_branch()
        && main_head.shorthand().ok() == Some(name.as_str())
    {
        return Err(AppError::validation(
            "Refusing to delete the branch checked out in the main worktree",
        ));
    }
    Ok(Some(name))
}

pub fn remove(
    project: &Project,
    worktree_path: &Path,
    store: &Store,
    delete_branch: bool,
) -> Result<(), AppError> {
    let (main_path, repository) = project_main_repository(Path::new(&project.local_path))?;
    let worktree_path = resolve_existing_worktree_path(worktree_path)?;
    let main_path = main_path
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve main worktree path: {error}")))?;
    let project_path = Path::new(&project.local_path)
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve selected project path: {error}")))?;
    if worktree_path == main_path {
        return Err(AppError::validation("The main worktree cannot be removed"));
    }
    if worktree_path == project_path {
        return Err(AppError::validation(
            "The selected project's worktree cannot be removed",
        ));
    }
    if !registered_worktree_paths(&repository)?.contains(&worktree_path) {
        return Err(AppError::not_found(format!(
            "Path {} is not a registered worktree for this project",
            worktree_path.display()
        )));
    }
    // Resolve the branch before the worktree (and its gitdir) is gone.
    let delete_target = if delete_branch {
        branch_to_delete(&repository, &worktree_path)?
    } else {
        None
    };
    let path_arg = worktree_path.as_os_str();
    run_git_write(
        &main_path,
        &[
            OsStr::new("worktree"),
            OsStr::new("remove"),
            OsStr::new("--"),
            path_arg,
        ],
    )?;
    if let Some(branch) = delete_target {
        run_git_write(
            &main_path,
            &[
                OsStr::new("branch"),
                OsStr::new("-D"),
                OsStr::new("--"),
                OsStr::new(&branch),
            ],
        )
        .map_err(|error| {
            format!("Worktree removed, but its branch could not be deleted: {error}")
        })?;
    }
    let path_text = worktree_path
        .to_str()
        .ok_or_else(|| "Worktree path is not valid UTF-8".to_string())?;
    store
        .unpin_worktree(&project.id, path_text)
        .map_err(|error| {
            format!("Worktree was removed, but its pin could not be cleared: {error}")
        })?;
    Ok(())
}

pub fn prune(project: &Project) -> Result<(), AppError> {
    let (main_path, _) = project_main_repository(Path::new(&project.local_path))?;
    run_git_write(
        &main_path,
        &[
            OsStr::new("worktree"),
            OsStr::new("prune"),
            OsStr::new("--expire=now"),
        ],
    )?;
    Ok(())
}

/// The branch HEAD points at when the repository has no commits yet ("unborn"), else `None`.
pub(crate) fn unborn_branch(repository: &Repository) -> Option<String> {
    match repository.head() {
        Err(error) if error.code() == ErrorCode::UnbornBranch => repository
            .find_reference("HEAD")
            .ok()?
            .symbolic_target()
            .ok()
            .flatten()
            .map(|target| {
                target
                    .strip_prefix("refs/heads/")
                    .unwrap_or(target)
                    .to_owned()
            }),
        _ => None,
    }
}

fn read_metadata(repository: &Repository, worktree_path: &Path) -> Result<Worktree, AppError> {
    let head_ref = match repository.head() {
        Ok(head_ref) => head_ref,
        // A repository with no commits yet (fresh `git init`): branch from HEAD, no head commit.
        Err(error) if error.code() == ErrorCode::UnbornBranch => {
            let (dirty_count, state) = dirty_state(repository)?;
            return Ok(Worktree {
                path: worktree_path.to_string_lossy().into_owned(),
                branch: unborn_branch(repository),
                head: String::new(),
                ahead: 0,
                behind: 0,
                dirty_count,
                state,
            });
        }
        Err(error) => {
            return Err(AppError::internal(format!(
                "Cannot read HEAD for {}: {error}",
                worktree_path.display()
            )));
        }
    };
    let head = head_ref
        .target()
        .ok_or_else(|| format!("HEAD has no commit in {}", worktree_path.display()))?;
    let branch = if head_ref.is_branch() {
        Some(
            head_ref
                .shorthand()
                .map_err(|error| {
                    format!(
                        "Cannot read branch for {}: {error}",
                        worktree_path.display()
                    )
                })?
                .to_owned(),
        )
    } else {
        None
    };

    let (ahead, behind) = if let Some(branch_name) = &branch {
        match repository.find_branch(branch_name, BranchType::Local) {
            Ok(branch) => match branch.upstream() {
                Ok(upstream) => {
                    let upstream_head = upstream
                        .get()
                        .target()
                        .ok_or_else(|| format!("Upstream has no commit for {branch_name}"))?;
                    repository
                        .graph_ahead_behind(head, upstream_head)
                        .map_err(|error| {
                            format!("Cannot compare {branch_name} with upstream: {error}")
                        })?
                }
                Err(error) if error.code() == ErrorCode::NotFound => (0, 0),
                Err(error) => {
                    return Err(AppError::internal(format!(
                        "Cannot read upstream for {branch_name}: {error}"
                    )));
                }
            },
            Err(error) => {
                return Err(AppError::internal(format!(
                    "Cannot read branch {branch_name}: {error}"
                )));
            }
        }
    } else {
        (0, 0)
    };

    let (dirty_count, state) = dirty_state(repository)?;
    Ok(Worktree {
        path: worktree_path.to_string_lossy().into_owned(),
        branch,
        head: head.to_string(),
        ahead,
        behind,
        dirty_count,
        state,
    })
}

fn dirty_state(repository: &Repository) -> Result<(usize, WorktreeState), AppError> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .include_unmodified(false);
    let statuses = repository
        .statuses(Some(&mut options))
        .map_err(|error| format!("Cannot read worktree status: {error}"))?;
    let mut dirty_paths = HashSet::new();
    let mut has_conflict = false;
    for status in statuses.iter() {
        dirty_paths.insert(status.path_bytes().to_vec());
        has_conflict |= status.status().contains(Status::CONFLICTED);
    }
    let rebasing = matches!(
        repository.state(),
        RepositoryState::Rebase | RepositoryState::RebaseInteractive | RepositoryState::RebaseMerge
    );
    let state = if has_conflict {
        WorktreeState::Conflict
    } else if rebasing {
        WorktreeState::Rebasing
    } else if dirty_paths.is_empty() {
        WorktreeState::Clean
    } else {
        WorktreeState::Dirty
    };

    Ok((dirty_paths.len(), state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature, build::CheckoutBuilder};
    use std::{
        fs,
        path::PathBuf,
        sync::{Mutex, mpsc},
        time::Duration,
    };

    static NEXT_DIR: Mutex<u64> = Mutex::new(0);

    fn sets_env(command: &Command, key: &str) -> bool {
        command
            .get_envs()
            .any(|(name, value)| name == key && value.is_some())
    }

    // Regression: commit/push/stash ran with the user's global config disabled, dropping their
    // identity, credential helper and signing. Only internal writes stay isolated.
    #[test]
    fn user_facing_writes_keep_global_config_and_internal_writes_isolate_it() {
        let user = git_command_with_user_config(Path::new("."));
        assert!(!sets_env(&user, "GIT_CONFIG_GLOBAL"));
        assert!(!sets_env(&user, "GIT_CONFIG_NOSYSTEM"));
        assert!(sets_env(&user, "GIT_TERMINAL_PROMPT"));

        let isolated = git_command(Path::new("."));
        assert!(sets_env(&isolated, "GIT_CONFIG_GLOBAL"));
        assert!(sets_env(&isolated, "GIT_CONFIG_NOSYSTEM"));
    }

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let mut next = NEXT_DIR.lock().unwrap();
            let path = std::env::temp_dir().join(format!(
                "branchwork-m1-worktree-{}-{}",
                std::process::id(),
                *next
            ));
            *next += 1;
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn init_repository(path: &Path) -> Repository {
        let repository = Repository::init(path).unwrap();
        let mut index = repository.index().unwrap();
        fs::write(path.join("tracked.txt"), "initial").unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = Signature::now("Branchwork test", "test@example.com").unwrap();
        repository
            .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
        drop(tree);
        repository
    }

    fn register_project(path: &Path, store: &Store) -> Project {
        let path = path.canonicalize().unwrap();
        let project = Project {
            id: path.to_string_lossy().into_owned(),
            owner: None,
            name: path.file_name().unwrap().to_string_lossy().into_owned(),
            local_path: path.to_string_lossy().into_owned(),
            group_id: None,
        };
        store.save_project(&project).unwrap();
        project
    }

    fn commit_with_parent(
        repository: &Repository,
        parent: &git2::Commit<'_>,
        message: &str,
        update_head: bool,
    ) -> git2::Oid {
        let tree = parent.tree().unwrap();
        let signature = Signature::now("Branchwork test", "test@example.com").unwrap();
        repository
            .commit(
                update_head.then_some("HEAD"),
                &signature,
                &signature,
                message,
                &tree,
                &[parent],
            )
            .unwrap()
    }

    fn commit_file_change(
        repository: &Repository,
        parent: &git2::Commit<'_>,
        content: &str,
        message: &str,
    ) -> git2::Oid {
        let workdir = repository.workdir().unwrap();
        fs::write(workdir.join("tracked.txt"), content).unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = Signature::now("Branchwork test", "test@example.com").unwrap();
        let oid = repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                message,
                &tree,
                &[parent],
            )
            .unwrap();
        drop(tree);
        oid
    }

    #[test]
    fn lists_main_and_linked_worktree_metadata_and_dirty_state() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        let repository = init_repository(&main_path);
        let linked_path = temp.0.join("linked");
        repository.worktree("feature", &linked_path, None).unwrap();
        fs::write(linked_path.join("tracked.txt"), "changed").unwrap();
        fs::write(linked_path.join("untracked.txt"), "new").unwrap();
        let watcher = WorktreeWatcher::new(|_| {});

        let worktrees = list(&main_path, &watcher).unwrap();
        let _ = list(&main_path, &watcher).unwrap();
        let linked_listing = list(&linked_path, &watcher).unwrap();
        let main_path = main_path.canonicalize().unwrap();
        let linked_path = linked_path.canonicalize().unwrap();

        assert_eq!(worktrees.len(), 2);
        assert_eq!(linked_listing, worktrees);
        assert_eq!(watcher.watchers.lock().unwrap().len(), 2);
        let main = worktrees
            .iter()
            .find(|item| item.path == main_path.to_string_lossy())
            .unwrap();
        assert!(main.branch.is_some());
        assert_eq!(main.ahead, 0);
        assert_eq!(main.behind, 0);
        assert_eq!(main.dirty_count, 0);
        assert_eq!(main.state, WorktreeState::Clean);

        let linked = worktrees
            .iter()
            .find(|item| item.path == linked_path.to_string_lossy())
            .unwrap_or_else(|| panic!("linked worktree not found: {worktrees:?}"));
        assert_eq!(linked.branch.as_deref(), Some("feature"));
        assert_eq!(
            linked.head,
            repository.head().unwrap().target().unwrap().to_string()
        );
        assert_eq!(linked.dirty_count, 2);
        assert_eq!(linked.state, WorktreeState::Dirty);
    }

    #[test]
    fn summary_returns_exact_count_with_a_bounded_metadata_sample() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        fs::create_dir_all(&path).unwrap();
        let _repository = init_repository(&path);
        let one = summary(&path, 1).unwrap();
        assert_eq!(one.total, 1);
        assert_eq!(one.worktrees.len(), 1);
        assert_eq!(
            one.worktrees[0].path,
            path.canonicalize().unwrap().to_string_lossy()
        );

        let zero = summary(&path, 0).unwrap();
        assert_eq!(zero.total, 1);
        assert!(zero.worktrees.is_empty());
    }

    #[test]
    fn creates_lists_and_removes_user_worktrees_without_removing_repository_data() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        let repository = init_repository(&main_path);
        let database_path = temp.0.join("catalog.db");
        let store = Store::open(&database_path).unwrap();
        let project = register_project(&main_path, &store);
        let destination = temp.0.join("worktrees").join("feature");
        let watcher = WorktreeWatcher::new(|_| {});

        let created = create(&project, &destination, "feature", &store, &watcher).unwrap();
        let destination = destination.canonicalize().unwrap();
        assert_eq!(created.path, destination.to_string_lossy());
        assert_eq!(created.branch.as_deref(), Some("feature"));
        assert_eq!(
            store.list_pins(Some(&project.id)).unwrap(),
            vec![WorktreePin {
                project_id: project.id.clone(),
                worktree_path: destination.to_string_lossy().into_owned(),
            }]
        );
        assert_eq!(list(&main_path, &watcher).unwrap().len(), 2);
        drop(store);
        let store = Store::open(&database_path).unwrap();
        assert_eq!(
            store.list_pins(Some(&project.id)).unwrap(),
            vec![WorktreePin {
                project_id: project.id.clone(),
                worktree_path: destination.to_string_lossy().into_owned(),
            }]
        );

        remove(&project, &destination, &store, false).unwrap();
        assert!(!destination.exists());
        assert!(store.list_pins(Some(&project.id)).unwrap().is_empty());
        assert_eq!(
            fs::read_to_string(main_path.join("tracked.txt")).unwrap(),
            "initial"
        );
        assert!(repository.find_branch("feature", BranchType::Local).is_ok());
        assert_eq!(list(&main_path, &watcher).unwrap().len(), 1);
    }

    #[test]
    fn creates_a_worktree_at_the_selected_commit() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        let repository = init_repository(&main_path);
        let selected = repository.head().unwrap().peel_to_commit().unwrap();
        let later = commit_with_parent(&repository, &selected, "later commit", true);
        let store = Store::in_memory().unwrap();
        let project = register_project(&main_path, &store);
        let watcher = WorktreeWatcher::new(|_| {});
        let destination = temp.0.join("worktrees").join("selected");

        let created = create_at_commit(
            &project,
            &destination,
            "selected-commit",
            &selected.id().to_string(),
            &store,
            &watcher,
        )
        .unwrap();

        assert_eq!(created.head, selected.id().to_string());
        assert_ne!(created.head, later.to_string());
        assert_eq!(created.branch.as_deref(), Some("selected-commit"));
    }

    #[test]
    fn does_not_run_configured_smudge_filters_when_creating_a_worktree() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        let repository = init_repository(&main_path);
        fs::write(
            main_path.join(".gitattributes"),
            "tracked.txt filter=branchwork-test\n",
        )
        .unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new(".gitattributes")).unwrap();
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let parent = repository.head().unwrap().peel_to_commit().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = Signature::now("Branchwork test", "test@example.com").unwrap();
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "add filter attribute",
                &tree,
                &[&parent],
            )
            .unwrap();
        drop(tree);
        let marker = temp.0.join("filter-was-run");
        repository
            .config()
            .unwrap()
            .set_str(
                "filter.branchwork-test.smudge",
                &format!("touch {}", marker.display()),
            )
            .unwrap();
        let store = Store::in_memory().unwrap();
        let project = register_project(&main_path, &store);
        let watcher = WorktreeWatcher::new(|_| {});
        let destination = temp.0.join("worktrees").join("filtered");

        let created = create(&project, &destination, "filtered", &store, &watcher).unwrap();

        assert!(!marker.exists());
        assert_eq!(
            fs::read_to_string(Path::new(&created.path).join("tracked.txt")).unwrap(),
            "initial"
        );

        let process_marker = temp.0.join("filter-process-was-run");
        repository
            .config()
            .unwrap()
            .set_str(
                "filter.branchwork-test.process",
                &format!("touch {}", process_marker.display()),
            )
            .unwrap();
        let process_destination = temp.0.join("worktrees").join("filtered-process");
        let process_worktree = create(
            &project,
            &process_destination,
            "filtered-process",
            &store,
            &watcher,
        )
        .unwrap();

        assert!(!process_marker.exists());
        assert_eq!(
            fs::read_to_string(Path::new(&process_worktree.path).join("tracked.txt")).unwrap(),
            "initial"
        );
    }

    #[test]
    fn removes_a_new_worktree_if_its_pin_cannot_be_persisted() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        init_repository(&main_path);
        let project_path = main_path.canonicalize().unwrap();
        let project = Project {
            id: "missing-project".into(),
            owner: None,
            name: "main".into(),
            local_path: project_path.to_string_lossy().into_owned(),
            group_id: None,
        };
        let store = Store::in_memory().unwrap();
        let watcher = WorktreeWatcher::new(|_| {});
        let destination = temp.0.join("worktrees").join("feature");

        let error = create(&project, &destination, "feature", &store, &watcher).unwrap_err();

        assert!(error.message.contains("new worktree was removed"));
        assert!(!destination.exists());
        assert_eq!(
            Repository::open(&main_path)
                .unwrap()
                .worktrees()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn rejects_removing_main_arbitrary_and_dirty_worktrees() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        let repository = init_repository(&main_path);
        let store = Store::in_memory().unwrap();
        let project = register_project(&main_path, &store);
        let linked_path = temp.0.join("linked");
        repository.worktree("linked", &linked_path, None).unwrap();
        let arbitrary = temp.0.join("not-a-worktree");
        fs::create_dir(&arbitrary).unwrap();
        fs::write(arbitrary.join("keep.txt"), "keep").unwrap();

        assert!(
            remove(&project, &main_path, &store, false)
                .unwrap_err()
                .message
                .contains("main worktree")
        );
        assert!(
            remove(&project, &arbitrary, &store, false)
                .unwrap_err()
                .message
                .contains("not a registered worktree")
        );
        assert_eq!(
            fs::read_to_string(arbitrary.join("keep.txt")).unwrap(),
            "keep"
        );

        store
            .pin_worktree(&WorktreePin {
                project_id: project.id.clone(),
                worktree_path: linked_path
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            })
            .unwrap();
        fs::write(linked_path.join("uncommitted.txt"), "keep").unwrap();
        assert!(remove(&project, &linked_path, &store, false).is_err());
        assert!(linked_path.exists());
        assert!(linked_path.join("uncommitted.txt").exists());
        assert_eq!(store.list_pins(Some(&project.id)).unwrap().len(), 1);
    }

    #[test]
    fn removes_worktree_and_branch_together_when_requested() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        let repository = init_repository(&main_path);
        let store = Store::in_memory().unwrap();
        let project = register_project(&main_path, &store);
        let destination = temp.0.join("race");
        let watcher = WorktreeWatcher::new(|_| {});

        create(&project, &destination, "race/x-a", &store, &watcher).unwrap();
        let destination = destination.canonicalize().unwrap();
        remove(&project, &destination, &store, true).unwrap();
        assert!(!destination.exists());
        assert!(
            repository
                .find_branch("race/x-a", BranchType::Local)
                .is_err()
        );
        assert!(store.list_pins(Some(&project.id)).unwrap().is_empty());
    }

    #[test]
    fn keeps_the_branch_when_branch_deletion_is_not_requested() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        let repository = init_repository(&main_path);
        let store = Store::in_memory().unwrap();
        let project = register_project(&main_path, &store);
        let destination = temp.0.join("race");
        let watcher = WorktreeWatcher::new(|_| {});

        create(&project, &destination, "race/x-a", &store, &watcher).unwrap();
        let destination = destination.canonicalize().unwrap();
        remove(&project, &destination, &store, false).unwrap();
        assert!(!destination.exists());
        assert!(
            repository
                .find_branch("race/x-a", BranchType::Local)
                .is_ok()
        );
    }

    #[test]
    fn refuses_to_delete_the_branch_checked_out_in_main() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        let repository = init_repository(&main_path);
        let store = Store::in_memory().unwrap();
        let project = register_project(&main_path, &store);
        let destination = temp.0.join("race");
        let watcher = WorktreeWatcher::new(|_| {});

        create(&project, &destination, "race/x-a", &store, &watcher).unwrap();
        // Point main's HEAD at the same branch through plumbing: the normal
        // checkout refuses a branch that a linked worktree already holds.
        let symbolic = std::process::Command::new("git")
            .args(["symbolic-ref", "HEAD", "refs/heads/race/x-a"])
            .current_dir(&main_path)
            .output()
            .unwrap();
        assert!(symbolic.status.success());
        let destination = destination.canonicalize().unwrap();
        assert!(
            remove(&project, &destination, &store, true)
                .unwrap_err()
                .message
                .contains("main worktree")
        );
        assert!(destination.exists());
        assert!(
            repository
                .find_branch("race/x-a", BranchType::Local)
                .is_ok()
        );
    }

    #[test]
    fn skips_branch_deletion_for_detached_worktrees() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        let repository = init_repository(&main_path);
        let store = Store::in_memory().unwrap();
        let project = register_project(&main_path, &store);
        let destination = temp.0.join("race");
        let watcher = WorktreeWatcher::new(|_| {});

        create(&project, &destination, "race/x-a", &store, &watcher).unwrap();
        let destination = destination.canonicalize().unwrap();
        let linked = git2::Repository::open(&destination).unwrap();
        let target = repository.head().unwrap().target().unwrap();
        linked.set_head_detached(target).unwrap();
        remove(&project, &destination, &store, true).unwrap();
        assert!(!destination.exists());
        assert!(
            repository
                .find_branch("race/x-a", BranchType::Local)
                .is_ok()
        );
    }

    #[test]
    fn pruning_removes_stale_registrations_only() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        let repository = init_repository(&main_path);
        let store = Store::in_memory().unwrap();
        let project = register_project(&main_path, &store);
        let stale_path = temp.0.join("stale");
        repository.worktree("stale", &stale_path, None).unwrap();
        fs::remove_dir_all(&stale_path).unwrap();

        prune(&project).unwrap();

        let refreshed = Repository::open(&main_path).unwrap();
        assert!(refreshed.worktrees().unwrap().is_empty());
        assert_eq!(
            fs::read_to_string(main_path.join("tracked.txt")).unwrap(),
            "initial"
        );
        assert!(!stale_path.exists());
    }

    #[test]
    fn pin_validation_accepts_only_actual_project_worktrees() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        let repository = init_repository(&main_path);
        let linked_path = temp.0.join("linked");
        repository.worktree("linked", &linked_path, None).unwrap();
        let arbitrary = temp.0.join("arbitrary");
        fs::create_dir(&arbitrary).unwrap();
        let other_path = temp.0.join("other");
        fs::create_dir(&other_path).unwrap();
        let other_repository = init_repository(&other_path);
        let other_linked = temp.0.join("other-linked");
        other_repository
            .worktree("other-linked", &other_linked, None)
            .unwrap();

        assert_eq!(
            validate_pin(&main_path, &main_path).unwrap(),
            main_path.canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(
            validate_pin(&main_path, &linked_path).unwrap(),
            linked_path.canonicalize().unwrap().to_string_lossy()
        );
        assert!(
            validate_pin(&main_path, &arbitrary)
                .unwrap_err()
                .message
                .contains("not a registered worktree")
        );
        assert!(
            validate_pin(&main_path, &other_linked)
                .unwrap_err()
                .message
                .contains("not a registered worktree")
        );
    }

    #[test]
    fn creation_rejects_invalid_branch_and_destinations_inside_or_escaping_the_project() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        init_repository(&main_path);
        let store = Store::in_memory().unwrap();
        let project = register_project(&main_path, &store);
        let watcher = WorktreeWatcher::new(|_| {});

        assert!(
            create(
                &project,
                &temp.0.join("valid"),
                "invalid branch",
                &store,
                &watcher,
            )
            .unwrap_err()
            .message
            .contains("Branch name is invalid")
        );
        assert!(
            create(
                &project,
                &main_path.join("nested"),
                "nested",
                &store,
                &watcher,
            )
            .unwrap_err()
            .message
            .contains("inside an existing worktree")
        );
        let escaping = temp.0.join("parent").join("..").join("escaping");
        assert!(
            create(&project, &escaping, "escaping", &store, &watcher)
                .unwrap_err()
                .message
                .contains("invalid path segment")
        );
        assert!(!main_path.join("nested").exists());
        assert!(!temp.0.join("escaping").exists());
    }

    #[test]
    fn emits_changed_for_a_git_ref_update_without_worktree_file_changes() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        fs::create_dir(&path).unwrap();
        let repository = init_repository(&path);
        let worktree_path = path.canonicalize().unwrap();
        let (sender, receiver) = mpsc::channel();
        let watcher = WorktreeWatcher::new(move |event| {
            sender.send(event).unwrap();
        });
        watcher.watch(&repository, &worktree_path).unwrap();
        {
            let registration = watcher.watchers.lock().unwrap();
            let watched_paths = registration
                .get(&worktree_path)
                .unwrap()
                .watched_paths
                .lock()
                .unwrap();
            assert!(watched_paths.contains(&repository.path().to_path_buf()));
            assert!(watched_paths.contains(&repository.path().join("refs")));
            assert!(!watched_paths.contains(&repository.path().join("objects")));
        }

        let parent = repository.head().unwrap().peel_to_commit().unwrap();
        let tree = parent.tree().unwrap();
        let signature = Signature::now("Branchwork test", "test@example.com").unwrap();
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "metadata-only update",
                &tree,
                &[&parent],
            )
            .unwrap();

        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(3)).unwrap(),
            WorktreeChanged {
                worktree: worktree_path.to_string_lossy().into_owned()
            }
        );
    }

    #[test]
    fn reads_nonzero_ahead_and_behind_counts() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        fs::create_dir(&path).unwrap();
        let repository = init_repository(&path);
        let branch_name = repository.head().unwrap().shorthand().unwrap().to_owned();
        let initial = repository.head().unwrap().peel_to_commit().unwrap();
        commit_with_parent(&repository, &initial, "local-only", true);
        let remote_oid = commit_with_parent(&repository, &initial, "remote-only", false);
        repository
            .reference(
                &format!("refs/remotes/origin/{branch_name}"),
                remote_oid,
                true,
                "test upstream",
            )
            .unwrap();
        repository.remote("origin", "/unused/test-remote").unwrap();
        let mut config = repository.config().unwrap();
        config
            .set_str(&format!("branch.{branch_name}.remote"), "origin")
            .unwrap();
        config
            .set_str(
                &format!("branch.{branch_name}.merge"),
                &format!("refs/heads/{branch_name}"),
            )
            .unwrap();

        let metadata = read_metadata(&repository, &path.canonicalize().unwrap()).unwrap();

        assert_eq!(metadata.ahead, 1);
        assert_eq!(metadata.behind, 1);
    }

    #[test]
    fn reports_conflicted_worktree_state() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        fs::create_dir(&path).unwrap();
        let repository = init_repository(&path);
        let branch_name = repository.head().unwrap().shorthand().unwrap().to_owned();
        let initial = repository.head().unwrap().peel_to_commit().unwrap();
        repository.branch("feature", &initial, false).unwrap();

        commit_file_change(&repository, &initial, "main change", "main change");
        repository.set_head("refs/heads/feature").unwrap();
        repository
            .checkout_head(Some(CheckoutBuilder::new().force()))
            .unwrap();
        let feature_parent = repository.head().unwrap().peel_to_commit().unwrap();
        let feature_oid = commit_file_change(
            &repository,
            &feature_parent,
            "feature change",
            "feature change",
        );
        repository
            .set_head(&format!("refs/heads/{branch_name}"))
            .unwrap();
        repository
            .checkout_head(Some(CheckoutBuilder::new().force()))
            .unwrap();
        let feature_commit = repository.find_annotated_commit(feature_oid).unwrap();
        repository.merge(&[&feature_commit], None, None).unwrap();
        assert!(repository.index().unwrap().has_conflicts());

        let metadata = read_metadata(&repository, &path.canonicalize().unwrap()).unwrap();

        assert_eq!(metadata.state, WorktreeState::Conflict);
    }

    #[test]
    fn reports_rebasing_worktree_state() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        fs::create_dir(&path).unwrap();
        let repository = init_repository(&path);
        fs::create_dir(repository.path().join("rebase-merge")).unwrap();

        let metadata = read_metadata(&repository, &path.canonicalize().unwrap()).unwrap();

        assert_eq!(metadata.state, WorktreeState::Rebasing);
    }

    #[test]
    fn watches_files_in_a_top_level_directory_created_after_registration() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        fs::create_dir(&path).unwrap();
        let repository = init_repository(&path);
        let worktree_path = path.canonicalize().unwrap();
        let (sender, receiver) = mpsc::channel();
        let watcher = WorktreeWatcher::new(move |event| {
            sender.send(event).unwrap();
        });
        watcher.watch(&repository, &worktree_path).unwrap();
        let new_directory = worktree_path.join("created-after-watch");
        fs::create_dir(&new_directory).unwrap();

        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let registered = watcher
                .watchers
                .lock()
                .unwrap()
                .get(&worktree_path)
                .unwrap()
                .watched_paths
                .lock()
                .unwrap()
                .contains(&new_directory);
            if registered {
                break;
            }
            assert!(Instant::now() < deadline, "new directory was not watched");
            thread::sleep(Duration::from_millis(10));
        }

        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(3)).unwrap(),
            WorktreeChanged {
                worktree: worktree_path.to_string_lossy().into_owned()
            }
        );
        let quiet_deadline = Instant::now() + Duration::from_millis(350);
        while Instant::now() < quiet_deadline {
            if receiver
                .recv_timeout(quiet_deadline.saturating_duration_since(Instant::now()))
                .is_err()
            {
                break;
            }
        }

        fs::write(new_directory.join("new-file.txt"), "changed").unwrap();
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(3)).unwrap(),
            WorktreeChanged {
                worktree: worktree_path.to_string_lossy().into_owned()
            }
        );
    }

    #[test]
    fn coalesces_events_independently_per_worktree() {
        let temp = TestDir::new();
        let first = temp.0.join("first");
        let second = temp.0.join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let first_repository = init_repository(&first);
        let second_repository = init_repository(&second);
        let first = first.canonicalize().unwrap();
        let second = second.canonicalize().unwrap();
        let (sender, receiver) = mpsc::channel();
        let watcher = WorktreeWatcher::with_test_delay(Duration::from_millis(40), move |event| {
            sender.send(event).unwrap();
        });

        watcher.schedule_for_test(first.clone(), first_repository.path().join("index.lock"));
        watcher.schedule_for_test(second.clone(), second_repository.path().join("index.lock"));
        thread::sleep(Duration::from_millis(20));
        watcher.schedule_for_test(first.clone(), first_repository.path().join("index.lock"));

        let received: HashSet<_> = (0..2)
            .map(|_| {
                receiver
                    .recv_timeout(Duration::from_millis(200))
                    .unwrap()
                    .worktree
            })
            .collect();
        assert_eq!(
            received,
            HashSet::from([
                first.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned()
            ])
        );
        assert!(receiver.recv_timeout(Duration::from_millis(80)).is_err());
    }

    #[test]
    fn retries_the_change_until_index_lock_is_removed() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        fs::create_dir(&path).unwrap();
        let repository = init_repository(&path);
        let index_lock = repository.path().join("index.lock");
        fs::write(&index_lock, "").unwrap();
        let (sender, receiver) = mpsc::channel();
        let watcher = WorktreeWatcher::with_test_delay(Duration::from_millis(30), move |event| {
            sender.send(event).unwrap();
        });
        let worktree_path = path.canonicalize().unwrap();
        watcher.schedule_for_test(worktree_path.clone(), index_lock.clone());

        assert!(receiver.recv_timeout(Duration::from_millis(80)).is_err());
        fs::remove_file(index_lock).unwrap();
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(150)).unwrap(),
            WorktreeChanged {
                worktree: worktree_path.to_string_lossy().into_owned()
            }
        );
    }

    #[test]
    fn reports_watcher_errors_without_emitting_a_changed_event() {
        let mut changed = false;
        let mut diagnostics = Vec::new();

        handle_notification(
            Err(notify::Error::generic("simulated watcher failure")),
            Path::new("/worktree"),
            Path::new("/repo/.git"),
            &[],
            |_| {},
            || changed = true,
            |error| diagnostics.push(error.to_string()),
        );

        assert!(!changed);
        assert_eq!(diagnostics, ["simulated watcher failure"]);
    }

    #[test]
    fn worktree_contract_uses_camel_case_and_lowercase_state() {
        let json = serde_json::to_value(Worktree {
            path: "/repo".into(),
            branch: Some("main".into()),
            head: "abc".into(),
            ahead: 1,
            behind: 2,
            dirty_count: 3,
            state: WorktreeState::Dirty,
        })
        .unwrap();
        assert_eq!(json["dirtyCount"], 3);
        assert_eq!(json["state"], "dirty");
        assert_eq!(
            serde_json::to_value(WorktreeChanged {
                worktree: "/repo".into()
            })
            .unwrap()["worktree"],
            "/repo"
        );
    }

    /// `git init` with HEAD on `main` and no commits.
    fn unborn_repository(path: &Path) -> Repository {
        let repository = Repository::init(path).unwrap();
        repository.set_head("refs/heads/main").unwrap();
        repository
    }

    #[test]
    fn lists_a_repository_with_no_commits() {
        let temp = TestDir::new();
        let path = temp.0.join("fresh");
        fs::create_dir_all(&path).unwrap();
        unborn_repository(&path);
        fs::write(path.join("a.txt"), "a\n").unwrap();

        let listed = summary(&path, 10).unwrap();

        assert_eq!(listed.total, 1);
        let worktree = &listed.worktrees[0];
        assert_eq!(worktree.branch.as_deref(), Some("main"));
        assert_eq!(worktree.head, "");
        assert_eq!((worktree.ahead, worktree.behind), (0, 0));
        assert_eq!(worktree.dirty_count, 1);
    }

    #[test]
    fn create_worktree_requires_a_first_commit() {
        let temp = TestDir::new();
        let main_path = temp.0.join("main");
        fs::create_dir(&main_path).unwrap();
        unborn_repository(&main_path);
        let store = Store::open(&temp.0.join("catalog.db")).unwrap();
        let project = register_project(&main_path, &store);
        let watcher = WorktreeWatcher::new(|_| {});

        let error = create(
            &project,
            &temp.0.join("wt").join("feature"),
            "feature",
            &store,
            &watcher,
        )
        .unwrap_err();

        assert_eq!(error.kind, crate::error::ErrorKind::Validation);
        assert!(error.message.contains("first commit"), "{}", error.message);
    }
}
