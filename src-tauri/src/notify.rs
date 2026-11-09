//! Agent status notifications (spec §6.6.3).
//!
//! Hooks in the agent CLI call the `branchwork-notify` sidecar binary with
//! `<session> <event>`; the binary forwards the line over a Unix socket and
//! this module validates it and re-emits it as an `agent:status` app event.
//! Hook configuration is written inside the isolated profile dir only, never
//! into the user's own config. Output heuristics remain the fallback.

use crate::error::AppError;
use std::path::{Path, PathBuf};
use tauri::Emitter;

pub const NOTIFY_EVENT_WAITING: &str = "waiting";
pub const NOTIFY_EVENT_DONE: &str = "done";

/// Payload re-emitted as the `agent:status` app event.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentStatusPayload {
    pub session_id: String,
    pub event: String,
}

/// Validate a hook-reported status. Hooks report the agent record id
/// (`BRANCHWORK_AGENT_SESSION`, known before the PTY exists); the direct IPC
/// path may also use the `pty-N` session id. Both shapes are strict charsets
/// with length caps, and only the two known events pass.
pub fn validate_notify_event(session_id: &str, event: &str) -> Result<AgentStatusPayload, AppError> {
    let valid = if let Some(suffix) = session_id.strip_prefix("pty-") {
        !suffix.is_empty()
            && suffix.len() <= 20
            && suffix.bytes().all(|byte| byte.is_ascii_digit())
    } else if let Some(suffix) = session_id.strip_prefix("agent-") {
        !suffix.is_empty()
            && suffix.len() <= 64
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    } else {
        false
    };
    if !valid {
        return Err(AppError::validation("Invalid notify session id"));
    }
    if event != NOTIFY_EVENT_WAITING && event != NOTIFY_EVENT_DONE {
        return Err(AppError::validation("Invalid notify event"));
    }
    Ok(AgentStatusPayload {
        session_id: session_id.to_owned(),
        event: event.to_owned(),
    })
}

/// Directory holding the notify socket: per-user temp, created 0700.
#[cfg(unix)]
fn socket_dir() -> Result<PathBuf, AppError> {
    use std::os::unix::fs::DirBuilderExt;
    // SAFETY: getuid cannot fail.
    let uid = unsafe { libc::getuid() };
    let dir = std::env::temp_dir().join(format!("branchwork-{uid}"));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(&dir)
        .map_err(|error| AppError::io(format!("Could not create notify dir: {error}")))?;
    Ok(dir)
}

/// Absolute path of the notify socket clients should dial.
pub fn socket_path() -> Result<PathBuf, AppError> {
    #[cfg(unix)]
    {
        Ok(socket_dir()?.join("notify.sock"))
    }
    #[cfg(not(unix))]
    {
        let _ = ();
        Err(AppError::not_found(
            "Agent notifications are not supported on this platform",
        ))
    }
}

/// Absolute path of the bundled `branchwork-notify` sidecar next to the app
/// binary. Best-effort: hook setup treats a missing binary as "no hooks".
pub fn notify_binary_path() -> Result<PathBuf, AppError> {
    let exe = std::env::current_exe()
        .map_err(|error| AppError::internal(format!("Could not locate app binary: {error}")))?;
    let Some(dir) = exe.parent() else {
        return Err(AppError::internal("App binary has no parent dir"));
    };
    #[cfg(windows)]
    let name = "branchwork-notify.exe";
    #[cfg(not(windows))]
    let name = "branchwork-notify";
    let candidate = dir.join(name);
    if candidate.is_file() {
        Ok(candidate)
    } else {
        Err(AppError::not_found(
            "branchwork-notify sidecar is not built; run cargo build --bin branchwork-notify",
        ))
    }
}

/// Merge Claude Code hook entries into the profile `settings.json`.
///
/// Reads the existing file when present (must stay a JSON object; other keys
/// are preserved byte-for-value), ensures `hooks.Notification` and
/// `hooks.Stop` each carry our notify command once, and writes the file back.
/// Returns true when the file changed.
pub fn ensure_claude_hooks(profile_dir: &Path, notify_bin: &Path) -> Result<bool, AppError> {
    let path = profile_dir.join("settings.json");
    let mut root = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<serde_json::Value>(&text).map_err(|error| {
            AppError::validation(format!("Profile settings.json is not valid JSON: {error}"))
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            serde_json::Value::Object(Default::default())
        }
        Err(error) => {
            return Err(AppError::io(format!(
                "Could not read profile settings.json: {error}"
            )));
        }
    };
    let Some(object) = root.as_object_mut() else {
        return Err(AppError::validation(
            "Profile settings.json must be a JSON object",
        ));
    };
    let command = format!(
        "\"{}\" \"$BRANCHWORK_AGENT_SESSION\"",
        notify_bin.to_string_lossy()
    );
    let mut changed = false;
    let hooks = object
        .entry("hooks")
        .or_insert_with(|| serde_json::Value::Object(Default::default()));
    let Some(hooks_object) = hooks.as_object_mut() else {
        return Err(AppError::validation(
            "Profile settings.json hooks must be an object",
        ));
    };
    for (key, event) in [
        ("Notification", NOTIFY_EVENT_WAITING),
        ("Stop", NOTIFY_EVENT_DONE),
    ] {
        let entries = hooks_object
            .entry(key)
            .or_insert_with(|| serde_json::Value::Array(Vec::new()));
        let Some(list) = entries.as_array_mut() else {
            return Err(AppError::validation(format!(
                "Profile settings.json hooks.{key} must be an array"
            )));
        };
        let ours = serde_json::json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": format!("{command} {event}") }]
        });
        if !list.iter().any(|entry| {
            entry
                .pointer("/hooks/0/command")
                .and_then(|value| value.as_str())
                .is_some_and(|existing| existing.contains("branchwork-notify"))
        }) {
            list.push(ours);
            changed = true;
        }
    }
    if changed {
        let text = serde_json::to_string_pretty(&root)
            .map_err(|error| AppError::internal(format!("Could not serialize settings: {error}")))?;
        std::fs::write(&path, text)
            .map_err(|error| AppError::io(format!("Could not write profile settings.json: {error}")))?;
    }
    Ok(changed)
}

/// Accept one notify line (`<session> <event>`) from a connected client.
#[cfg(unix)]
fn handle_client(stream: std::os::unix::net::UnixStream, app: &tauri::AppHandle) {
    use std::io::Read;
    let mut bytes = [0u8; 256];
    let text = match stream.take(257).read(&mut bytes) {
        Ok(0) => return,
        Ok(read) => String::from_utf8_lossy(&bytes[..read]).into_owned(),
        Err(_) => return,
    };
    // First line only; overlong input is dropped rather than parsed.
    let line = text.lines().next().unwrap_or("").trim();
    let mut parts = line.splitn(2, char::is_whitespace);
    let (Some(session), Some(event)) = (parts.next(), parts.next()) else {
        return;
    };
    match validate_notify_event(session.trim(), event.trim()) {
        Ok(payload) => {
            if let Err(error) = app.emit("agent:status", payload) {
                eprintln!("Could not emit agent:status event: {error}");
            }
        }
        Err(error) => eprintln!("Dropping invalid notify line: {error}"),
    }
}

/// Start the notify socket listener. Best-effort: a missing platform, a socket
/// owned by another instance, or a bind failure only logs; heuristics cover
/// status in that case.
pub fn spawn_listener(app: &tauri::AppHandle) {
    #[cfg(unix)]
    {
        use std::os::unix::net::UnixListener;
        let path = match socket_path() {
            Ok(path) => path,
            Err(error) => {
                eprintln!("Notify socket unavailable: {error}");
                return;
            }
        };
        if path.exists() {
            // Owned by a live instance: leave it alone.
            if std::os::unix::net::UnixStream::connect(&path).is_ok() {
                return;
            }
            std::fs::remove_file(&path).ok();
        }
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("Could not bind notify socket: {error}");
                return;
            }
        };
        let handle = app.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => handle_client(stream, &handle),
                    Err(error) => {
                        eprintln!("Notify socket accept failed: {error}");
                        break;
                    }
                }
            }
        });
    }
    #[cfg(not(unix))]
    {
        let _ = app;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_known_shapes_and_rejects_the_rest() {
        let ok = validate_notify_event("pty-1", "waiting").unwrap();
        assert_eq!(ok.event, "waiting");
        assert!(validate_notify_event("pty-1", "done").is_ok());
        assert!(validate_notify_event("agent-abc-123", "done").is_ok());
        assert!(validate_notify_event("other-1", "waiting").is_err());
        assert!(validate_notify_event("pty-", "waiting").is_err());
        assert!(validate_notify_event("pty-1;rm", "waiting").is_err());
        assert!(validate_notify_event("agent-x;rm", "waiting").is_err());
        assert!(validate_notify_event("pty-1", "explode").is_err());
        assert!(validate_notify_event("pty-1", "").is_err());
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn fresh(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "branchwork-test-notify-{}-{}",
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

    #[test]
    fn claude_hooks_merge_without_touching_user_keys() {
        let home = TempDir::fresh("merge");
        let profile = home.0.join("claude-x");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(
            profile.join("settings.json"),
            r#"{"theme": "dark", "hooks": {"Stop": [{"matcher": "x", "hooks": [{"type": "command", "command": "say done"}]}]}}"#,
        )
        .unwrap();
        let bin = PathBuf::from("/opt/branchwork/branchwork-notify");
        assert!(ensure_claude_hooks(&profile, &bin).unwrap());
        let text = std::fs::read_to_string(profile.join("settings.json")).unwrap();
        let root: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(root["theme"], "dark");
        assert_eq!(root["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(root["hooks"]["Notification"].as_array().unwrap().len(), 1);
        // Second run changes nothing and adds no duplicates.
        assert!(!ensure_claude_hooks(&profile, &bin).unwrap());
        let again: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(profile.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(again["hooks"]["Stop"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn claude_hooks_reject_non_object_settings() {
        let home = TempDir::fresh("invalid");
        let profile = home.0.join("claude-x");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("settings.json"), "[1,2]").unwrap();
        let bin = PathBuf::from("/opt/branchwork/branchwork-notify");
        assert!(ensure_claude_hooks(&profile, &bin).is_err());
        assert_eq!(
            std::fs::read_to_string(profile.join("settings.json")).unwrap(),
            "[1,2]"
        );
    }
}
