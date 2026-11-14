//! Carry one agent conversation across profiles (M8, profile switch).
//!
//! Each profile dir keeps its CLI's transcripts. A profile switch copies the
//! pane's single transcript into the target profile so the CLI can resume it
//! by ID there. Only files inside `~/.branchwork/profiles/<cli>-<slug>/` are
//! read or written; conversation IDs must be UUID-shaped before they touch a
//! path, and transcripts are never logged.

use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::cli;
use crate::error::AppError;

/// Codex discovery accepts rollouts touched up to this long before launch.
const DISCOVERY_SLACK_MS: u64 = 5_000;
/// The `session_meta` first line is read up to this many bytes.
const META_LINE_CAP: u64 = 1024 * 1024;

/// `8-4-4-4-12` hex, the shape both CLIs use for conversation IDs.
pub fn valid_conversation_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn validate_id(id: &str) -> Result<(), AppError> {
    if valid_conversation_id(id) {
        Ok(())
    } else {
        Err(AppError::validation("Invalid conversation id"))
    }
}

/// Regular files only: a symlink could point outside the profile dir.
fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file())
}

fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_dir())
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    // A symlinked `projects` / `sessions` dir could lead outside the profile.
    if !is_real_dir(dir) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_real_dir(path))
        .collect()
}

fn files(dir: &Path) -> Vec<PathBuf> {
    if !is_real_dir(dir) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_regular_file(path))
        .collect()
}

/// Claude: `projects/<cwd-slug>/<id>.jsonl`.
fn claude_transcripts(profile: &Path, id: &str) -> Vec<PathBuf> {
    let name = format!("{id}.jsonl");
    subdirs(&profile.join("projects"))
        .into_iter()
        .map(|dir| dir.join(&name))
        .filter(|path| is_regular_file(path))
        .collect()
}

/// Codex: every `sessions/YYYY/MM/DD/rollout-*.jsonl`.
fn codex_rollouts(profile: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for year in subdirs(&profile.join("sessions")) {
        for month in subdirs(&year) {
            for day in subdirs(&month) {
                out.extend(files(&day).into_iter().filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
                }));
            }
        }
    }
    out
}

fn codex_transcripts(profile: &Path, id: &str) -> Vec<PathBuf> {
    let suffix = format!("-{id}.jsonl");
    codex_rollouts(profile)
        .into_iter()
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(&suffix))
        })
        .collect()
}

/// Every existing path from `root` down to `dest`'s parent must be a real
/// dir (no symlink), so the write cannot be redirected out of the profile.
fn ensure_no_symlinks(root: &Path, dest: &Path) -> Result<(), AppError> {
    let mut current = root.to_path_buf();
    let relative = dest.parent().and_then(|parent| parent.strip_prefix(root).ok());
    let components = relative.map(|path| path.components().collect::<Vec<_>>()).unwrap_or_default();
    for component in std::iter::once(None).chain(components.into_iter().map(Some)) {
        if let Some(component) = component {
            current.push(component);
        }
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(AppError::validation("Profile path contains a symlink"));
            }
            _ => {}
        }
    }
    Ok(())
}

/// Copy into `dest` via a temp file in the same dir, then rename.
fn copy_atomic(source: &Path, dest: &Path) -> Result<(), AppError> {
    let Some(parent) = dest.parent() else {
        return Err(AppError::internal("Transcript destination has no parent"));
    };
    std::fs::create_dir_all(parent)
        .map_err(|error| AppError::io(format!("Could not create transcript dir: {error}")))?;
    let name = dest.file_name().and_then(|name| name.to_str()).unwrap_or("transcript");
    let temp = parent.join(format!(".{name}.branchwork-tmp"));
    // A leftover temp (or a planted symlink) is removed, never written through.
    std::fs::remove_file(&temp).ok();
    std::fs::copy(source, &temp)
        .and_then(|_| std::fs::rename(&temp, dest))
        .map_err(|error| {
            std::fs::remove_file(&temp).ok();
            AppError::io(format!("Could not copy conversation: {error}"))
        })
}

/// Copy `id`'s transcript from `from` to the same relative path under `to`.
/// Returns false only for Claude when the source has no transcript yet.
fn copy_between(cli_id: &str, from: &Path, to: &Path, id: &str) -> Result<bool, AppError> {
    validate_id(id)?;
    let found = match cli_id {
        "claude" => claude_transcripts(from, id),
        "codex" => codex_transcripts(from, id),
        _ => return Err(AppError::validation("Conversation copy supports Claude Code and Codex only")),
    };
    let source = match found.as_slice() {
        [] if cli_id == "claude" => return Ok(false),
        [] => return Err(AppError::not_found("Conversation transcript not found")),
        [one] => one,
        _ => return Err(AppError::validation("Conversation id matches more than one transcript")),
    };
    let relative = source
        .strip_prefix(from)
        .map_err(|_| AppError::internal("Transcript outside the profile dir"))?;
    let dest = to.join(relative);
    ensure_no_symlinks(to, &dest)?;
    copy_atomic(source, &dest)?;
    Ok(true)
}

pub fn copy(cli_id: &str, from_slug: &str, to_slug: &str, conversation_id: &str) -> Result<bool, AppError> {
    if cli_id != "claude" && cli_id != "codex" {
        return Err(AppError::validation("Conversation copy supports Claude Code and Codex only"));
    }
    validate_id(conversation_id)?;
    let from = cli::profile_dir_for(cli_id, from_slug)?;
    let to = cli::profile_dir_for(cli_id, to_slug)?;
    if from == to {
        return Ok(true);
    }
    copy_between(cli_id, &from, &to, conversation_id)
}

fn modified_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    u64::try_from(modified.duration_since(UNIX_EPOCH).ok()?.as_millis()).ok()
}

/// `(id, cwd)` from a rollout's first `session_meta` line.
fn rollout_meta(path: &Path) -> Option<(String, String)> {
    let file = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    std::io::BufReader::new(file.take(META_LINE_CAP)).read_line(&mut line).ok()?;
    let value: serde_json::Value = serde_json::from_str(line.trim_end()).ok()?;
    if value.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = value.get("payload")?;
    Some((payload.get("id")?.as_str()?.to_owned(), payload.get("cwd")?.as_str()?.to_owned()))
}

fn same_path(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// The most recently written rollout for `worktree` touched since `since_ms`
/// and not claimed by another pane. Newest wins: after Codex `/new` the
/// pane's previous rollout is also a candidate, and the new one is current.
fn find_codex_in(profile: &Path, worktree: &str, since_ms: u64, exclude: &[String]) -> Option<String> {
    let floor = since_ms.saturating_sub(DISCOVERY_SLACK_MS);
    codex_rollouts(profile)
        .into_iter()
        .filter_map(|path| modified_ms(&path).filter(|ms| *ms >= floor).map(|ms| (ms, path)))
        .filter_map(|(ms, path)| rollout_meta(&path).map(|(id, cwd)| (ms, id, cwd)))
        .filter(|(_, id, cwd)| valid_conversation_id(id) && !exclude.contains(id) && same_path(cwd, worktree))
        .max_by_key(|(ms, _, _)| *ms)
        .map(|(_, id, _)| id)
}

pub fn find_codex(
    slug: &str,
    worktree_path: &str,
    since_ms: u64,
    exclude: &[String],
) -> Result<Option<String>, AppError> {
    let profile = cli::profile_dir_for("codex", slug)?;
    Ok(find_codex_in(&profile, worktree_path, since_ms, exclude))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "42abbe75-0d00-4c98-9fcf-dcc6ef22bf2b";
    const OTHER: &str = "01a1d5e6-eae0-7e90-847c-778bb00e80eb";

    struct TempDir(PathBuf);
    impl TempDir {
        fn fresh(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "branchwork-test-conversation-{}-{}",
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

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn rollout(profile: &Path, day: &str, id: &str, cwd: &str) -> PathBuf {
        let path = profile.join(format!("sessions/2026/11/{day}/rollout-2026-11-{day}T00-00-00-{id}.jsonl"));
        let meta = serde_json::json!({"type": "session_meta", "payload": {"id": id, "cwd": cwd}});
        write(&path, &format!("{meta}\n{{\"type\":\"event\"}}\n"));
        path
    }

    fn now_ms() -> u64 {
        u64::try_from(std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()).unwrap()
    }

    #[test]
    fn copies_claude_transcript_to_same_relative_path() {
        let temp = TempDir::fresh("claude-copy");
        let (from, to) = (temp.0.join("a"), temp.0.join("b"));
        write(&from.join(format!("projects/-wt-a/{ID}.jsonl")), "line\n");
        assert!(copy_between("claude", &from, &to, ID).unwrap());
        assert_eq!(std::fs::read_to_string(to.join(format!("projects/-wt-a/{ID}.jsonl"))).unwrap(), "line\n");
        assert!(from.join(format!("projects/-wt-a/{ID}.jsonl")).is_file(), "source is kept");
    }

    #[test]
    fn claude_without_transcript_returns_false() {
        let temp = TempDir::fresh("claude-none");
        assert!(!copy_between("claude", &temp.0.join("a"), &temp.0.join("b"), ID).unwrap());
    }

    #[test]
    fn copies_codex_rollout_and_replaces_existing() {
        let temp = TempDir::fresh("codex-copy");
        let (from, to) = (temp.0.join("a"), temp.0.join("b"));
        let source = rollout(&from, "14", ID, "/wt/a");
        let relative = source.strip_prefix(&from).unwrap().to_path_buf();
        write(&to.join(&relative), "stale\n");
        assert!(copy_between("codex", &from, &to, ID).unwrap());
        assert_eq!(std::fs::read(to.join(&relative)).unwrap(), std::fs::read(&source).unwrap());
    }

    #[test]
    fn codex_missing_rollout_is_not_found() {
        let temp = TempDir::fresh("codex-missing");
        let error = copy_between("codex", &temp.0.join("a"), &temp.0.join("b"), ID).unwrap_err();
        assert!(error.to_string().contains("not found"), "{error}");
    }

    #[test]
    fn rejects_bad_ids_and_slugs() {
        let temp = TempDir::fresh("bad");
        for id in ["../x", "abc", "42abbe75-0d00-4c98-9fcf-dcc6ef22bf2/", ""] {
            assert!(copy_between("claude", &temp.0, &temp.0, id).is_err(), "{id}");
        }
        assert!(copy("claude", "A B", "work", ID).is_err());
        assert!(copy("claude", "work", "../x", ID).is_err());
        assert!(copy("opencode", "a", "b", ID).is_err());
        assert!(find_codex("A B", "/wt", 0, &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_transcript() {
        let temp = TempDir::fresh("symlink");
        let (from, to) = (temp.0.join("a"), temp.0.join("b"));
        let outside = temp.0.join("secret.txt");
        write(&outside, "secret\n");
        std::fs::create_dir_all(from.join("projects/-wt")).unwrap();
        std::os::unix::fs::symlink(&outside, from.join(format!("projects/-wt/{ID}.jsonl"))).unwrap();
        assert!(!copy_between("claude", &from, &to, ID).unwrap());
        assert!(!to.join(format!("projects/-wt/{ID}.jsonl")).exists());
    }

    #[test]
    fn finds_single_codex_rollout_for_cwd_since() {
        let temp = TempDir::fresh("find");
        rollout(&temp.0, "14", ID, "/wt/a");
        assert_eq!(find_codex_in(&temp.0, "/wt/a", now_ms(), &[]), Some(ID.to_owned()));
    }

    #[test]
    fn codex_find_prefers_newest_and_excludes_claimed() {
        let temp = TempDir::fresh("newest");
        let older = rollout(&temp.0, "14", ID, "/wt/a");
        let file = std::fs::File::options().write(true).open(&older).unwrap();
        file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(2)).unwrap();
        rollout(&temp.0, "14", OTHER, "/wt/a");
        // After `/new`, the newer rollout is the pane's current conversation.
        assert_eq!(find_codex_in(&temp.0, "/wt/a", now_ms(), &[]), Some(OTHER.to_owned()));
        assert_eq!(find_codex_in(&temp.0, "/wt/a", now_ms(), &[OTHER.to_owned()]), Some(ID.to_owned()));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_destination_dirs() {
        let temp = TempDir::fresh("dest-symlink");
        let (from, to) = (temp.0.join("a"), temp.0.join("b"));
        write(&from.join(format!("projects/-wt/{ID}.jsonl")), "line\n");
        let outside = temp.0.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::os::unix::fs::symlink(&outside, to.join("projects")).unwrap();
        assert!(copy_between("claude", &from, &to, ID).is_err());
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none(), "nothing written outside");
    }

    #[test]
    fn codex_find_ignores_old_and_other_cwd() {
        let temp = TempDir::fresh("old");
        rollout(&temp.0, "14", ID, "/wt/b");
        assert_eq!(find_codex_in(&temp.0, "/wt/a", now_ms(), &[]), None);
        assert_eq!(find_codex_in(&temp.0, "/wt/b", now_ms() + 60_000, &[]), None, "touched before launch");
    }
}
