mod repository;
mod store;

use std::path::Path;
use store::{Group, Project, Store, WorktreePin};
use tauri::{Manager, State};

fn validate_id(id: &str, kind: &str) -> Result<(), String> {
    if id.trim().is_empty() {
        Err(format!("{kind} id must not be empty"))
    } else {
        Ok(())
    }
}

fn validate_group(group: &Group) -> Result<(), String> {
    validate_id(&group.id, "group")?;
    if group.name.trim().is_empty() || group.color.trim().is_empty() {
        return Err("group name and color must not be empty".into());
    }
    Ok(())
}

fn validate_project(project: &Project) -> Result<(), String> {
    validate_id(&project.id, "project")?;
    if project.name.trim().is_empty() {
        return Err("project name must not be empty".into());
    }
    if !Path::new(&project.local_path).is_absolute() {
        return Err("project path must be absolute".into());
    }
    if project
        .group_id
        .as_deref()
        .is_some_and(|id| id.trim().is_empty())
    {
        return Err("group id must not be empty".into());
    }
    Ok(())
}

fn validate_pin(pin: &WorktreePin) -> Result<(), String> {
    validate_id(&pin.project_id, "project")?;
    if !Path::new(&pin.worktree_path).is_absolute() {
        return Err("worktree path must be absolute".into());
    }
    Ok(())
}

#[tauri::command]
fn settings_get(store: State<'_, Store>, key: String) -> Result<Option<String>, String> {
    store.get(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_set(store: State<'_, Store>, key: String, value: String) -> Result<(), String> {
    store.set(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_list(store: State<'_, Store>) -> Result<Vec<Group>, String> {
    store.list_groups().map_err(|e| e.to_string())
}

#[tauri::command]
fn group_save(store: State<'_, Store>, group: Group) -> Result<(), String> {
    validate_group(&group)?;
    store.save_group(&group).map_err(|e| e.to_string())
}

#[tauri::command]
fn group_delete(store: State<'_, Store>, id: String) -> Result<bool, String> {
    validate_id(&id, "group")?;
    store.delete_group(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn projects_list(store: State<'_, Store>) -> Result<Vec<Project>, String> {
    store.list_projects().map_err(|e| e.to_string())
}

#[tauri::command]
fn project_save(store: State<'_, Store>, project: Project) -> Result<(), String> {
    validate_project(&project)?;
    store.save_project(&project).map_err(|e| e.to_string())
}

#[tauri::command]
fn project_delete(store: State<'_, Store>, id: String) -> Result<bool, String> {
    validate_id(&id, "project")?;
    store.delete_project(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn pins_list(
    store: State<'_, Store>,
    project_id: Option<String>,
) -> Result<Vec<WorktreePin>, String> {
    if let Some(id) = &project_id {
        validate_id(id, "project")?;
    }
    store
        .list_pins(project_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pin_worktree(store: State<'_, Store>, pin: WorktreePin) -> Result<(), String> {
    validate_pin(&pin)?;
    store.pin_worktree(&pin).map_err(|e| e.to_string())
}

#[tauri::command]
fn unpin_worktree(
    store: State<'_, Store>,
    project_id: String,
    worktree_path: String,
) -> Result<bool, String> {
    validate_id(&project_id, "project")?;
    if !Path::new(&worktree_path).is_absolute() {
        return Err("worktree path must be absolute".into());
    }
    store
        .unpin_worktree(&project_id, &worktree_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn repository_open(store: State<'_, Store>, path: String) -> Result<Project, String> {
    repository::open_and_register(Path::new(&path), &store)
}

/// Read-only: never executes anything from the repository at `path`.
#[tauri::command]
fn path_is_repository(path: String) -> Result<bool, String> {
    repository::is_repository(Path::new(&path))
}

// (async): `#[tauri::command(async)]` on a sync fn runs it inside `tokio::spawn` (occupies
// one async worker, not a blocking-threadpool thread), which frees the main thread. A true
// `spawn_blocking` move is deferred to the cancellable-clone work (spec §7).
#[tauri::command(async)]
fn repository_clone(
    store: State<'_, Store>,
    url: String,
    destination: String,
) -> Result<Project, String> {
    repository::clone_and_register(&url, Path::new(&destination), &store)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir.join("app.db")).map_err(|e| e.to_string())?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            path_is_repository
        ])
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
}
