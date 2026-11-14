//! Multi-window support (M10): every window is an independent workspace.
//!
//! Windows are labelled `main` (from `tauri.conf.json`) and `ws-<n>`. The
//! frontend namespaces its window-scoped settings by label; this module only
//! opens windows with the same options as `main`, remembers which secondary
//! windows are open (so they reopen at launch), and forgets a window the user
//! closes. Labels are validated here: web content cannot pick arbitrary ones.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::AppError;
use crate::store::Store;

/// Global setting listing the secondary windows to reopen at launch.
const OPEN_WINDOWS_KEY: &str = "windows";
const MAX_WINDOW_NUMBER: u32 = 9999;
/// Secondary windows open at once (plus `main`).
const MAX_OPEN_WINDOWS: usize = 8;
/// Window-scoped setting keys a new window may be seeded with (must match
/// `WINDOW_SCOPED_KEYS` in `src/ipc/settings.ts`).
const SEEDABLE_KEYS: [&str; 8] = ["repos", "activeWorktrees", "stage", "agentSessions", "terminalDock", "terminalScreen", "sidebar", "browserTabs"];
const MAX_SEED_BYTES: usize = 256 * 1024;

/// `ws-<n>` with `n` in 1..=9999 and no leading zero.
pub fn valid_secondary_label(label: &str) -> bool {
    let Some(number) = label.strip_prefix("ws-") else { return false };
    !number.is_empty()
        && !number.starts_with('0')
        && number.len() <= 4
        && number.bytes().all(|byte| byte.is_ascii_digit())
}

fn saved_labels(store: &Store) -> Vec<String> {
    store
        .get(OPEN_WINDOWS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|label| valid_secondary_label(label))
        .collect()
}

fn save_labels(store: &Store, labels: &[String]) -> Result<(), AppError> {
    let json = serde_json::to_string(labels).map_err(|error| AppError::internal(error.to_string()))?;
    store.set(OPEN_WINDOWS_KEY, &json).map_err(|error| AppError::internal(error.to_string()))
}

/// The lowest `ws-<n>` that is neither open nor saved.
fn next_label(app: &AppHandle, saved: &[String]) -> Result<String, AppError> {
    (1..=MAX_WINDOW_NUMBER)
        .map(|n| format!("ws-{n}"))
        .find(|label| app.get_webview_window(label).is_none() && !saved.contains(label))
        .ok_or_else(|| AppError::validation("Too many windows"))
}

fn build(app: &AppHandle, label: &str) -> Result<(), AppError> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Branchwork")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1000.0, 640.0);
    #[cfg(target_os = "macos")]
    let builder = builder
        .transparent(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .theme(Some(tauri::Theme::Dark))
        .effects(
            tauri::window::EffectsBuilder::new()
                .effect(tauri::window::Effect::Sidebar)
                .state(tauri::window::EffectState::FollowsWindowActiveState)
                .build(),
        );
    builder
        .build()
        .map(|_| ())
        .map_err(|error| AppError::internal(format!("Could not open window: {error}")))
}

/// One window-scoped setting for a new window: `key` from `SEEDABLE_KEYS`,
/// `value` the JSON text to store.
#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
pub struct WindowSeed {
    pub key: String,
    pub value: String,
}

/// Clear `label`'s scoped settings and write the seeds (validated keys,
/// bounded JSON). A reused label never inherits an old workspace.
fn seed_label(store: &Store, label: &str, seeds: &[WindowSeed]) -> Result<(), AppError> {
    let total: usize = seeds.iter().map(|seed| seed.value.len()).sum();
    if total > MAX_SEED_BYTES {
        return Err(AppError::validation("Window seed is too large"));
    }
    for seed in seeds {
        if !SEEDABLE_KEYS.contains(&seed.key.as_str()) {
            return Err(AppError::validation("Invalid window seed key"));
        }
        serde_json::from_str::<serde_json::Value>(&seed.value)
            .map_err(|_| AppError::validation("Window seed must be JSON"))?;
    }
    store
        .delete_settings_with_prefix(&format!("{label}:"))
        .map_err(|error| AppError::internal(error.to_string()))?;
    for seed in seeds {
        store
            .set(&format!("{label}:{}", seed.key), &seed.value)
            .map_err(|error| AppError::internal(error.to_string()))?;
    }
    Ok(())
}

/// Create a new secondary window: allocate the next free label (not open,
/// not saved), seed its workspace, open it and remember it. Commands run one
/// at a time, so two quick requests get two different labels.
pub fn create(app: &AppHandle, store: &Store, seeds: &[WindowSeed]) -> Result<String, AppError> {
    let mut saved = saved_labels(store);
    let open = (1..=MAX_WINDOW_NUMBER)
        .filter(|n| app.get_webview_window(&format!("ws-{n}")).is_some())
        .count();
    if open >= MAX_OPEN_WINDOWS {
        return Err(AppError::validation(format!("Up to {MAX_OPEN_WINDOWS} extra windows")));
    }
    let label = next_label(app, &saved)?;
    seed_label(store, &label, seeds)?;
    build(app, &label)?;
    saved.push(label.clone());
    save_labels(store, &saved)?;
    Ok(label)
}

/// Reopen the secondary windows that were open at the last quit. One that
/// fails to open is skipped (logged) so the others still come back.
pub fn restore(app: &AppHandle, store: &Store) -> Result<Vec<String>, AppError> {
    let mut opened = Vec::new();
    for label in saved_labels(store).into_iter().take(MAX_OPEN_WINDOWS) {
        if app.get_webview_window(&label).is_some() {
            opened.push(label);
            continue;
        }
        match build(app, &label) {
            Ok(()) => opened.push(label),
            Err(error) => eprintln!("Could not restore window {label}: {error}"),
        }
    }
    Ok(opened)
}

/// The user closed `label`: stop reopening it and drop its scoped settings.
pub fn forget(store: &Store, label: &str) -> Result<(), AppError> {
    if !valid_secondary_label(label) {
        return Err(AppError::validation("Invalid window label"));
    }
    let saved: Vec<String> = saved_labels(store).into_iter().filter(|item| item != label).collect();
    save_labels(store, &saved)?;
    store
        .delete_settings_with_prefix(&format!("{label}:"))
        .map_err(|error| AppError::internal(error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_secondary_labels() {
        for ok in ["ws-1", "ws-42", "ws-9999"] {
            assert!(valid_secondary_label(ok), "{ok}");
        }
        for bad in ["main", "ws-", "ws-0", "ws-01", "ws-10000", "ws-1a", "ws-1/..", "WS-1", ""] {
            assert!(!valid_secondary_label(bad), "{bad}");
        }
    }

    #[test]
    fn forget_drops_the_label_and_its_scoped_settings() {
        let store = Store::in_memory().unwrap();
        save_labels(&store, &["ws-1".into(), "ws-2".into()]).unwrap();
        store.set("ws-1:stage", "{}").unwrap();
        store.set("ws-10:stage", "{}").unwrap();
        store.set("stage", "{}").unwrap();
        forget(&store, "ws-1").unwrap();
        assert_eq!(saved_labels(&store), vec!["ws-2".to_owned()]);
        assert_eq!(store.get("ws-1:stage").unwrap(), None);
        assert!(store.get("ws-10:stage").unwrap().is_some(), "prefix must not match ws-10");
        assert!(store.get("stage").unwrap().is_some());
        assert!(forget(&store, "main").is_err());
    }

    #[test]
    fn seeding_clears_old_scoped_keys_and_validates_input() {
        let store = Store::in_memory().unwrap();
        store.set("ws-1:agentSessions", "[1]").unwrap();
        let seeds = vec![WindowSeed { key: "stage".into(), value: "{}".into() }];
        seed_label(&store, "ws-1", &seeds).unwrap();
        assert_eq!(store.get("ws-1:agentSessions").unwrap(), None, "a reused label starts clean");
        assert_eq!(store.get("ws-1:stage").unwrap().as_deref(), Some("{}"));
        let bad_key = vec![WindowSeed { key: "theme".into(), value: "{}".into() }];
        assert!(seed_label(&store, "ws-1", &bad_key).is_err());
        let bad_json = vec![WindowSeed { key: "stage".into(), value: "{".into() }];
        assert!(seed_label(&store, "ws-1", &bad_json).is_err());
        let huge = vec![WindowSeed { key: "stage".into(), value: format!("\"{}\"", "x".repeat(MAX_SEED_BYTES)) }];
        assert!(seed_label(&store, "ws-1", &huge).is_err());
    }

    #[test]
    fn saved_labels_ignore_invalid_entries() {
        let store = Store::in_memory().unwrap();
        store.set(OPEN_WINDOWS_KEY, r#"["ws-3","../x","main","ws-0"]"#).unwrap();
        assert_eq!(saved_labels(&store), vec!["ws-3".to_owned()]);
    }
}
