mod blame;
mod cli;
mod commit;
mod compare;
mod conflict;
mod conversation;
mod diff;
mod error;
mod fs;
mod gh;
mod gitops;
mod graph;
mod handover;
mod notify;
mod oplog;
mod pty;
mod publish;
mod rebase;
mod repogit;
mod repository;
pub mod saver;
mod quota;
mod stage;
mod stash;
mod status;
mod store;
mod sync;
mod worktree;

use error::AppError;
use pty::{PtyErrorEvent, PtyExit, PtyManager, PtyOutput, PtySession};
use serde::Serialize;
use std::path::Path;
use store::{Group, Project, Store, WorktreePin};
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct OpDone {
    undoable: bool,
}

fn emit_op_done(app: &AppHandle, store: &Store, worktree: &Path) {
    let undoable = worktree
        .canonicalize()
        .ok()
        .and_then(|path| path.to_str().map(str::to_owned))
        .and_then(|path| store.latest_oplog_undoable(&path).ok().flatten())
        .unwrap_or(false);
    emit_op_done_state(app, undoable);
}

fn emit_op_done_state(app: &AppHandle, undoable: bool) {
    if let Err(error) = app.emit("op:done", OpDone { undoable }) {
        eprintln!("Could not emit op:done event: {error}");
    }
}

fn validate_id(id: &str, kind: &str) -> Result<(), AppError> {
    if id.trim().is_empty() {
        Err(AppError::validation(format!("{kind} id must not be empty")))
    } else {
        Ok(())
    }
}

fn validate_group(group: &Group) -> Result<(), AppError> {
    validate_id(&group.id, "group")?;
    if group.name.trim().is_empty() || group.color.trim().is_empty() {
        return Err(AppError::validation(
            "group name and color must not be empty",
        ));
    }
    Ok(())
}

fn validate_project(project: &Project) -> Result<(), AppError> {
    validate_id(&project.id, "project")?;
    if project.name.trim().is_empty() {
        return Err(AppError::validation("project name must not be empty"));
    }
    if !Path::new(&project.local_path).is_absolute() {
        return Err(AppError::validation("project path must be absolute"));
    }
    if project
        .group_id
        .as_deref()
        .is_some_and(|id| id.trim().is_empty())
    {
        return Err(AppError::validation("group id must not be empty"));
    }
    Ok(())
}

fn validate_pin(pin: &WorktreePin) -> Result<(), AppError> {
    validate_id(&pin.project_id, "project")?;
    if !Path::new(&pin.worktree_path).is_absolute() {
        return Err(AppError::validation("worktree path must be absolute"));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn settings_get(store: State<'_, Store>, key: String) -> Result<Option<String>, AppError> {
    Ok(store.get(&key)?)
}

#[tauri::command]
#[specta::specta]
fn settings_set(store: State<'_, Store>, key: String, value: String) -> Result<(), AppError> {
    Ok(store.set(&key, &value)?)
}

#[tauri::command]
#[specta::specta]
fn groups_list(store: State<'_, Store>) -> Result<Vec<Group>, AppError> {
    Ok(store.list_groups()?)
}

#[tauri::command]
#[specta::specta]
fn group_save(store: State<'_, Store>, group: Group) -> Result<(), AppError> {
    validate_group(&group)?;
    Ok(store.save_group(&group)?)
}

#[tauri::command]
#[specta::specta]
fn group_delete(store: State<'_, Store>, id: String) -> Result<bool, AppError> {
    validate_id(&id, "group")?;
    Ok(store.delete_group(&id)?)
}

#[tauri::command]
#[specta::specta]
fn projects_list(store: State<'_, Store>) -> Result<Vec<Project>, AppError> {
    Ok(store.list_projects()?)
}

#[tauri::command]
#[specta::specta]
fn project_save(store: State<'_, Store>, project: Project) -> Result<(), AppError> {
    validate_project(&project)?;
    Ok(store.save_project(&project)?)
}

#[tauri::command]
#[specta::specta]
fn project_delete(store: State<'_, Store>, id: String) -> Result<bool, AppError> {
    validate_id(&id, "project")?;
    Ok(store.delete_project(&id)?)
}

#[tauri::command]
#[specta::specta]
fn pins_list(
    store: State<'_, Store>,
    project_id: Option<String>,
) -> Result<Vec<WorktreePin>, AppError> {
    if let Some(id) = &project_id {
        validate_id(id, "project")?;
    }
    Ok(store.list_pins(project_id.as_deref())?)
}

#[tauri::command]
#[specta::specta]
fn pin_worktree(store: State<'_, Store>, pin: WorktreePin) -> Result<(), AppError> {
    validate_pin(&pin)?;
    let project = project_by_id(&store, &pin.project_id)?;
    let worktree_path = worktree::validate_pin(
        Path::new(&project.local_path),
        Path::new(&pin.worktree_path),
    )?;
    Ok(store.pin_worktree(&WorktreePin {
        project_id: pin.project_id,
        worktree_path,
    })?)
}

#[tauri::command]
#[specta::specta]
fn unpin_worktree(
    store: State<'_, Store>,
    project_id: String,
    worktree_path: String,
) -> Result<bool, AppError> {
    validate_id(&project_id, "project")?;
    if !Path::new(&worktree_path).is_absolute() {
        return Err(AppError::validation("worktree path must be absolute"));
    }
    Ok(store.unpin_worktree(&project_id, &worktree_path)?)
}

#[tauri::command]
#[specta::specta]
fn repository_open(store: State<'_, Store>, path: String) -> Result<Project, AppError> {
    repository::open_and_register(Path::new(&path), &store)
}

fn project_by_id(store: &Store, project_id: &str) -> Result<Project, AppError> {
    store
        .list_projects()?
        .into_iter()
        .find(|project| project.id == project_id)
        .ok_or_else(|| AppError::not_found(format!("Unknown project: {project_id}")))
}

/// Read-only: never executes anything from the repository at `path`.
#[tauri::command]
#[specta::specta]
fn path_is_repository(path: String) -> Result<bool, AppError> {
    repository::is_repository(Path::new(&path))
}

/// Whether the worktree has an `origin` remote of any host (Publish is offered only without).
#[tauri::command(async)]
#[specta::specta]
fn git_has_origin(store: State<'_, Store>, worktree_path: String) -> Result<bool, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    publish::has_origin(&worktree_path)
}

/// Owners (the account and its organizations) a linked account can publish a repository to.
#[tauri::command(async)]
#[specta::specta]
fn gh_publish_owners(account: String) -> Result<Vec<publish::PublishOwner>, AppError> {
    publish::publish_owners(&account)
}

/// Creates a GitHub repository, sets it as origin, and pushes the current branch (issue #5).
#[tauri::command(async)]
#[specta::specta]
fn gh_repo_publish(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    request: publish::PublishRequest,
) -> Result<publish::PublishResult, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = publish::publish(&worktree_path, &request);
    emit_op_done(&app, &store, &worktree_path);
    result
}

/// Classifies a picked folder: repository, inside a repository, not a repository, or invalid.
#[tauri::command(async)]
#[specta::specta]
fn repository_classify(path: String) -> Result<repository::FolderKind, AppError> {
    repository::classify_folder(Path::new(&path))
}

/// Runs `git init` in a folder that isn't a repository yet and registers it (issue #5).
#[tauri::command(async)]
#[specta::specta]
fn repository_init(store: State<'_, Store>, path: String) -> Result<Project, AppError> {
    repository::init_and_register(Path::new(&path), &store)
}

#[tauri::command(async)]
#[specta::specta]
fn worktree_list(
    store: State<'_, Store>,
    watcher: State<'_, worktree::WorktreeWatcher>,
    project_id: String,
) -> Result<Vec<worktree::Worktree>, AppError> {
    validate_id(&project_id, "project")?;
    let project = project_by_id(&store, &project_id)?;
    worktree::list(Path::new(&project.local_path), &watcher)
}

#[tauri::command(async)]
#[specta::specta]
fn worktree_summary(
    store: State<'_, Store>,
    project_id: String,
) -> Result<worktree::WorktreeSummary, AppError> {
    validate_id(&project_id, "project")?;
    let project = project_by_id(&store, &project_id)?;
    worktree::summary(Path::new(&project.local_path), 200)
}

#[tauri::command(async)]
#[specta::specta]
fn worktree_create(
    store: State<'_, Store>,
    watcher: State<'_, worktree::WorktreeWatcher>,
    project_id: String,
    destination: String,
    branch: String,
) -> Result<worktree::Worktree, AppError> {
    validate_id(&project_id, "project")?;
    let project = project_by_id(&store, &project_id)?;
    worktree::create(&project, Path::new(&destination), &branch, &store, &watcher)
}

#[tauri::command(async)]
#[specta::specta]
fn worktree_create_at_commit(
    store: State<'_, Store>,
    watcher: State<'_, worktree::WorktreeWatcher>,
    project_id: String,
    destination: String,
    branch: String,
    commit: String,
) -> Result<worktree::Worktree, AppError> {
    validate_id(&project_id, "project")?;
    let project = project_by_id(&store, &project_id)?;
    worktree::create_at_commit(
        &project,
        Path::new(&destination),
        &branch,
        &commit,
        &store,
        &watcher,
    )
}

#[tauri::command(async)]
#[specta::specta]
fn worktree_remove(
    store: State<'_, Store>,
    project_id: String,
    path: String,
    delete_branch: bool,
) -> Result<(), AppError> {
    validate_id(&project_id, "project")?;
    let project = project_by_id(&store, &project_id)?;
    worktree::remove(&project, Path::new(&path), &store, delete_branch)
}

#[tauri::command(async)]
#[specta::specta]
fn worktree_prune(store: State<'_, Store>, project_id: String) -> Result<(), AppError> {
    validate_id(&project_id, "project")?;
    let project = project_by_id(&store, &project_id)?;
    worktree::prune(&project)
}

// Runs off the main thread: deep pages re-walk history and must not freeze the window.
#[tauri::command(async)]
#[specta::specta]
fn log_graph(
    store: State<'_, Store>,
    project_id: String,
    worktree_path: String,
    page: usize,
) -> Result<graph::GraphPage, AppError> {
    validate_id(&project_id, "project")?;
    let project = project_by_id(&store, &project_id)?;
    graph::read(
        Path::new(&project.local_path),
        Path::new(&worktree_path),
        page,
    )
}

#[tauri::command(async)]
#[specta::specta]
fn graph_commit_detail(
    store: State<'_, Store>,
    project_id: String,
    worktree_path: String,
    sha: String,
) -> Result<graph::GraphCommitDetail, AppError> {
    validate_id(&project_id, "project")?;
    let project = project_by_id(&store, &project_id)?;
    graph::read_commit_detail(
        Path::new(&project.local_path),
        Path::new(&worktree_path),
        &sha,
    )
}

#[tauri::command(async)]
#[specta::specta]
fn graph_commit_file_diff(
    store: State<'_, Store>,
    project_id: String,
    worktree_path: String,
    sha: String,
    path: String,
) -> Result<diff::DiffModel, AppError> {
    validate_id(&project_id, "project")?;
    let project = project_by_id(&store, &project_id)?;
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    graph::read_commit_file_diff(Path::new(&project.local_path), &worktree_path, &sha, &path)
}

// Runs off the main thread: large trees and diffs must not freeze the window.
#[tauri::command(async)]
#[specta::specta]
fn status(
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<status::StatusSummary, AppError> {
    let path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    status::read(&path)
}

// Runs off the main thread: large trees and diffs must not freeze the window.
#[tauri::command(async)]
#[specta::specta]
fn diff_file(
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
    area: diff::DiffArea,
) -> Result<diff::DiffModel, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    diff::read(&worktree_path, &path, area)
}

#[tauri::command(async)]
#[specta::specta]
fn compare_worktrees(
    store: State<'_, Store>,
    a: String,
    b: String,
    include_uncommitted: bool,
) -> Result<compare::CompareSummary, AppError> {
    compare::list(&store, &a, &b, include_uncommitted)
}

#[tauri::command(async)]
#[specta::specta]
fn compare_file_diff(
    store: State<'_, Store>,
    a: String,
    b: String,
    path: String,
    include_uncommitted: bool,
) -> Result<diff::DiffModel, AppError> {
    compare::file_diff(&store, &a, &b, &path, include_uncommitted)
}

#[tauri::command(async)]
#[specta::specta]
fn compare_patch(
    store: State<'_, Store>,
    a: String,
    b: String,
    include_uncommitted: bool,
) -> Result<String, AppError> {
    compare::patch(&store, &a, &b, include_uncommitted)
}

#[tauri::command(async)]
#[specta::specta]
fn commit(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    options: commit::CommitOptions,
) -> Result<bool, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    commit::commit(&store, &worktree_path, &options)?;
    emit_op_done(&app, &store, &worktree_path);
    Ok(store
        .latest_oplog_undoable(worktree_path.to_str().unwrap_or_default())?
        .unwrap_or(false))
}

#[tauri::command(async)]
#[specta::specta]
fn commit_and_push(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    options: commit::CommitOptions,
) -> Result<bool, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    commit::commit_and_push_with_callback(&store, &worktree_path, &options, || {
        emit_op_done(&app, &store, &worktree_path)
    })?;
    Ok(store
        .latest_oplog_undoable(worktree_path.to_str().unwrap_or_default())?
        .unwrap_or(false))
}

#[tauri::command(async)]
#[specta::specta]
fn commit_and_sync(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    options: commit::CommitOptions,
) -> Result<bool, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    commit::commit_and_sync_with_callback(&store, &worktree_path, &options, || {
        emit_op_done(&app, &store, &worktree_path)
    })?;
    Ok(store
        .latest_oplog_undoable(worktree_path.to_str().unwrap_or_default())?
        .unwrap_or(false))
}

#[tauri::command(async)]
#[specta::specta]
fn git_fetch(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    sync::fetch(&worktree_path)?;
    emit_op_done(&app, &store, &worktree_path);
    Ok(())
}

/// Returns whether this pull can be undone (false when it was already up to date).
#[tauri::command(async)]
#[specta::specta]
fn git_pull(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<bool, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = sync::pull(&store, &worktree_path);
    emit_op_done(&app, &store, &worktree_path);
    result
}

#[tauri::command(async)]
#[specta::specta]
fn git_push(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    sync::push(&worktree_path)?;
    emit_op_done(&app, &store, &worktree_path);
    Ok(())
}

/// Commits `base..HEAD` in todo order and whether the branch is already pushed (spec §6.8).
#[tauri::command(async)]
#[specta::specta]
fn rebase_plan(
    store: State<'_, Store>,
    worktree_path: String,
    base: String,
) -> Result<rebase::RebasePlan, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    rebase::plan(&worktree_path, &base)
}

fn emit_rebase_progress(app: &AppHandle, worktree_path: &Path) -> impl Fn(u32, u32) + Sync + use<> {
    let app = app.clone();
    let worktree_path = worktree_path.to_string_lossy().into_owned();
    move |step, total| {
        let event = rebase::RebaseProgress {
            worktree_path: worktree_path.clone(),
            step,
            total,
        };
        if let Err(error) = app.emit("rebase:progress", event) {
            eprintln!("Could not emit rebase:progress: {error}");
        }
    }
}

/// Runs an interactive rebase from a validated plan (spec §6.8); the app binary is git's
/// sequence editor (`--branchwork-rebase-todo`).
#[tauri::command(async)]
#[specta::specta]
fn rebase_interactive(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    request: rebase::RebaseRequest,
) -> Result<rebase::RebaseOutcome, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let exe = std::env::current_exe()
        .map_err(|error| AppError::internal(format!("Could not locate the app binary: {error}")))?;
    let progress = emit_rebase_progress(&app, &worktree_path);
    let result = rebase::interactive(&store, &worktree_path, &request, &exe, &progress);
    emit_op_done(&app, &store, &worktree_path);
    result
}

#[tauri::command(async)]
#[specta::specta]
fn rebase_continue(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<rebase::RebaseOutcome, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let progress = emit_rebase_progress(&app, &worktree_path);
    let result = rebase::continue_rebase(&worktree_path, &progress);
    emit_op_done(&app, &store, &worktree_path);
    result
}

#[tauri::command(async)]
#[specta::specta]
fn rebase_abort(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = rebase::abort_rebase(&worktree_path);
    emit_op_done(&app, &store, &worktree_path);
    result
}

/// Push a rewritten (rebased) branch with `--force-with-lease`; the UI confirms first.
#[tauri::command(async)]
#[specta::specta]
fn git_push_force_with_lease(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = sync::push_force_with_lease(&worktree_path);
    emit_op_done(&app, &store, &worktree_path);
    result
}

/// Conflicted paths and the in-progress operation (spec §6.8).
#[tauri::command(async)]
#[specta::specta]
fn conflict_list(
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<conflict::ConflictList, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    conflict::list(&worktree_path)
}

/// Base/ours/theirs regions of one conflicted file, or a summary for binary/large/deleted files.
#[tauri::command(async)]
#[specta::specta]
fn conflict_read(
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
) -> Result<conflict::ConflictFile, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    conflict::read(&worktree_path, &path)
}

/// Writes and stages a resolution for one conflicted file.
#[tauri::command(async)]
#[specta::specta]
fn conflict_resolve(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
    stamp: String,
    resolution: conflict::ConflictResolution,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = conflict::resolve(&worktree_path, &path, &stamp, &resolution);
    emit_op_done(&app, &store, &worktree_path);
    result
}

/// Aborts the in-progress merge / cherry-pick / revert (the UI confirms first).
#[tauri::command(async)]
#[specta::specta]
fn conflict_abort(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = conflict::abort(&worktree_path);
    emit_op_done(&app, &store, &worktree_path);
    result
}

/// "Mark resolved & commit": continues the operation once no path is conflicted.
#[tauri::command(async)]
#[specta::specta]
fn conflict_continue(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = conflict::continue_operation(&worktree_path);
    emit_op_done(&app, &store, &worktree_path);
    result
}

/// Returns whether the checkout can be undone.
#[tauri::command(async)]
#[specta::specta]
fn git_checkout(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    target: gitops::CheckoutTarget,
) -> Result<bool, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = gitops::checkout(&store, &worktree_path, &target);
    emit_op_done(&app, &store, &worktree_path);
    result
}

#[tauri::command(async)]
#[specta::specta]
fn git_branch_create(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    name: String,
    start_sha: String,
    checkout: bool,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = gitops::branch_create(&worktree_path, &name, &start_sha, checkout);
    emit_op_done(&app, &store, &worktree_path);
    result
}

/// Returns whether the cherry-pick can be undone.
#[tauri::command(async)]
#[specta::specta]
fn git_cherry_pick(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    sha: String,
) -> Result<bool, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = gitops::cherry_pick(&store, &worktree_path, &sha);
    emit_op_done(&app, &store, &worktree_path);
    result
}

/// Returns whether the revert can be undone.
#[tauri::command(async)]
#[specta::specta]
fn git_revert(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    sha: String,
) -> Result<bool, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = gitops::revert(&store, &worktree_path, &sha);
    emit_op_done(&app, &store, &worktree_path);
    result
}

#[tauri::command(async)]
#[specta::specta]
fn undo_last(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<bool, AppError> {
    let path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    oplog::undo_last(&store, &path)?;
    let remaining_undoable = store
        .latest_oplog_undoable(path.to_str().unwrap_or_default())?
        .unwrap_or(false);
    emit_op_done_state(&app, remaining_undoable);
    Ok(remaining_undoable)
}

#[tauri::command(async)]
#[specta::specta]
fn stash_list(
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<Vec<stash::StashEntry>, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    stash::stash_list(&worktree_path)
}

#[tauri::command(async)]
#[specta::specta]
fn stash_push(
    store: State<'_, Store>,
    worktree_path: String,
    options: stash::StashPushOptions,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    stash::stash_push(&worktree_path, &options)
}

#[tauri::command(async)]
#[specta::specta]
fn stash_apply(
    store: State<'_, Store>,
    worktree_path: String,
    index: usize,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    stash::stash_apply(&worktree_path, index)
}

#[tauri::command(async)]
#[specta::specta]
fn stash_pop(store: State<'_, Store>, worktree_path: String, index: usize) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    stash::stash_pop(&worktree_path, index)
}

#[tauri::command(async)]
#[specta::specta]
fn stash_drop(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    index: usize,
) -> Result<bool, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    stash::stash_drop(&store, &worktree_path, index)?;
    emit_op_done(&app, &store, &worktree_path);
    Ok(store
        .latest_oplog_undoable(worktree_path.to_str().unwrap_or_default())?
        .unwrap_or(false))
}

#[tauri::command(async)]
#[specta::specta]
fn stage_paths(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = stage::stage_paths(&store, &worktree_path, &paths);
    emit_op_done(&app, &store, &worktree_path);
    result?;
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
fn unstage_paths(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = stage::unstage_paths(&store, &worktree_path, &paths);
    emit_op_done(&app, &store, &worktree_path);
    result?;
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
fn discard_paths(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    paths: Vec<String>,
    discard_untracked: bool,
) -> Result<bool, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = stage::discard_paths(&store, &worktree_path, &paths, discard_untracked);
    emit_op_done(&app, &store, &worktree_path);
    result?;
    Ok(store
        .latest_oplog_undoable(worktree_path.to_str().unwrap_or_default())?
        .unwrap_or(false))
}

#[tauri::command(async)]
#[specta::specta]
fn stage_hunks(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
    hunk_indices: Vec<usize>,
    area: diff::DiffArea,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = stage::stage_hunks(&store, &worktree_path, &path, &hunk_indices, area);
    emit_op_done(&app, &store, &worktree_path);
    result?;
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
fn unstage_hunks(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
    hunk_indices: Vec<usize>,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = stage::unstage_hunks(&store, &worktree_path, &path, &hunk_indices);
    emit_op_done(&app, &store, &worktree_path);
    result?;
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
fn stage_lines(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
    line_ids: Vec<String>,
    area: diff::DiffArea,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = stage::stage_lines(&store, &worktree_path, &path, &line_ids, area);
    emit_op_done(&app, &store, &worktree_path);
    result?;
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
fn revert_hunk(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
    hunk_index: usize,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let result = stage::revert_hunk(&store, &worktree_path, &path, hunk_index);
    emit_op_done(&app, &store, &worktree_path);
    result?;
    Ok(())
}

// Runs off the main thread: directory listings and file reads must not freeze the window.
#[tauri::command(async)]
#[specta::specta]
fn fs_tree(
    store: State<'_, Store>,
    worktree_path: String,
    options: fs::FsTreeOptions,
) -> Result<fs::FsTree, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    fs::tree(&worktree_path, &options)
}

#[tauri::command(async)]
#[specta::specta]
fn fs_read(
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
) -> Result<fs::FsReadResult, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    fs::read(&worktree_path, &path)
}

#[tauri::command(async)]
#[specta::specta]
fn fs_write(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
    bytes: Vec<u8>,
    expected_mtime: u64,
) -> Result<u64, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    let mtime = fs::write(&store, &worktree_path, &path, bytes, expected_mtime)?;
    emit_op_done(&app, &store, &worktree_path);
    Ok(mtime)
}

#[tauri::command(async)]
#[specta::specta]
fn fs_create(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
    kind: fs::FsEntryKind,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    fs::create(&store, &worktree_path, &path, kind)?;
    emit_op_done(&app, &store, &worktree_path);
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
fn fs_rename(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    from: String,
    to: String,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    fs::rename(&store, &worktree_path, &from, &to)?;
    emit_op_done(&app, &store, &worktree_path);
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
fn fs_delete(
    app: AppHandle,
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
) -> Result<bool, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    fs::delete(&store, &worktree_path, &path)?;
    emit_op_done(&app, &store, &worktree_path);
    Ok(store
        .latest_oplog_undoable(worktree_path.to_str().unwrap_or_default())?
        .unwrap_or(false))
}

#[tauri::command(async)]
#[specta::specta]
fn reveal_in_finder(
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
) -> Result<(), AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    fs::reveal_in_finder(&worktree_path, &path)
}

#[tauri::command(async)]
#[specta::specta]
fn blame(
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
    options: blame::BlameRequest,
) -> Result<blame::BlameResult, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    blame::blame(&worktree_path, &path, options)
}

#[tauri::command(async)]
#[specta::specta]
fn file_history(
    store: State<'_, Store>,
    worktree_path: String,
    path: String,
    options: blame::FileHistoryRequest,
) -> Result<Vec<blame::FileHistoryEntry>, AppError> {
    let worktree_path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    blame::file_history(&worktree_path, &path, options)
}

#[tauri::command(async)]
#[specta::specta]
fn pty_spawn(
    store: State<'_, Store>,
    manager: State<'_, PtyManager>,
    app: AppHandle,
    worktree_path: String,
    columns: u16,
    rows: u16,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<PtySession, AppError> {
    let path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    manager.spawn(&path, columns, rows, app, &env.unwrap_or_default())
}

#[tauri::command]
#[specta::specta]
fn pty_write(
    manager: State<'_, PtyManager>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), AppError> {
    manager.write(&session_id, &data)
}

#[tauri::command]
#[specta::specta]
fn pty_resize(
    manager: State<'_, PtyManager>,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), AppError> {
    manager.resize(&session_id, columns, rows)
}

#[tauri::command]
#[specta::specta]
fn pty_attach(
    manager: State<'_, PtyManager>,
    session_id: String,
    attachment_id: u64,
) -> Result<(), AppError> {
    manager.attach(&session_id, attachment_id)
}

#[tauri::command]
#[specta::specta]
fn pty_detach(
    manager: State<'_, PtyManager>,
    session_id: String,
    attachment_id: u64,
) -> Result<(), AppError> {
    manager.detach(&session_id, attachment_id)
}

#[tauri::command]
#[specta::specta]
fn pty_close(manager: State<'_, PtyManager>, session_id: String) -> Result<(), AppError> {
    manager.close(&session_id)
}

/// Resolve a CLI binary through the login shell's PATH (spec §6.6.1).
/// The name is strictly validated; only a single resolved absolute path or a
/// missing-binary error ever crosses this boundary.
#[tauri::command(async)]
#[specta::specta]
fn cli_resolve(binary: String) -> Result<String, AppError> {
    cli::resolve_binary(&binary)
}

/// Create (when needed) the isolated profile dir for a CLI and return it.
#[tauri::command]
#[specta::specta]
fn cli_profile_dir(cli_id: String, slug: String) -> Result<String, AppError> {
    cli::ensure_profile_dir(&cli_id, &slug)
}

/// Stop a PTY session gracefully: SIGINT, wait up to `grace_ms`, then
/// force-close. Returns true when the process exited on its own in time.
#[tauri::command(async)]
#[specta::specta]
fn pty_stop(
    manager: State<'_, PtyManager>,
    session_id: String,
    grace_ms: u64,
) -> Result<bool, AppError> {
    manager.stop(&session_id, grace_ms)
}

/// Wait until a new shell has printed its prompt and gone quiet before a first command is typed
/// (issue #3). Returns false on timeout or exit; bounded to 10 s.
#[tauri::command(async)]
#[specta::specta]
fn pty_wait_ready(
    manager: State<'_, PtyManager>,
    session_id: String,
    quiet_ms: u64,
    timeout_ms: u64,
) -> Result<bool, AppError> {
    manager.wait_ready(&session_id, quiet_ms, timeout_ms)
}

/// Run a read-only vendor status probe (fixed non-interactive argv only)
/// and return its stdout. The caller picks a CLI id, never a command.
#[tauri::command(async)]
#[specta::specta]
fn cli_probe(
    cli_id: String,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<String, AppError> {
    cli::probe(&cli_id, env.as_ref())
}

/// True when any of the registry's declared credential files exists inside
/// the profile dir — the vendor login actually completed there.
#[tauri::command]
#[specta::specta]
fn cli_has_credentials(
    cli_id: String,
    slug: String,
    credential_files: Vec<String>,
) -> Result<bool, AppError> {
    cli::has_credentials(&cli_id, &slug, &credential_files)
}

/// Seed Claude's one-time onboarding flag for an isolated profile dir.
/// Exclusive-create only: never reads or overwrites existing credentials.
/// Returns true when this call created the seed file.
#[tauri::command]
#[specta::specta]
fn cli_seed_onboarding(cli_id: String, slug: String) -> Result<bool, AppError> {
    cli::seed_onboarding(&cli_id, &slug)
}

/// Remove the registry's declared credential files inside a profile dir.
/// Returns the names actually removed; nothing else is touched.
#[tauri::command]
#[specta::specta]
fn cli_logout_profile(
    cli_id: String,
    slug: String,
    credential_files: Vec<String>,
) -> Result<Vec<String>, AppError> {
    cli::logout_profile(&cli_id, &slug, &credential_files)
}

/// Store a user-supplied GitHub token under an account name in the platform
/// credential store. Never synthesized: the caller passes the token the
/// user provided.
#[tauri::command(async)]
#[specta::specta]
fn gh_auth_set_token(token: String, account: String) -> Result<(), AppError> {
    gh::set_token(&token, &account)
}

/// True when a token is stored (for the account, or any account when
/// omitted). The token itself is never returned.
#[tauri::command(async)]
#[specta::specta]
fn gh_auth_status(account: Option<String>) -> Result<gh::GhAuthStatus, AppError> {
    gh::status(account.as_deref())
}

/// Delete the stored token for an account. `Ok(false)` when absent.
#[tauri::command(async)]
#[specta::specta]
fn gh_auth_sign_out(account: String) -> Result<bool, AppError> {
    gh::sign_out(&account)
}

/// Start a device authorization. Returns the user code and verification URI;
/// the device code stays backend-side under the returned request id.
#[tauri::command(async)]
#[specta::specta]
fn gh_auth_start() -> Result<gh::DeviceStart, AppError> {
    gh::device_start()
}

/// Poll one in-flight device authorization once (interval-enforced).
#[tauri::command(async)]
#[specta::specta]
fn gh_auth_poll(request_id: String) -> Result<gh::DevicePoll, AppError> {
    gh::device_poll(&request_id)
}

/// Verify a user-supplied PAT, store it under its username, return the name.
#[tauri::command(async)]
#[specta::specta]
fn gh_auth_pat(token: String) -> Result<gh::PatResult, AppError> {
    gh::pat_login(&token)
}

/// Open the device-flow verification page in the system browser.
/// Strict allowlist enforced in the backend: only the GitHub device-login
/// page may be opened, never an arbitrary URL.
#[tauri::command]
#[specta::specta]
fn gh_open_url(url: String) -> Result<(), AppError> {
    gh::open_verification_uri(&url)
}

/// Resolve the `origin` remote of the active worktree to owner/repo/URL.
#[tauri::command(async)]
#[specta::specta]
fn gh_repo_remote(
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<gh::GhRemote, AppError> {
    gh::repo_remote(&store, Path::new(&worktree_path))
}

/// Repository overview for the repo screen as one stored account.
#[tauri::command(async)]
#[specta::specta]
fn gh_repo_meta(owner: String, repo: String, account: String) -> Result<gh::GhRepoMeta, AppError> {
    gh::repo_meta(&owner, &repo, &account)
}

/// Top contributors for the repo screen sidebar as one stored account.
#[tauri::command(async)]
#[specta::specta]
fn gh_repo_contributors(
    owner: String,
    repo: String,
    account: String,
) -> Result<Vec<gh::GhContributor>, AppError> {
    gh::repo_contributors(&owner, &repo, &account)
}

/// Star or unstar a repo. Returns the new starred state.
#[tauri::command(async)]
#[specta::specta]
fn gh_repo_set_starred(
    owner: String,
    repo: String,
    account: String,
    starred: bool,
) -> Result<bool, AppError> {
    gh::repo_set_starred(&owner, &repo, &account, starred)
}

/// Subscribe or unsubscribe a repo. Returns the new subscription state.
#[tauri::command(async)]
#[specta::specta]
fn gh_repo_set_watched(
    owner: String,
    repo: String,
    account: String,
    watch: bool,
) -> Result<String, AppError> {
    gh::repo_set_watched(&owner, &repo, &account, watch)
}

/// Fork a repo into the viewer's account. Returns the fork URL.
#[tauri::command(async)]
#[specta::specta]
fn gh_repo_fork(owner: String, repo: String, account: String) -> Result<String, AppError> {
    gh::repo_fork(&owner, &repo, &account)
}

/// Issue list for the repo screen Issues tab as one stored account.
#[tauri::command(async)]
#[specta::specta]
fn gh_repo_issues(
    owner: String,
    repo: String,
    account: String,
    state: String,
) -> Result<gh::GhIssueList, AppError> {
    gh::repo_issues(&owner, &repo, &account, &state)
}

/// Issues assigned to the authenticated viewer for the Launchpad.
#[tauri::command(async)]
#[specta::specta]
fn gh_repo_assigned_issues(
    owner: String,
    repo: String,
    account: String,
) -> Result<gh::GhIssueList, AppError> {
    gh::repo_assigned_issues(&owner, &repo, &account)
}

/// Pull request list for the repo screen Pulls tab as one stored account.
#[tauri::command(async)]
#[specta::specta]
fn gh_repo_pulls(
    owner: String,
    repo: String,
    account: String,
    state: String,
) -> Result<gh::GhPullList, AppError> {
    gh::repo_pulls(&owner, &repo, &account, &state)
}

/// Remove cached repository responses so an explicit refresh fetches fresh data.
#[tauri::command(async)]
#[specta::specta]
fn gh_repo_cache_invalidate(owner: String, repo: String, account: String) -> Result<(), AppError> {
    gh::repo_cache_invalidate(&owner, &repo, &account)
}

/// Latest low-quota state for the Repository retry indicator.
#[tauri::command]
#[specta::specta]
fn gh_rate_limit_status() -> Option<gh::RateLimitState> {
    gh::rate_limit_status()
}

/// Fetch a bounded page of notifications for each requested GitHub account.
#[tauri::command(async)]
#[specta::specta]
fn gh_notifications(accounts: Vec<String>) -> Result<gh::GhNotificationBatch, AppError> {
    gh::notifications(&accounts)
}

/// Mark one GitHub notification thread as read.
#[tauri::command(async)]
#[specta::specta]
fn gh_notification_mark_read(account: String, thread_id: String) -> Result<(), AppError> {
    gh::notification_mark_read(&account, &thread_id)
}

/// Mark all currently fetched GitHub notifications as read for one account.
#[tauri::command(async)]
#[specta::specta]
fn gh_notifications_mark_read_all(account: String) -> Result<(), AppError> {
    gh::notifications_mark_read_all(&account)
}

/// Open a GitHub repository page in the system browser. The URL is built
/// server-side from validated names, never from caller-supplied URLs.
#[tauri::command]
#[specta::specta]
fn gh_open_repo(owner: String, repo: String) -> Result<(), AppError> {
    gh::open_repo(&owner, &repo)
}

/// Open a fixed GitHub repository section or pull request in the system
/// browser. The backend allowlists the route and builds the URL.
#[tauri::command]
#[specta::specta]
fn gh_open_repo_page(
    owner: String,
    repo: String,
    page: String,
    pull_number: Option<u64>,
) -> Result<(), AppError> {
    gh::open_repo_page(&owner, &repo, &page, pull_number)
}

/// Open the GitHub commit page (links its pull requests). The backend builds the URL.
#[tauri::command]
#[specta::specta]
fn gh_open_commit(owner: String, repo: String, sha: String) -> Result<(), AppError> {
    gh::open_commit_page(&owner, &repo, &sha)
}

/// Latest Actions runs for the repo screen Actions tab as one stored account.
#[tauri::command(async)]
#[specta::specta]
fn gh_repo_runs(owner: String, repo: String, account: String) -> Result<Vec<gh::GhRun>, AppError> {
    gh::repo_runs(&owner, &repo, &account)
}

/// Re-run the failed jobs of one Actions run as one stored account.
#[tauri::command(async)]
#[specta::specta]
fn gh_repo_rerun(
    owner: String,
    repo: String,
    account: String,
    run_id: u64,
) -> Result<(), AppError> {
    gh::repo_rerun(&owner, &repo, &account, run_id)
}

/// Branch selector data for the repo screen Code tab.
#[tauri::command(async)]
#[specta::specta]
fn git_repo_branches(
    store: State<'_, Store>,
    worktree_path: String,
) -> Result<repogit::GitBranches, AppError> {
    repogit::branches(&store, Path::new(&worktree_path))
}

/// Latest commit on a ref for the repo screen latest-commit bar.
#[tauri::command(async)]
#[specta::specta]
fn git_repo_latest_commit(
    store: State<'_, Store>,
    worktree_path: String,
    gitref: String,
) -> Result<repogit::GitCommit, AppError> {
    repogit::latest_commit(&store, Path::new(&worktree_path), &gitref)
}

/// File table of a ref and subdir with per-file history.
#[tauri::command(async)]
#[specta::specta]
fn git_repo_tree(
    store: State<'_, Store>,
    worktree_path: String,
    gitref: String,
    subdir: String,
) -> Result<Vec<repogit::GitTreeEntry>, AppError> {
    repogit::tree(&store, Path::new(&worktree_path), &gitref, &subdir)
}

/// Read a committed file from a ref for the Repository screen README preview.
#[tauri::command(async)]
#[specta::specta]
fn git_repo_read_file(
    store: State<'_, Store>,
    worktree_path: String,
    gitref: String,
    path: String,
) -> Result<Vec<u8>, AppError> {
    repogit::read_file(&store, Path::new(&worktree_path), &gitref, &path)
}

/// Confirm and remove a complete Branchwork account profile and its credentials.
#[tauri::command(async)]
#[specta::specta]
fn cli_remove_profile(app: AppHandle, cli_id: String, slug: String) -> Result<bool, AppError> {
    cli::validate_profile_ref(&cli_id, &slug)?;
    let message = if cli_id == "muse" {
        format!(
            "Remove the Muse profile '{slug}'? This also signs out all Muse profiles on this device."
        )
    } else {
        format!("Remove the {cli_id} account '{slug}' and delete its Branchwork profile data?")
    };
    let confirmed = app
        .dialog()
        .message(message)
        .title("Confirm account removal")
        .buttons(MessageDialogButtons::YesNo)
        .blocking_show();
    if !confirmed {
        return Ok(false);
    }
    cli::remove_profile(&cli_id, &slug)?;
    Ok(true)
}

/// Absolute path of the notify socket hook sidecars should dial.
/// Fails on platforms without socket support; callers fall back to heuristics.
#[tauri::command]
#[specta::specta]
fn notify_socket_path() -> Result<String, AppError> {
    Ok(notify::socket_path()?.to_string_lossy().into_owned())
}

/// Validate and re-emit a hook-reported status as an `agent:status` event.
/// Unknown sessions are ignored by the frontend; malformed input is rejected.
#[tauri::command]
#[specta::specta]
fn notify_status(app: AppHandle, session_id: String, event: String) -> Result<(), AppError> {
    let payload = notify::validate_notify_event(&session_id, &event, None)?;
    app.emit("agent:status", payload).map_err(|error| {
        AppError::internal(format!("Could not emit agent:status event: {error}"))
    })?;
    Ok(())
}

/// Write the handover note and ensure the `.branchwork/` git-exclude entry.
/// The worktree must be catalog-registered; paths inside are fixed names.
#[tauri::command]
#[specta::specta]
fn agent_write_handover(
    store: State<'_, Store>,
    worktree_path: String,
    note: String,
) -> Result<bool, AppError> {
    handover::write_note(&store, Path::new(&worktree_path), &note)
}

/// Capped `git diff HEAD` text of a registered worktree for handover notes.
#[tauri::command(async)]
#[specta::specta]
fn agent_handover_diff(store: State<'_, Store>, worktree_path: String) -> Result<String, AppError> {
    handover::read_diff(&store, Path::new(&worktree_path))
}

/// Copy one conversation transcript between two profiles of the same CLI so a
/// profile switch can resume it by ID. False when a Claude pane has no
/// transcript yet. Only paths inside the two validated profile dirs are used.
#[tauri::command(async)]
#[specta::specta]
fn agent_copy_conversation(
    cli_id: String,
    from_slug: String,
    to_slug: String,
    conversation_id: String,
) -> Result<bool, AppError> {
    conversation::copy(&cli_id, &from_slug, &to_slug, &conversation_id)
}

/// The single Codex rollout for a worktree touched since `since_ms` in one
/// profile, excluding IDs other panes already claim; None when ambiguous.
#[tauri::command(async)]
#[specta::specta]
fn agent_find_codex_conversation(
    slug: String,
    worktree_path: String,
    since_ms: u64,
    exclude: Vec<String>,
) -> Result<Option<String>, AppError> {
    conversation::find_codex(&slug, &worktree_path, since_ms, &exclude)
}

/// Merge agent hook entries into the isolated profile dir for CLIs with
/// documented hook support (currently Claude Code only). Best-effort: a
/// missing sidecar or an unsupported CLI reports false and the caller keeps
/// the output heuristics. Never touches user config outside the profile dir.
#[tauri::command]
#[specta::specta]
fn cli_ensure_hooks(cli_id: String, profile_dir: String) -> Result<bool, AppError> {
    if cli_id != "claude" {
        return Ok(false);
    }
    let dir = Path::new(&profile_dir);
    let file = dir.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !file.starts_with("claude-") || !dir.is_dir() {
        return Err(AppError::validation(
            "Hook setup needs an isolated claude profile dir",
        ));
    }
    let bin = match notify::notify_binary_path() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("Skipping agent hooks: {error}");
            return Ok(false);
        }
    };
    // The live usage meter reads Claude's statusline `rate_limits` (best-effort).
    if let Ok(saver) = notify::saver_binary_path()
        && let Err(error) = notify::ensure_claude_statusline(dir, &saver)
    {
        eprintln!("Skipping usage statusline: {error}");
    }
    notify::ensure_claude_hooks(dir, &bin)
}

/// Install the token-saver `PreToolUse` hook into an isolated Claude
/// profile. True only when the sidecar exists and the hook is in place;
/// false for other CLIs or a missing sidecar (the saver then shows as
/// unavailable). Never touches user config outside the profile dir.
#[tauri::command]
#[specta::specta]
fn cli_ensure_saver_hook(cli_id: String, profile_dir: String) -> Result<bool, AppError> {
    if cli_id != "claude" {
        return Ok(false);
    }
    let dir = Path::new(&profile_dir);
    let file = dir.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !dir.is_absolute() || !file.starts_with("claude-") || !dir.is_dir() {
        return Err(AppError::validation(
            "Saver setup needs an isolated claude profile dir",
        ));
    }
    let bin = match notify::saver_binary_path() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("Skipping token saver hook: {error}");
            return Ok(false);
        }
    };
    notify::ensure_claude_saver_hook(dir, &bin)
}

/// Account quota windows (5-hour, weekly, …) for one agent profile, from
/// the CLI's own local state. Unsupported CLIs report `unsupported`.
#[tauri::command(async)]
#[specta::specta]
fn agent_profile_quota(cli_id: String, profile_dir: String) -> Result<quota::ProfileQuota, AppError> {
    quota::read_quota(&cli_id, Path::new(&profile_dir))
}

/// Measured byte savings the saver sidecar recorded for one agent session.
#[tauri::command(async)]
#[specta::specta]
fn agent_saver_stats(agent_id: String) -> Result<quota::SaverStats, AppError> {
    let path = quota::saver_stats_path(&agent_id)?;
    Ok(quota::read_saver_stats_file(&path))
}

// (async): `#[tauri::command(async)]` on a sync fn runs it inside `tokio::spawn` (occupies
// one async worker, not a blocking-threadpool thread), which frees the main thread. A true
// `spawn_blocking` move is deferred to the cancellable-clone work (spec §7).
#[tauri::command(async)]
#[specta::specta]
fn repository_clone(
    store: State<'_, Store>,
    url: String,
    destination: String,
) -> Result<Project, AppError> {
    repository::clone_and_register(&url, Path::new(&destination), &store)
}

/// Builds the typed command/event registry shared by `run()` (to export TS bindings in debug
/// builds, spec §3/§10) and the `export_bindings` drift test.
fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        // Matches the hand-written bindings this replaces: `usize`/`i64` fields (page sizes,
        // commit counts, unix timestamps) serialize as plain JS numbers, not bigint/string.
        .dangerously_cast_bigints_to_number()
        .commands(tauri_specta::collect_commands![
            settings_get,
            settings_set,
            groups_list,
            group_save,
            group_delete,
            projects_list,
            project_save,
            project_delete,
            pins_list,
            pin_worktree,
            unpin_worktree,
            repository_open,
            repository_clone,
            path_is_repository,
            repository_classify,
            repository_init,
            gh_publish_owners,
            git_has_origin,
            gh_repo_publish,
            worktree_list,
            worktree_summary,
            worktree_create,
            worktree_create_at_commit,
            worktree_remove,
            worktree_prune,
            log_graph,
            graph_commit_detail,
            graph_commit_file_diff,
            status,
            diff_file,
            compare_worktrees,
            compare_file_diff,
            compare_patch,
            commit,
            commit_and_push,
            commit_and_sync,
            git_fetch,
            git_pull,
            git_push,
            git_checkout,
            git_branch_create,
            git_cherry_pick,
            git_revert,
            rebase_plan,
            rebase_interactive,
            rebase_continue,
            rebase_abort,
            git_push_force_with_lease,
            conflict_list,
            conflict_read,
            conflict_resolve,
            conflict_abort,
            conflict_continue,
            undo_last,
            stash_list,
            stash_push,
            stash_apply,
            stash_pop,
            stash_drop,
            stage_paths,
            unstage_paths,
            discard_paths,
            stage_hunks,
            unstage_hunks,
            stage_lines,
            revert_hunk,
            fs_tree,
            fs_read,
            fs_write,
            fs_create,
            fs_rename,
            fs_delete,
            reveal_in_finder,
            blame,
            file_history,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_attach,
            pty_detach,
            pty_close,
            pty_stop,
            pty_wait_ready,
            cli_resolve,
            cli_profile_dir,
            cli_probe,
            cli_has_credentials,
            cli_logout_profile,
            cli_seed_onboarding,
            cli_remove_profile,
            gh_auth_set_token,
            gh_auth_status,
            gh_auth_sign_out,
            gh_auth_start,
            gh_auth_poll,
            gh_auth_pat,
            gh_open_url,
            gh_repo_remote,
            gh_repo_meta,
            gh_repo_contributors,
            gh_repo_set_starred,
            gh_repo_set_watched,
            gh_repo_fork,
            gh_repo_issues,
            gh_repo_assigned_issues,
            gh_repo_pulls,
            gh_repo_cache_invalidate,
            gh_rate_limit_status,
            gh_notifications,
            gh_notification_mark_read,
            gh_notifications_mark_read_all,
            gh_open_repo,
            gh_open_repo_page,
            gh_open_commit,
            gh_repo_runs,
            gh_repo_rerun,
            git_repo_branches,
            git_repo_latest_commit,
            git_repo_tree,
            git_repo_read_file,
            cli_ensure_hooks,
            cli_ensure_saver_hook,
            agent_profile_quota,
            agent_saver_stats,
            agent_write_handover,
            agent_handover_diff,
            agent_copy_conversation,
            agent_find_codex_conversation,
            notify_socket_path,
            notify_status
        ])
        // `git:changed` (emitted in `run()`'s setup below) carries this payload; registering it
        // here (rather than as a tauri-specta `Event`) exports its TS type without changing how
        // it's emitted/listened to.
        .typ::<worktree::WorktreeChanged>()
        .typ::<OpDone>()
        .typ::<PtyOutput>()
        .typ::<PtyExit>()
        .typ::<PtyErrorEvent>()
        .typ::<rebase::RebaseProgress>()
}

/// S3-M1: rejects any top-level webview navigation off the app's own origin. Defence in depth
/// against an untrusted `<form>`/`<area>` in a rendered Markdown README navigating the main
/// window to an attacker page (the DOMPurify/CSP fixes close the sanitizer side of this).
fn is_local_navigation(url: &Url) -> bool {
    match url.scheme() {
        // Production: the WKWebView serves the bundled app under this scheme on macOS.
        "tauri" => url.host_str() == Some("localhost"),
        // Windows uses this origin instead; harmless to allow on macOS too.
        "https" => url.host_str() == Some("tauri.localhost"),
        "http" => {
            // Dev server only: `tauri.conf.json`'s `build.devUrl`.
            cfg!(debug_assertions)
                && url.host_str() == Some("localhost")
                && url.port() == Some(1420)
        }
        _ => false,
    }
}

/// `Some(exit code)` when the process was started as the rebase sequence editor.
pub fn rebase_todo_helper(args: Vec<std::ffi::OsString>) -> Option<i32> {
    rebase::todo_helper(&args)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = specta_builder();

    #[cfg(debug_assertions)]
    builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/ipc/bindings.ts",
        )
        .expect("failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
                .on_navigation(|_webview, url| is_local_navigation(url))
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir.join("app.db")).map_err(|e| e.to_string())?;
            app.manage(store);
            app.manage(PtyManager::default());
            let app_handle = app.handle().clone();
            app.manage(worktree::WorktreeWatcher::new(move |event| {
                if let Err(error) = app_handle.emit("git:changed", event) {
                    eprintln!("Could not emit git:changed event: {error}");
                }
            }));
            notify::spawn_listener(app.handle());
            Ok(())
        })
        .invoke_handler(builder.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running Branchwork");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group() -> Group {
        Group {
            id: "g1".into(),
            name: "Group".into(),
            color: "blue".into(),
            clone_path_template: "~/clients/{repo}".into(),
        }
    }

    fn project() -> Project {
        Project {
            id: "p1".into(),
            owner: None,
            name: "Repo".into(),
            local_path: "/repos/repo".into(),
            group_id: None,
        }
    }

    #[test]
    fn catalog_input_validation_rejects_empty_fields_and_relative_paths() {
        assert!(validate_group(&group()).is_ok());
        assert!(validate_project(&project()).is_ok());
        assert!(
            validate_pin(&WorktreePin {
                project_id: "p1".into(),
                worktree_path: "/repos/repo".into(),
            })
            .is_ok()
        );

        assert!(
            validate_group(&Group {
                name: " ".into(),
                ..group()
            })
            .is_err()
        );
        assert!(
            validate_project(&Project {
                local_path: "relative/repo".into(),
                ..project()
            })
            .is_err()
        );
        assert!(
            validate_pin(&WorktreePin {
                project_id: "p1".into(),
                worktree_path: "relative/repo".into(),
            })
            .is_err()
        );
    }

    #[test]
    #[ignore = "one-off: regenerates the committed src/ipc/bindings.ts; run explicitly after changing commands/types"]
    fn regenerate_bindings_file() {
        specta_builder()
            .export(
                specta_typescript::Typescript::default(),
                "../src/ipc/bindings.ts",
            )
            .expect("failed to export typescript bindings");
    }

    /// Spec §10: a drift check. If this fails, re-run `cargo test --lib -- --ignored
    /// regenerate_bindings_file` from `src-tauri/`, then commit the updated `src/ipc/bindings.ts`.
    #[test]
    fn export_bindings_matches_checked_in_file() {
        let path = std::env::temp_dir().join(format!(
            "branchwork-bindings-{}-{}.ts",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        specta_builder()
            .export(specta_typescript::Typescript::default(), &path)
            .expect("failed to export typescript bindings");
        let generated = std::fs::read_to_string(&path).expect("failed to read generated bindings");
        std::fs::remove_file(&path).ok();
        let checked_in = include_str!("../../src/ipc/bindings.ts");
        assert_eq!(
            generated, checked_in,
            "src/ipc/bindings.ts is out of date. Regenerate it with \
             `cargo test --lib -- --ignored regenerate_bindings_file` from src-tauri/, then commit \
             the updated file."
        );
    }
}
