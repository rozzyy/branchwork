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
/// The CLI started or switched conversation (Claude `SessionStart`); carries
/// only the conversation id, no status change.
pub const NOTIFY_EVENT_START: &str = "start";

/// Payload re-emitted as the `agent:status` app event. camelCase: the
/// frontend reads `sessionId` / `conversationId`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusPayload {
    pub session_id: String,
    pub event: String,
    /// The CLI's own conversation id, when the hook reported a valid one.
    pub conversation_id: Option<String>,
}

/// Validate a hook-reported status. Hooks report the agent record id
/// (`BRANCHWORK_AGENT_SESSION`, known before the PTY exists); the direct IPC
/// path may also use the `pty-N` session id. Both shapes are strict charsets
/// with length caps, and only the two known events pass.
pub fn validate_notify_event(
    session_id: &str,
    event: &str,
    conversation_id: Option<&str>,
) -> Result<AgentStatusPayload, AppError> {
    let valid = if let Some(suffix) = session_id.strip_prefix("pty-") {
        !suffix.is_empty() && suffix.len() <= 20 && suffix.bytes().all(|byte| byte.is_ascii_digit())
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
    if event != NOTIFY_EVENT_WAITING && event != NOTIFY_EVENT_DONE && event != NOTIFY_EVENT_START {
        return Err(AppError::validation("Invalid notify event"));
    }
    // A malformed conversation id is dropped; the status still counts.
    let conversation_id = conversation_id
        .filter(|id| crate::conversation::valid_conversation_id(id))
        .map(str::to_owned);
    Ok(AgentStatusPayload {
        session_id: session_id.to_owned(),
        event: event.to_owned(),
        conversation_id,
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
    sidecar_path("branchwork-notify")
}

/// Absolute path of the bundled `branchwork-saver` sidecar (token saver).
pub fn saver_binary_path() -> Result<PathBuf, AppError> {
    sidecar_path("branchwork-saver")
}

fn sidecar_path(stem: &str) -> Result<PathBuf, AppError> {
    let exe = std::env::current_exe()
        .map_err(|error| AppError::internal(format!("Could not locate app binary: {error}")))?;
    let Some(dir) = exe.parent() else {
        return Err(AppError::internal("App binary has no parent dir"));
    };
    #[cfg(windows)]
    let name = format!("{stem}.exe");
    #[cfg(not(windows))]
    let name = stem.to_owned();
    let candidate = dir.join(name);
    if candidate.is_file() {
        Ok(candidate)
    } else {
        Err(AppError::not_found(format!(
            "{stem} sidecar is not built; run cargo build --bin {stem}"
        )))
    }
}

/// Read the profile `settings.json` as a JSON object (empty when missing).
fn read_profile_settings(path: &Path) -> Result<serde_json::Value, AppError> {
    let root = match std::fs::read_to_string(path) {
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
    if !root.is_object() {
        return Err(AppError::validation(
            "Profile settings.json must be a JSON object",
        ));
    }
    Ok(root)
}

fn write_profile_settings(path: &Path, root: &serde_json::Value) -> Result<(), AppError> {
    let text = serde_json::to_string_pretty(root)
        .map_err(|error| AppError::internal(format!("Could not serialize settings: {error}")))?;
    std::fs::write(path, text)
        .map_err(|error| AppError::io(format!("Could not write profile settings.json: {error}")))
}

/// The `hooks.<key>` array of a settings object, created when missing.
fn hook_list<'a>(
    root: &'a mut serde_json::Value,
    key: &str,
) -> Result<&'a mut Vec<serde_json::Value>, AppError> {
    let Some(object) = root.as_object_mut() else {
        return Err(AppError::validation(
            "Profile settings.json must be a JSON object",
        ));
    };
    let hooks = object
        .entry("hooks")
        .or_insert_with(|| serde_json::Value::Object(Default::default()));
    let Some(hooks_object) = hooks.as_object_mut() else {
        return Err(AppError::validation(
            "Profile settings.json hooks must be an object",
        ));
    };
    hooks_object
        .entry(key)
        .or_insert_with(|| serde_json::Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| {
            AppError::validation(format!(
                "Profile settings.json hooks.{key} must be an array"
            ))
        })
}

fn hook_command(entry: &serde_json::Value) -> Option<&str> {
    entry.pointer("/hooks/0/command").and_then(|value| value.as_str())
}

/// Merge Claude Code hook entries into the profile `settings.json`.
///
/// Reads the existing file when present (must stay a JSON object; other keys
/// are preserved byte-for-value), ensures `hooks.Notification` and
/// `hooks.Stop` and `hooks.SessionStart` each carry our notify command once,
/// and writes the file back.
/// Returns true when the file changed.
pub fn ensure_claude_hooks(profile_dir: &Path, notify_bin: &Path) -> Result<bool, AppError> {
    let path = profile_dir.join("settings.json");
    let mut root = read_profile_settings(&path)?;
    let command = format!(
        "\"{}\" \"$BRANCHWORK_AGENT_SESSION\"",
        notify_bin.to_string_lossy()
    );
    let mut changed = false;
    for (key, event) in [
        ("Notification", NOTIFY_EVENT_WAITING),
        ("Stop", NOTIFY_EVENT_DONE),
        ("SessionStart", NOTIFY_EVENT_START),
    ] {
        let list = hook_list(&mut root, key)?;
        if !list
            .iter()
            .any(|entry| hook_command(entry).is_some_and(|existing| existing.contains("branchwork-notify")))
        {
            list.push(serde_json::json!({
                "matcher": "",
                "hooks": [{ "type": "command", "command": format!("{command} {event}") }]
            }));
            changed = true;
        }
    }
    if changed {
        write_profile_settings(&path, &root)?;
    }
    Ok(changed)
}

/// Ensure the profile carries exactly one `hooks.PreToolUse` Bash entry for
/// the saver sidecar (a stale entry from a moved app is replaced). The hook
/// is inert unless the session env sets `BRANCHWORK_SAVER=rtk`. Returns true
/// when the entry is present after the call.
pub fn ensure_claude_saver_hook(profile_dir: &Path, saver_bin: &Path) -> Result<bool, AppError> {
    let path = profile_dir.join("settings.json");
    let mut root = read_profile_settings(&path)?;
    let command = format!("\"{}\" hook", saver_bin.to_string_lossy());
    let list = hook_list(&mut root, "PreToolUse")?;
    let ours = |entry: &serde_json::Value| {
        hook_command(entry).is_some_and(|existing| existing.contains("branchwork-saver"))
    };
    let current: Vec<&str> = list.iter().filter(|entry| ours(entry)).filter_map(hook_command).collect();
    if current == [command.as_str()] {
        return Ok(true);
    }
    list.retain(|entry| !ours(entry));
    list.push(serde_json::json!({
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": command }]
    }));
    write_profile_settings(&path, &root)?;
    Ok(true)
}

/// Points the isolated profile's `statusLine` at the saver sidecar, which records Claude's live
/// `rate_limits` for the usage meter. A statusline the user configured is never replaced.
/// Returns true when Branchwork's statusline is in place after the call.
pub fn ensure_claude_statusline(profile_dir: &Path, saver_bin: &Path) -> Result<bool, AppError> {
    let path = profile_dir.join("settings.json");
    let mut root = read_profile_settings(&path)?;
    let command = format!("\"{}\" statusline", saver_bin.to_string_lossy());
    let Some(object) = root.as_object_mut() else {
        return Err(AppError::validation("Profile settings.json must be a JSON object"));
    };
    if let Some(existing) = object.get("statusLine") {
        let current = existing.get("command").and_then(|value| value.as_str());
        if current == Some(command.as_str()) {
            return Ok(true);
        }
        if !current.is_some_and(|value| value.contains("branchwork-saver")) {
            return Ok(false);
        }
    }
    object.insert(
        "statusLine".into(),
        serde_json::json!({ "type": "command", "command": command }),
    );
    write_profile_settings(&path, &root)?;
    Ok(true)
}

/// Split the first line of `<session> <event>[ <conversation>]`.
fn parse_notify_line(text: &str) -> Option<(&str, &str, Option<&str>)> {
    let mut parts = text.lines().next()?.split_whitespace();
    let session = parts.next()?;
    let event = parts.next()?;
    let conversation = parts.next();
    if parts.next().is_some() {
        return None;
    }
    Some((session, event, conversation))
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
    let Some((session, event, conversation)) = parse_notify_line(&text) else {
        return;
    };
    match validate_notify_event(session, event, conversation) {
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
        let ok = validate_notify_event("pty-1", "waiting", None).unwrap();
        assert_eq!(ok.event, "waiting");
        assert!(validate_notify_event("pty-1", "done", None).is_ok());
        assert!(validate_notify_event("agent-abc-123", "done", None).is_ok());
        assert!(validate_notify_event("other-1", "waiting", None).is_err());
        assert!(validate_notify_event("pty-", "waiting", None).is_err());
        assert!(validate_notify_event("pty-1;rm", "waiting", None).is_err());
        assert!(validate_notify_event("agent-x;rm", "waiting", None).is_err());
        assert!(validate_notify_event("pty-1", "explode", None).is_err());
        assert!(validate_notify_event("pty-1", "", None).is_err());
    }

    const CONVERSATION: &str = "42abbe75-0d00-4c98-9fcf-dcc6ef22bf2b";

    #[test]
    fn payload_serializes_camel_case() {
        let payload = validate_notify_event("agent-a1", "done", Some(CONVERSATION)).unwrap();
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(json["sessionId"], "agent-a1");
        assert_eq!(json["conversationId"], CONVERSATION);
        assert!(json.get("session_id").is_none());
    }

    #[test]
    fn accepts_start_event_with_conversation() {
        let payload = validate_notify_event("agent-a1", "start", Some(CONVERSATION)).unwrap();
        assert_eq!(payload.event, "start");
        assert_eq!(payload.conversation_id.as_deref(), Some(CONVERSATION));
    }

    #[test]
    fn drops_bad_conversation_id_keeps_event() {
        for bad in ["../etc", "x", "42abbe75-0d00-4c98-9fcf-dcc6ef22bf2b0"] {
            let payload = validate_notify_event("agent-a1", "waiting", Some(bad)).unwrap();
            assert_eq!(payload.conversation_id, None, "{bad}");
        }
    }

    #[test]
    fn parses_three_part_line() {
        assert_eq!(parse_notify_line("agent-a done\n"), Some(("agent-a", "done", None)));
        assert_eq!(
            parse_notify_line(&format!("agent-a start {CONVERSATION}\nignored")),
            Some(("agent-a", "start", Some(CONVERSATION)))
        );
        assert_eq!(parse_notify_line("agent-a"), None);
        assert_eq!(parse_notify_line("a b c d"), None);
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
        let start = root["hooks"]["SessionStart"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(start.ends_with(" start"), "{start}");
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

    #[test]
    fn claude_saver_hook_merges_once() {
        let home = TempDir::fresh("saver");
        let profile = home.0.join("claude-x");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(
            profile.join("settings.json"),
            r#"{"theme": "dark", "hooks": {"PreToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "lint"}]}]}}"#,
        )
        .unwrap();
        let bin = PathBuf::from("/opt/branchwork/branchwork-saver");
        assert!(ensure_claude_saver_hook(&profile, &bin).unwrap());
        assert!(ensure_claude_saver_hook(&profile, &bin).unwrap());
        let root: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(profile.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(root["theme"], "dark");
        let list = root["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1]["matcher"], "Bash");
        assert_eq!(
            list[1]["hooks"][0]["command"],
            "\"/opt/branchwork/branchwork-saver\" hook"
        );
        // A moved app replaces its stale entry instead of adding another.
        let moved = PathBuf::from("/Applications/Branchwork.app/branchwork-saver");
        assert!(ensure_claude_saver_hook(&profile, &moved).unwrap());
        let root: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(profile.join("settings.json")).unwrap())
                .unwrap();
        let list = root["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[1]["hooks"][0]["command"].as_str().unwrap().contains("/Applications/"));
    }

    #[test]
    fn claude_statusline_installs_only_when_free_or_ours() {
        let home = TempDir::fresh("statusline");
        let profile = home.0.join("claude-x");
        std::fs::create_dir_all(&profile).unwrap();
        let bin = PathBuf::from("/opt/branchwork/branchwork-saver");
        assert!(ensure_claude_statusline(&profile, &bin).unwrap());
        let root: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(profile.join("settings.json")).unwrap()).unwrap();
        assert_eq!(root["statusLine"]["type"], "command");
        assert_eq!(root["statusLine"]["command"], "\"/opt/branchwork/branchwork-saver\" statusline");
        assert!(ensure_claude_statusline(&profile, &bin).unwrap());
        // A user's own statusline is never replaced.
        std::fs::write(
            profile.join("settings.json"),
            r#"{"statusLine": {"type": "command", "command": "my-line"}}"#,
        )
        .unwrap();
        assert!(!ensure_claude_statusline(&profile, &bin).unwrap());
        let root: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(profile.join("settings.json")).unwrap()).unwrap();
        assert_eq!(root["statusLine"]["command"], "my-line");
    }
}
