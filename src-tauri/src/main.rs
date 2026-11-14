// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `git rebase -i` runs the app binary as its sequence editor (M6-11); handle that before
    // Tauri starts and exit.
    if let Some(code) = branchwork_lib::rebase_todo_helper(std::env::args_os().skip(1).collect()) {
        std::process::exit(code);
    }
    branchwork_lib::run()
}
