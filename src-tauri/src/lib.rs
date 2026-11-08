mod blame;
mod commit;
mod diff;
mod error;
mod fs;
mod graph;
mod oplog;
mod pty;
mod repository;
mod stage;
mod stash;
mod status;
mod store;
mod worktree;

use error::AppError;
use pty::{PtyErrorEvent, PtyExit, PtyManager, PtyOutput, PtySession};
use serde::Serialize;
use std::path::Path;
use store::{Group, Project, Store, WorktreePin};
use tauri::{AppHandle, Emitter, Manager, State, Url};

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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
#[specta::specta]
fn worktree_remove(
    store: State<'_, Store>,
    project_id: String,
    path: String,
) -> Result<(), AppError> {
    validate_id(&project_id, "project")?;
    let project = project_by_id(&store, &project_id)?;
    worktree::remove(&project, Path::new(&path), &store)
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
#[specta::specta]
fn pty_spawn(
    store: State<'_, Store>,
    manager: State<'_, PtyManager>,
    app: AppHandle,
    worktree_path: String,
    columns: u16,
    rows: u16,
) -> Result<PtySession, AppError> {
    let path = status::validate_catalog_worktree(&store, Path::new(&worktree_path))?;
    manager.spawn(&path, columns, rows, app)
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
            worktree_list,
            worktree_create,
            worktree_create_at_commit,
            worktree_remove,
            worktree_prune,
            log_graph,
            graph_commit_detail,
            graph_commit_file_diff,
            status,
            diff_file,
            commit,
            commit_and_push,
            commit_and_sync,
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
            pty_close
        ])
        // `git:changed` (emitted in `run()`'s setup below) carries this payload; registering it
        // here (rather than as a tauri-specta `Event`) exports its TS type without changing how
        // it's emitted/listened to.
        .typ::<worktree::WorktreeChanged>()
        .typ::<OpDone>()
        .typ::<PtyOutput>()
        .typ::<PtyExit>()
        .typ::<PtyErrorEvent>()
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
