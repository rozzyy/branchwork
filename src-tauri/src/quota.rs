//! Account quota readers for agent profiles (Orca-style usage windows).
//!
//! Quota is per account (profile), not per pane. Sources are the vendor
//! CLI's own local state, never credentials or network calls:
//! - Claude Code caches `cachedUsageUtilization` in `<profile>/.claude.json`
//!   (5-hour and weekly windows, with the time it was fetched).
//! - Codex records `rate_limits.primary/secondary` in its rollout logs; the
//!   newest record in the profile wins.
//!
//! Inputs are untrusted: every field is type-checked and files are capped.
//! Codex logs are read incrementally (byte offset per file): O(new bytes)
//! per poll, O(1) retained state per cached file.

use crate::error::AppError;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

const MAX_CLAUDE_STATE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;
const MAX_STATS_BYTES: u64 = 1024 * 1024;
const MAX_CACHED_READERS: usize = 64;
/// `sessions/YYYY/MM/DD/rollout-*.jsonl`.
const CODEX_WALK_DEPTH: usize = 4;
/// Newest rollout files checked for rate limits per poll.
const MAX_CODEX_CANDIDATES: usize = 8;

/// One provider-reported limit window.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    /// Window length: 300 = 5 hours, 10080 = weekly.
    pub minutes: u32,
    /// Model scope of the window (`opus`, `sonnet`), or None for all models.
    pub scope: Option<String>,
    /// 0–100, the provider's own figure.
    pub percent: u32,
    /// Unix ms.
    pub resets_at_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QuotaReport {
    pub windows: Vec<QuotaWindow>,
    /// When the provider reported these figures (unix ms), if known.
    pub fetched_at_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ProfileQuota {
    /// The CLI has no quota reader.
    Unsupported,
    /// A reader exists but the CLI has not recorded quota yet.
    NoData,
    Ok(QuotaReport),
}

/// Measured RTK-style savings for one agent session (bytes, not tokens).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SaverStats {
    pub runs: u32,
    pub bytes_before: u64,
    pub bytes_after: u64,
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)` → unix ms (millisecond precision).
pub fn parse_rfc3339_ms(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T'
        || bytes[13] != b':' || bytes[16] != b':'
    {
        return None;
    }
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = text.get(range)?;
        part.bytes().all(|b| b.is_ascii_digit()).then(|| part.parse().ok())?
    };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut rest = &text[19..];
    let mut millis = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let padded = format!("{:0<3}", &frac[..digits.min(3)]);
        millis = padded.parse().ok()?;
        rest = &frac[digits..];
    }
    let offset_minutes = match rest {
        "Z" | "z" => 0,
        _ if rest.len() == 6 && rest.as_bytes()[3] == b':' => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let hours: i64 = rest.get(1..3)?.parse().ok()?;
            let mins: i64 = rest.get(4..6)?.parse().ok()?;
            sign * (hours * 60 + mins)
        }
        _ => return None,
    };
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second
        - offset_minutes * 60;
    Some((seconds * 1000 + millis) as f64)
}

fn clamp_percent(value: f64) -> Option<u32> {
    value.is_finite().then(|| value.round().clamp(0.0, 100.0) as u32)
}

fn read_claude(profile_dir: &Path) -> ProfileQuota {
    let Ok(file) = std::fs::File::open(profile_dir.join(".claude.json")) else {
        return ProfileQuota::NoData;
    };
    let mut text = String::new();
    if file.take(MAX_CLAUDE_STATE_BYTES).read_to_string(&mut text).is_err() {
        return ProfileQuota::NoData;
    }
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&text) else {
        return ProfileQuota::NoData;
    };
    let Some(cache) = root.get("cachedUsageUtilization").filter(|v| v.is_object()) else {
        return ProfileQuota::NoData;
    };
    let Some(utilization) = cache.get("utilization").filter(|v| v.is_object()) else {
        return ProfileQuota::NoData;
    };
    let windows: Vec<QuotaWindow> = [
        ("five_hour", 300, None),
        ("seven_day", 10_080, None),
        ("seven_day_opus", 10_080, Some("opus")),
        ("seven_day_sonnet", 10_080, Some("sonnet")),
    ]
    .into_iter()
    .filter_map(|(key, minutes, scope)| {
        let window = utilization.get(key)?;
        let percent = clamp_percent(window.get("utilization")?.as_f64()?)?;
        Some(QuotaWindow {
            minutes,
            scope: scope.map(str::to_owned),
            percent,
            resets_at_ms: window.get("resets_at").and_then(|v| v.as_str()).and_then(parse_rfc3339_ms),
        })
    })
    .collect();
    if windows.is_empty() {
        return ProfileQuota::NoData;
    }
    ProfileQuota::Ok(QuotaReport {
        windows,
        fetched_at_ms: cache.get("fetchedAtMs").and_then(|v| v.as_f64()).filter(|v| v.is_finite()),
    })
}

#[derive(Default)]
struct ReaderState {
    offset: u64,
    last_used: u64,
    latest: Option<QuotaReport>,
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

fn codex_window(value: &serde_json::Value) -> Option<QuotaWindow> {
    let percent = clamp_percent(value.get("used_percent")?.as_f64()?)?;
    let minutes = u32::try_from(value.get("window_minutes")?.as_u64()?).ok()?;
    Some(QuotaWindow {
        minutes,
        scope: None,
        percent,
        resets_at_ms: value
            .get("resets_at")
            .and_then(|v| v.as_u64())
            .map(|secs| secs as f64 * 1000.0),
    })
}

fn apply_codex_line(state: &mut ReaderState, value: &serde_json::Value) {
    if value.get("type").and_then(|v| v.as_str()) != Some("event_msg") {
        return;
    }
    let Some(payload) = value.get("payload") else { return };
    if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
        return;
    }
    let Some(limits) = payload.get("rate_limits").filter(|v| v.is_object()) else { return };
    let windows: Vec<QuotaWindow> = ["primary", "secondary"]
        .iter()
        .filter_map(|key| limits.get(*key).and_then(codex_window))
        .collect();
    if windows.is_empty() {
        return;
    }
    state.latest = Some(QuotaReport {
        windows,
        fetched_at_ms: value.get("timestamp").and_then(|v| v.as_str()).and_then(parse_rfc3339_ms),
    });
}

/// Consume whole new lines of a rollout into its cached state; returns the
/// newest rate-limit report seen in the file.
fn codex_file_report(path: &Path) -> Option<QuotaReport> {
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
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) {
                    apply_codex_line(state, &value);
                }
            }
            state.offset += end as u64 + 1;
        }
    }
    state.latest.clone()
}

fn mtime_ms(path: &Path) -> Option<f64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as f64)
}

fn collect_rollouts(dir: &Path, depth: usize, out: &mut Vec<(f64, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if depth > 1 {
                collect_rollouts(&path, depth - 1, out);
            }
        } else if kind.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
            && let Some(ms) = mtime_ms(&path)
        {
            out.push((ms, path));
        }
    }
}

fn read_codex(profile_dir: &Path) -> ProfileQuota {
    let mut candidates = Vec::new();
    collect_rollouts(&profile_dir.join("sessions"), CODEX_WALK_DEPTH, &mut candidates);
    candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
    candidates
        .into_iter()
        .take(MAX_CODEX_CANDIDATES)
        .find_map(|(_, path)| codex_file_report(&path))
        .map_or(ProfileQuota::NoData, ProfileQuota::Ok)
}

/// Quota for one profile. `profile_dir` must be the CLI's isolated profile
/// dir (`<cli>-<slug>`).
pub fn read_quota(cli_id: &str, profile_dir: &Path) -> Result<ProfileQuota, AppError> {
    let supported = match cli_id {
        "claude" | "codex" => true,
        "opencode" | "gemini" | "copilot" | "muse" | "custom" => false,
        _ => return Err(AppError::validation("Unknown CLI id")),
    };
    if !supported {
        return Ok(ProfileQuota::Unsupported);
    }
    let name = profile_dir.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !profile_dir.is_absolute() || !name.starts_with(&format!("{cli_id}-")) {
        return Err(AppError::validation("Quota needs the CLI's isolated profile dir"));
    }
    Ok(match cli_id {
        "claude" => read_claude(profile_dir),
        _ => read_codex(profile_dir),
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
    use std::path::PathBuf;

    struct TempDir(PathBuf);
    impl TempDir {
        fn fresh(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "branchwork-test-quota-{}-{}",
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

    fn ok(quota: ProfileQuota) -> QuotaReport {
        match quota {
            ProfileQuota::Ok(report) => report,
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn parses_rfc3339_to_unix_ms() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(
            parse_rfc3339_ms("2026-11-19T10:59:59.854599+00:00"),
            Some(1_795_085_999_854.0)
        );
        assert_eq!(
            parse_rfc3339_ms("2026-11-19T12:59:59+02:00"),
            Some(1_795_085_999_000.0)
        );
        assert_eq!(parse_rfc3339_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_rfc3339_ms("nonsense"), None);
    }

    #[test]
    fn claude_reads_cached_utilization_windows() {
        let tmp = TempDir::fresh("claude");
        let profile = tmp.0.join("claude-p");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(
            profile.join(".claude.json"),
            r#"{"numStartups": 3, "cachedUsageUtilization": {"fetchedAtMs": 1794571658943, "utilization": {
                "five_hour": {"utilization": 42.4, "resets_at": "2026-11-13T12:29:59.854581+00:00"},
                "seven_day": {"utilization": 35, "resets_at": "2026-11-19T10:59:59.854599+00:00"},
                "seven_day_opus": {"utilization": 120, "resets_at": null},
                "seven_day_sonnet": null,
                "tangelo": {"utilization": 99}
            }}}"#,
        )
        .unwrap();
        let report = ok(read_quota("claude", &profile).unwrap());
        assert_eq!(report.fetched_at_ms, Some(1_794_571_658_943.0));
        assert_eq!(
            report.windows,
            vec![
                QuotaWindow { minutes: 300, scope: None, percent: 42, resets_at_ms: parse_rfc3339_ms("2026-11-13T12:29:59.854581+00:00") },
                QuotaWindow { minutes: 10080, scope: None, percent: 35, resets_at_ms: Some(1_795_085_999_854.0) },
                QuotaWindow { minutes: 10080, scope: Some("opus".into()), percent: 100, resets_at_ms: None },
            ]
        );
    }

    #[test]
    fn claude_without_cache_is_no_data() {
        let tmp = TempDir::fresh("claude-none");
        let profile = tmp.0.join("claude-p");
        std::fs::create_dir_all(&profile).unwrap();
        assert!(matches!(read_quota("claude", &profile).unwrap(), ProfileQuota::NoData));
        std::fs::write(profile.join(".claude.json"), r#"{"cachedUsageUtilization": null}"#).unwrap();
        assert!(matches!(read_quota("claude", &profile).unwrap(), ProfileQuota::NoData));
        std::fs::write(profile.join(".claude.json"), "not json").unwrap();
        assert!(matches!(read_quota("claude", &profile).unwrap(), ProfileQuota::NoData));
    }

    fn codex_count(ts: &str, primary: f64, secondary: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"token_count","info":null,"rate_limits":{{"primary":{{"used_percent":{primary},"window_minutes":300,"resets_at":1797183951}},"secondary":{secondary}}}}}}}"#
        )
    }

    #[test]
    fn codex_reads_newest_rate_limits() {
        let tmp = TempDir::fresh("codex");
        let profile = tmp.0.join("codex-p");
        let day = profile.join("sessions/2026/11/14");
        std::fs::create_dir_all(&day).unwrap();
        let body = [
            r#"{"type":"session_meta","payload":{"cwd":"/anywhere"}}"#.to_string(),
            codex_count("2026-11-14T01:00:00Z", 1.0, "null"),
            codex_count(
                "2026-11-14T02:00:00Z",
                12.6,
                r#"{"used_percent":40.0,"window_minutes":10080,"resets_at":1797700000}"#,
            ),
            r#"{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":null}}"#.to_string(),
        ]
        .join("\n")
            + "\n";
        std::fs::write(day.join("rollout-a.jsonl"), body).unwrap();
        let report = ok(read_quota("codex", &profile).unwrap());
        assert_eq!(report.fetched_at_ms, parse_rfc3339_ms("2026-11-14T02:00:00Z"));
        assert_eq!(
            report.windows,
            vec![
                QuotaWindow { minutes: 300, scope: None, percent: 13, resets_at_ms: Some(1_797_183_951_000.0) },
                QuotaWindow { minutes: 10080, scope: None, percent: 40, resets_at_ms: Some(1_797_700_000_000.0) },
            ]
        );
    }

    #[test]
    fn codex_without_rate_limits_is_no_data() {
        let tmp = TempDir::fresh("codex-none");
        let profile = tmp.0.join("codex-p");
        std::fs::create_dir_all(profile.join("sessions")).unwrap();
        assert!(matches!(read_quota("codex", &profile).unwrap(), ProfileQuota::NoData));
    }

    #[test]
    fn rejects_unknown_cli_and_foreign_profile_dirs() {
        let tmp = TempDir::fresh("validate");
        let profile = tmp.0.join("codex-p");
        std::fs::create_dir_all(&profile).unwrap();
        assert!(read_quota("claude", &profile).is_err());
        assert!(read_quota("codex", Path::new("relative/codex-p")).is_err());
        assert!(read_quota("bogus", &profile).is_err());
        assert!(matches!(
            read_quota("gemini", &tmp.0.join("gemini-p")).unwrap(),
            ProfileQuota::Unsupported
        ));
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
        assert_eq!(read_saver_stats_file(&tmp.0.join("nope.log")).runs, 0);
        assert!(saver_stats_path("agent-ok-1").is_ok());
        assert!(saver_stats_path("agent-../x").is_err());
        assert!(saver_stats_path("pty-1").is_err());
    }
}
