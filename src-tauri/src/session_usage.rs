//! Agent session usage readers (spec: agent session usage and token saver).
//!
//! Reads the vendor CLI's own local session log for one agent pane and
//! returns numeric aggregates only — never prompts, transcript text or
//! credentials. Logs are untrusted: every field is type-checked, files are
//! size-capped, and reads are incremental (byte offset per file), so a poll
//! costs O(new bytes) time and the cache keeps O(distinct message ids) space.

use crate::error::AppError;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

/// Larger logs are not parsed at all (reported as no data).
const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;
const MAX_STATS_BYTES: u64 = 1024 * 1024;
const MAX_CACHED_READERS: usize = 64;
/// Bound on remembered Claude message ids per file (dedupe set).
const MAX_SEEN_IDS: usize = 200_000;
/// `sessions/YYYY/MM/DD/rollout-*.jsonl`.
const CODEX_WALK_DEPTH: usize = 4;
/// Newest rollout files checked for a matching cwd per poll.
const MAX_CODEX_CANDIDATES: usize = 32;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounts {
    pub input: u64,
    pub output: u64,
    pub total: u64,
}

/// Provider-reported account quota window (Codex `rate_limits.primary`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageQuota {
    /// 0–100, the provider's own `used_percent`.
    pub percent: u32,
    pub window_minutes: Option<u32>,
    /// Unix seconds.
    pub resets_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub tokens: TokenCounts,
    /// Tokens in the latest request's context, when the log reports it.
    pub context_used: Option<u64>,
    /// The model's context window, when the log reports it.
    pub context_limit: Option<u64>,
    pub quota: Option<UsageQuota>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SessionUsage {
    /// The CLI has no usage reader.
    Unsupported,
    /// A reader exists but no matching session log was found yet.
    NoData,
    Ok(UsageReport),
}

/// Measured RTK-style savings for one agent session (bytes, not tokens).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SaverStats {
    pub runs: u32,
    pub bytes_before: u64,
    pub bytes_after: u64,
}

#[derive(Default)]
struct ReaderState {
    offset: u64,
    last_used: u64,
    claude_input: u64,
    claude_output: u64,
    claude_seen: HashSet<String>,
    claude_any: bool,
    codex_cwd: Option<String>,
    codex: Option<UsageReport>,
}

struct Cache {
    readers: HashMap<PathBuf, ReaderState>,
    tick: u64,
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(Cache {
            readers: HashMap::new(),
            tick: 0,
        })
    })
}

/// Claude's project folder name for a cwd: every non-alphanumeric byte → `-`.
pub fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn mtime_ms(path: &Path) -> Option<f64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as f64)
}

fn as_u64(value: &serde_json::Value) -> Option<u64> {
    value.as_u64()
}

fn apply_claude_line(state: &mut ReaderState, value: &serde_json::Value) {
    if value.get("type").and_then(|v| v.as_str()) != Some("assistant") {
        return;
    }
    let Some(message) = value.get("message") else { return };
    let Some(usage) = message.get("usage").filter(|u| u.is_object()) else { return };
    if let Some(id) = message.get("id").and_then(|v| v.as_str()) {
        if state.claude_seen.contains(id) {
            return;
        }
        if state.claude_seen.len() < MAX_SEEN_IDS {
            state.claude_seen.insert(id.to_owned());
        }
    }
    let field = |key: &str| usage.get(key).and_then(as_u64).unwrap_or(0);
    state.claude_input = state.claude_input.saturating_add(
        field("input_tokens")
            .saturating_add(field("cache_creation_input_tokens"))
            .saturating_add(field("cache_read_input_tokens")),
    );
    state.claude_output = state.claude_output.saturating_add(field("output_tokens"));
    state.claude_any = true;
}

fn apply_codex_line(state: &mut ReaderState, value: &serde_json::Value) {
    let Some(payload) = value.get("payload") else { return };
    match value.get("type").and_then(|v| v.as_str()) {
        Some("session_meta") if state.codex_cwd.is_none() => {
            state.codex_cwd = Some(
                payload
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned(),
            );
        }
        Some("event_msg") => {
            if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
                return;
            }
            let Some(info) = payload.get("info").filter(|v| v.is_object()) else { return };
            let Some(total) = info.get("total_token_usage").filter(|v| v.is_object()) else { return };
            let (Some(input), Some(output)) = (
                total.get("input_tokens").and_then(as_u64),
                total.get("output_tokens").and_then(as_u64),
            ) else {
                return;
            };
            let total_tokens = total
                .get("total_tokens")
                .and_then(as_u64)
                .unwrap_or(input.saturating_add(output));
            let quota = payload
                .pointer("/rate_limits/primary")
                .filter(|v| v.is_object())
                .and_then(|primary| {
                    let used = primary.get("used_percent")?.as_f64()?;
                    if !used.is_finite() {
                        return None;
                    }
                    Some(UsageQuota {
                        percent: used.round().clamp(0.0, 100.0) as u32,
                        window_minutes: primary
                            .get("window_minutes")
                            .and_then(as_u64)
                            .and_then(|m| u32::try_from(m).ok()),
                        resets_at: primary.get("resets_at").and_then(as_u64),
                    })
                });
            state.codex = Some(UsageReport {
                tokens: TokenCounts {
                    input,
                    output,
                    total: total_tokens,
                },
                context_used: info.pointer("/last_token_usage/total_tokens").and_then(as_u64),
                context_limit: info.get("model_context_window").and_then(as_u64),
                quota,
            });
        }
        _ => {}
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LogKind {
    Claude,
    Codex,
}

/// Consume whole new lines of `path` into its cached reader state and run
/// `view` over it. None when the file is unreadable or over the size cap.
fn with_reader<T>(path: &Path, kind: LogKind, view: impl FnOnce(&ReaderState) -> T) -> Option<T> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len > MAX_LOG_BYTES {
        return None;
    }
    let mut guard = cache().lock().unwrap_or_else(|poison| poison.into_inner());
    guard.tick += 1;
    let tick = guard.tick;
    if !guard.readers.contains_key(path)
        && guard.readers.len() >= MAX_CACHED_READERS
        && let Some(oldest) = guard
            .readers
            .iter()
            .min_by_key(|(_, state)| state.last_used)
            .map(|(key, _)| key.clone())
    {
        guard.readers.remove(&oldest);
    }
    let state = guard.readers.entry(path.to_path_buf()).or_default();
    state.last_used = tick;
    if len < state.offset {
        // Truncated or replaced: start over.
        *state = ReaderState {
            last_used: tick,
            ..Default::default()
        };
    }
    if len > state.offset {
        file.seek(SeekFrom::Start(state.offset)).ok()?;
        let mut bytes = Vec::with_capacity((len - state.offset) as usize);
        file.take(len - state.offset).read_to_end(&mut bytes).ok()?;
        if let Some(end) = bytes.iter().rposition(|byte| *byte == b'\n') {
            for line in bytes[..end].split(|byte| *byte == b'\n') {
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
                    continue;
                };
                match kind {
                    LogKind::Claude => apply_claude_line(state, &value),
                    LogKind::Codex => apply_codex_line(state, &value),
                }
            }
            state.offset += end as u64 + 1;
        }
    }
    Some(view(state))
}

fn newest_jsonl(dir: &Path, since_ms: f64) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl") && path.is_file())
        .filter_map(|path| mtime_ms(&path).map(|ms| (ms, path)))
        .filter(|(ms, _)| *ms >= since_ms)
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, path)| path)
}

fn read_claude(profile_dir: &Path, worktree: &str, since_ms: f64) -> SessionUsage {
    let dir = profile_dir
        .join("projects")
        .join(claude_project_dir_name(worktree));
    let Some(path) = newest_jsonl(&dir, since_ms) else {
        return SessionUsage::NoData;
    };
    with_reader(&path, LogKind::Claude, |state| {
        if !state.claude_any {
            return SessionUsage::NoData;
        }
        SessionUsage::Ok(UsageReport {
            tokens: TokenCounts {
                input: state.claude_input,
                output: state.claude_output,
                total: state.claude_input.saturating_add(state.claude_output),
            },
            context_used: None,
            context_limit: None,
            quota: None,
        })
    })
    .unwrap_or(SessionUsage::NoData)
}

fn collect_rollouts(dir: &Path, depth: usize, since_ms: f64, out: &mut Vec<(f64, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if depth > 1 {
                collect_rollouts(&path, depth - 1, since_ms, out);
            }
        } else if kind.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
            && let Some(ms) = mtime_ms(&path).filter(|ms| *ms >= since_ms)
        {
            out.push((ms, path));
        }
    }
}

fn read_codex(profile_dir: &Path, worktree: &str, since_ms: f64) -> SessionUsage {
    let mut candidates = Vec::new();
    collect_rollouts(&profile_dir.join("sessions"), CODEX_WALK_DEPTH, since_ms, &mut candidates);
    candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
    for (_, path) in candidates.into_iter().take(MAX_CODEX_CANDIDATES) {
        let found = with_reader(&path, LogKind::Codex, |state| {
            if state.codex_cwd.as_deref() != Some(worktree) {
                return None;
            }
            Some(state.codex.clone())
        })
        .flatten();
        if let Some(report) = found {
            return report.map_or(SessionUsage::NoData, SessionUsage::Ok);
        }
    }
    SessionUsage::NoData
}

/// Read usage for one pane. `profile_dir` must be the CLI's isolated
/// profile dir (`<cli>-<slug>`); `since_ms` is the pane's start time, so
/// logs untouched since then are ignored.
pub fn read_usage(
    cli_id: &str,
    profile_dir: &Path,
    worktree_path: &str,
    since_ms: f64,
) -> Result<SessionUsage, AppError> {
    let supported = match cli_id {
        "claude" | "codex" => true,
        "opencode" | "gemini" | "copilot" | "muse" | "custom" => false,
        _ => return Err(AppError::validation("Unknown CLI id")),
    };
    if !supported {
        return Ok(SessionUsage::Unsupported);
    }
    let name = profile_dir.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !profile_dir.is_absolute() || !name.starts_with(&format!("{cli_id}-")) {
        return Err(AppError::validation("Usage needs the CLI's isolated profile dir"));
    }
    if !Path::new(worktree_path).is_absolute() {
        return Err(AppError::validation("Worktree path must be absolute"));
    }
    let since = if since_ms.is_finite() { since_ms.max(0.0) } else { 0.0 };
    Ok(match cli_id {
        "claude" => read_claude(profile_dir, worktree_path, since),
        _ => read_codex(profile_dir, worktree_path, since),
    })
}

/// Stats file the saver sidecar appends to: `<notify dir>/saver-<agent>.log`.
pub fn saver_stats_path(agent_id: &str) -> Result<PathBuf, AppError> {
    if !crate::saver::valid_agent_id(agent_id) {
        return Err(AppError::validation("Invalid agent session id"));
    }
    let socket = crate::notify::socket_path()?;
    let Some(dir) = socket.parent() else {
        return Err(AppError::internal("Notify socket has no parent dir"));
    };
    Ok(dir.join(format!("saver-{agent_id}.log")))
}

/// Sum `<before> <after>` lines; malformed lines are skipped, a missing file is zero.
pub fn read_saver_stats_file(path: &Path) -> SaverStats {
    let mut stats = SaverStats::default();
    let Ok(file) = std::fs::File::open(path) else { return stats };
    let mut text = String::new();
    if file.take(MAX_STATS_BYTES).read_to_string(&mut text).is_err() {
        return stats;
    }
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(before), Some(after), None) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let (Ok(before), Ok(after)) = (before.parse::<u64>(), after.parse::<u64>()) else {
            continue;
        };
        stats.runs = stats.runs.saturating_add(1);
        stats.bytes_before = stats.bytes_before.saturating_add(before);
        stats.bytes_after = stats.bytes_after.saturating_add(after);
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    struct TempDir(PathBuf);
    impl TempDir {
        fn fresh(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "branchwork-test-usage-{}-{}",
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

    fn claude_line(id: &str, input: u64, cache_create: u64, cache_read: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"id":"{id}","role":"assistant","content":[],"usage":{{"input_tokens":{input},"cache_creation_input_tokens":{cache_create},"cache_read_input_tokens":{cache_read},"output_tokens":{output}}}}}}}"#
        )
    }

    fn ok_tokens(usage: &SessionUsage) -> TokenCounts {
        match usage {
            SessionUsage::Ok(report) => report.tokens.clone(),
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn claude_dir_encoding() {
        assert_eq!(claude_project_dir_name("/Users/a/my.repo"), "-Users-a-my-repo");
        assert_eq!(claude_project_dir_name("/x/y_z"), "-x-y-z");
    }

    #[test]
    fn claude_sums_and_dedupes_message_ids() {
        let tmp = TempDir::fresh("claude-dedupe");
        let profile = tmp.0.join("claude-p");
        let project = profile.join("projects").join(claude_project_dir_name("/w/repo"));
        std::fs::create_dir_all(&project).unwrap();
        let body = [
            claude_line("m1", 2, 100, 50, 10),
            claude_line("m1", 2, 100, 50, 10),
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#.to_string(),
            claude_line("m2", 3, 0, 200, 7),
        ]
        .join("\n")
            + "\n";
        std::fs::write(project.join("s.jsonl"), body).unwrap();
        let usage = read_usage("claude", &profile, "/w/repo", 0.0).unwrap();
        let tokens = ok_tokens(&usage);
        assert_eq!(tokens.input, 2 + 100 + 50 + 3 + 200);
        assert_eq!(tokens.output, 17);
        assert_eq!(tokens.total, 355 + 17);
        let SessionUsage::Ok(report) = usage else { unreachable!() };
        assert!(report.context_limit.is_none());
        assert!(report.quota.is_none());
    }

    #[test]
    fn claude_without_log_is_no_data() {
        let tmp = TempDir::fresh("claude-empty");
        let profile = tmp.0.join("claude-p");
        std::fs::create_dir_all(&profile).unwrap();
        assert!(matches!(
            read_usage("claude", &profile, "/w/repo", 0.0).unwrap(),
            SessionUsage::NoData
        ));
    }

    fn codex_meta(cwd: &str) -> String {
        format!(r#"{{"type":"session_meta","payload":{{"id":"x","cwd":"{cwd}"}}}}"#)
    }

    fn codex_count(total_in: u64, total_out: u64, last_total: u64, used: f64) -> String {
        format!(
            r#"{{"type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{total_in},"output_tokens":{total_out},"total_tokens":{}}},"last_token_usage":{{"total_tokens":{last_total}}},"model_context_window":258400}},"rate_limits":{{"primary":{{"used_percent":{used},"window_minutes":43200,"resets_at":1797183951}}}}}}}}"#,
            total_in + total_out
        )
    }

    #[test]
    fn codex_reads_last_token_count_and_quota() {
        let tmp = TempDir::fresh("codex-last");
        let profile = tmp.0.join("codex-p");
        let day = profile.join("sessions/2026/11/14");
        std::fs::create_dir_all(&day).unwrap();
        let body = [
            codex_meta("/w/repo"),
            codex_count(100, 5, 50, 1.0),
            r#"{"type":"event_msg","payload":{"type":"token_count","info":null}}"#.to_string(),
            codex_count(3689101, 10447, 99112, 4.0),
        ]
        .join("\n")
            + "\n";
        std::fs::write(day.join("rollout-a.jsonl"), body).unwrap();
        let usage = read_usage("codex", &profile, "/w/repo", 0.0).unwrap();
        let SessionUsage::Ok(report) = usage else { panic!("expected Ok, got {usage:?}") };
        assert_eq!(report.tokens.input, 3689101);
        assert_eq!(report.tokens.output, 10447);
        assert_eq!(report.tokens.total, 3689101 + 10447);
        assert_eq!(report.context_used, Some(99112));
        assert_eq!(report.context_limit, Some(258400));
        let quota = report.quota.unwrap();
        assert_eq!(quota.percent, 4);
        assert_eq!(quota.window_minutes, Some(43200));
        assert_eq!(quota.resets_at, Some(1797183951));
    }

    #[test]
    fn codex_skips_other_cwd() {
        let tmp = TempDir::fresh("codex-cwd");
        let profile = tmp.0.join("codex-p");
        let day = profile.join("sessions/2026/11/14");
        std::fs::create_dir_all(&day).unwrap();
        let body = [codex_meta("/other"), codex_count(1, 1, 1, 1.0)].join("\n") + "\n";
        std::fs::write(day.join("rollout-b.jsonl"), body).unwrap();
        assert!(matches!(
            read_usage("codex", &profile, "/w/repo", 0.0).unwrap(),
            SessionUsage::NoData
        ));
    }

    #[test]
    fn incremental_read_appends() {
        let tmp = TempDir::fresh("claude-incr");
        let profile = tmp.0.join("claude-p");
        let project = profile.join("projects").join(claude_project_dir_name("/w/inc"));
        std::fs::create_dir_all(&project).unwrap();
        let file = project.join("s.jsonl");
        std::fs::write(&file, claude_line("a", 1, 0, 0, 1) + "\n").unwrap();
        assert_eq!(ok_tokens(&read_usage("claude", &profile, "/w/inc", 0.0).unwrap()).total, 2);
        let mut handle = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
        // A partial trailing line is held back until it is complete.
        write!(handle, "{}", claude_line("b", 10, 0, 0, 10)).unwrap();
        assert_eq!(ok_tokens(&read_usage("claude", &profile, "/w/inc", 0.0).unwrap()).total, 2);
        writeln!(handle).unwrap();
        assert_eq!(ok_tokens(&read_usage("claude", &profile, "/w/inc", 0.0).unwrap()).total, 22);
        assert_eq!(ok_tokens(&read_usage("claude", &profile, "/w/inc", 0.0).unwrap()).total, 22);
    }

    #[test]
    fn rejects_unknown_cli_and_foreign_profile_dirs() {
        let tmp = TempDir::fresh("validate");
        let profile = tmp.0.join("codex-p");
        std::fs::create_dir_all(&profile).unwrap();
        assert!(read_usage("claude", &profile, "/w/repo", 0.0).is_err());
        assert!(read_usage("claude", Path::new("relative/claude-p"), "/w/repo", 0.0).is_err());
        assert!(read_usage("codex", &profile, "relative", 0.0).is_err());
        assert!(matches!(
            read_usage("gemini", &tmp.0.join("gemini-p"), "/w/repo", 0.0).unwrap(),
            SessionUsage::Unsupported
        ));
        assert!(read_usage("bogus", &profile, "/w/repo", 0.0).is_err());
    }

    #[test]
    fn saver_stats_sums_lines_and_rejects_bad_id() {
        let tmp = TempDir::fresh("stats");
        let file = tmp.0.join("saver-agent-x.log");
        std::fs::write(&file, "100 40\n50 10\ngarbage\n7\n").unwrap();
        let stats = read_saver_stats_file(&file);
        assert_eq!(stats.runs, 2);
        assert_eq!(stats.bytes_before, 150);
        assert_eq!(stats.bytes_after, 50);
        let missing = read_saver_stats_file(&tmp.0.join("nope.log"));
        assert_eq!(missing.runs, 0);
        assert!(saver_stats_path("agent-ok-1").is_ok());
        assert!(saver_stats_path("agent-../x").is_err());
        assert!(saver_stats_path("pty-1").is_err());
    }
}
