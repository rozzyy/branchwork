mod store;

use store::Store;
use tauri::{Manager, State};

#[tauri::command]
fn settings_get(store: State<'_, Store>, key: String) -> Result<Option<String>, String> {
    store.get(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_set(store: State<'_, Store>, key: String, value: String) -> Result<(), String> {
    store.set(&key, &value).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir.join("app.db")).map_err(|e| e.to_string())?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![settings_get, settings_set])
        .run(tauri::generate_context!())
        .expect("error while running Branchwork");
}
