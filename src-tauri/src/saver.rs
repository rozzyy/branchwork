//! RTK-style tool-output compression for agent sessions (spec: agent session
//! usage and token saver).
//!
//! The `branchwork-saver` sidecar runs as a Claude Code `PreToolUse` hook and
//! rewrites a small allowlist of simple, read-mostly Bash commands to
//! `branchwork-saver run -- <command>`. The run mode executes the same argv
//! and filters its stdout with the deterministic rules below. Everything is
//! fail-open: shell syntax, protected tools, failures, JSON, or a filter
//! that does not shrink the output all keep the original bytes. Filtering is
//! one pass over the output: O(n) time and O(n) space for n stdout bytes.

/// Characters that make a command more than one simple argv. Such commands
/// are never rewritten: the outer shell must parse them exactly as typed.
const SHELL_SYNTAX: &[char] = &['|', '&', ';', '<', '>', '(', ')', '$', '`', '\\', '\n', '\r'];

/// Collapse runs of at least this many identical lines.
const REPEAT_MIN: usize = 3;

/// `agent-<alnum/dash>` record ids, as issued by the frontend.
pub fn valid_agent_id(agent_id: &str) -> bool {
    agent_id.strip_prefix("agent-").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix.len() <= 64
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

fn allowlisted(tokens: &[&str]) -> bool {
    let second = tokens.get(1).copied().unwrap_or("");
    let third = tokens.get(2).copied().unwrap_or("");
    match tokens.first().copied().unwrap_or("") {
        // No `diff`/`show`/`log -p`: patches carry meaningful whitespace.
        "git" => {
            matches!(second, "status" | "branch")
                || (second == "log" && !tokens.iter().any(|t| matches!(*t, "-p" | "-u" | "--patch")))
        }
        "ls" | "pytest" => true,
        "cargo" => matches!(second, "test" | "build" | "check" | "clippy"),
        "pnpm" | "npm" | "yarn" => {
            matches!(second, "test" | "typecheck" | "lint")
                || (second == "run" && matches!(third, "test" | "typecheck" | "lint"))
        }
        "go" => second == "test",
        _ => false,
    }
}

/// Wrap an allowlisted simple command for the run mode, or None to leave it.
pub fn rewrite_command(command: &str, protected: &[String], bin: &str) -> Option<String> {
    let command = command.trim();
    if command.is_empty() || command.contains(SHELL_SYNTAX) || command.contains("branchwork-saver") {
        return None;
    }
    let tokens: Vec<&str> = command.split_whitespace().collect();
    if tokens[0].contains('=') || !allowlisted(&tokens) {
        return None;
    }
    let one = tokens[0].to_owned();
    let two = tokens.iter().take(2).copied().collect::<Vec<_>>().join(" ");
    if protected
        .iter()
        .map(|entry| entry.trim())
        .any(|entry| !entry.is_empty() && (entry == one || entry == two))
    {
        return None;
    }
    Some(format!("'{}' run -- {command}", bin.replace('\'', "'\\''")))
}

fn looks_like_json(text: &str) -> bool {
    let trimmed = text.trim();
    if serde_json::from_str::<serde_json::Value>(trimmed).is_ok_and(|v| v.is_object() || v.is_array()) {
        return true;
    }
    // JSON Lines: the first record decides.
    trimmed
        .lines()
        .find(|line| !line.trim().is_empty())
        .and_then(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .is_some_and(|v| v.is_object() || v.is_array())
}

/// Remove ANSI CSI sequences (`ESC [ params letter`).
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

fn drop_line(tool: &str, line: &str) -> bool {
    match tool {
        "git" => line.starts_with("  (use \"git"),
        "cargo" => {
            line.starts_with("   Compiling ")
                || line.starts_with("    Checking ")
                || (line.starts_with("test ") && line.ends_with(" ... ok"))
        }
        "pnpm" | "npm" | "yarn" => line.trim_start().starts_with("✓ "),
        _ => false,
    }
}

/// Filter a successful command's stdout. None when the original must pass
/// through unchanged (empty, JSON, or nothing to save).
pub fn compress(argv: &[String], stdout: &str) -> Option<String> {
    if stdout.trim().is_empty() || looks_like_json(stdout) {
        return None;
    }
    let tool = argv.first().map(String::as_str).unwrap_or("");
    let clean = strip_ansi(stdout);
    let mut kept: Vec<&str> = Vec::new();
    for line in clean.lines() {
        let line = line.trim_end();
        if drop_line(tool, line) {
            continue;
        }
        if line.is_empty() && kept.last().is_some_and(|last| last.is_empty()) {
            continue;
        }
        kept.push(line);
    }
    let mut out = String::with_capacity(clean.len());
    let mut index = 0;
    while index < kept.len() {
        let line = kept[index];
        let run = kept[index..].iter().take_while(|other| **other == line).count();
        out.push_str(line);
        out.push('\n');
        if run >= REPEAT_MIN && !line.is_empty() {
            out.push_str(&format!("… (repeated {run}×)\n"));
            index += run;
        } else {
            index += 1;
        }
    }
    if !stdout.ends_with('\n') {
        out.pop();
    }
    (out.len() < stdout.len()).then_some(out)
}

/// Claude Code `PreToolUse` hook reply for one tool call, or None to leave
/// the call untouched. Never sets `permissionDecision`: the user's own
/// permission rules still decide whether the command runs.
pub fn hook_response(input_json: &str, protected: &[String], bin: &str) -> Option<String> {
    let input: serde_json::Value = serde_json::from_str(input_json).ok()?;
    if input.get("tool_name")?.as_str()? != "Bash" {
        return None;
    }
    let tool_input = input.get("tool_input")?.as_object()?;
    let command = tool_input.get("command")?.as_str()?;
    let rewritten = rewrite_command(command, protected, bin)?;
    let mut updated = tool_input.clone();
    updated.insert("command".into(), serde_json::Value::String(rewritten));
    let reply = serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "updatedInput": updated,
        }
    });
    serde_json::to_string(&reply).ok()
}

/// One statusline window (`{used_percentage, resets_at}`), validated.
fn statusline_window(value: &serde_json::Value) -> Option<serde_json::Value> {
    let percent = value.get("used_percentage")?.as_f64().filter(|p| p.is_finite())?;
    let resets_at = value.get("resets_at")?.as_u64()?;
    Some(serde_json::json!({ "used_percentage": percent, "resets_at": resets_at }))
}

/// Merges the `rate_limits` of a Claude Code statusline report into the last saved quota
/// (windows missing from this report keep their previous values). None when the report
/// carries no valid window. Only numbers are kept; nothing else from the report is stored.
pub fn statusline_quota(
    input_json: &str,
    previous: Option<&serde_json::Value>,
    now_ms: u64,
) -> Option<serde_json::Value> {
    let input: serde_json::Value = serde_json::from_str(input_json).ok()?;
    let limits = input.get("rate_limits")?;
    let mut merged = serde_json::Map::new();
    let mut fresh = false;
    for key in ["five_hour", "seven_day"] {
        if let Some(window) = limits.get(key).and_then(statusline_window) {
            merged.insert(key.into(), window);
            fresh = true;
        } else if let Some(window) = previous.and_then(|p| p.get(key)).and_then(statusline_window) {
            merged.insert(key.into(), window);
        }
    }
    if !fresh {
        return None;
    }
    merged.insert("fetchedAtMs".into(), serde_json::json!(now_ms as f64));
    Some(serde_json::Value::Object(merged))
}

/// The text Claude shows in its own statusline, e.g. `5h 42% · 7d 35%`.
pub fn statusline_text(quota: &serde_json::Value) -> String {
    [("five_hour", "5h"), ("seven_day", "7d")]
        .iter()
        .filter_map(|(key, label)| {
            let percent = quota.get(*key)?.get("used_percentage")?.as_f64()?;
            Some(format!("{label} {:.0}%", percent))
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIN: &str = "/b/branchwork-saver";

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn rewrite_accepts_allowlisted_commands() {
        assert_eq!(
            rewrite_command("git status", &[], BIN).as_deref(),
            Some("'/b/branchwork-saver' run -- git status")
        );
        assert_eq!(
            rewrite_command("  cargo test -p x  ", &[], BIN).as_deref(),
            Some("'/b/branchwork-saver' run -- cargo test -p x")
        );
        assert!(rewrite_command("pnpm run typecheck", &[], BIN).is_some());
        assert!(rewrite_command("git log --format=\"%h %s\" -5", &[], BIN).is_some());
        assert!(rewrite_command("ls -la src", &[], BIN).is_some());
        assert!(rewrite_command("go test ./...", &[], BIN).is_some());
    }

    #[test]
    fn rewrite_rejects_shell_syntax_and_protected() {
        for command in [
            "git status | head",
            "ls; rm x",
            "FOO=1 cargo test",
            "echo $(x)",
            "git log && ls",
            "cargo test > out.txt",
            "git log `x`",
            "git status\nrm x",
            "rm -rf x",
            "git push",
            "npm install",
            "",
            "'/b/branchwork-saver' run -- git status",
        ] {
            assert!(rewrite_command(command, &[], BIN).is_none(), "rewrote {command:?}");
        }
        assert!(rewrite_command("git status", &strings(&["git status"]), BIN).is_none());
        assert!(rewrite_command("cargo test", &strings(&["cargo"]), BIN).is_none());
        assert!(rewrite_command("cargo build", &strings(&["cargo test"]), BIN).is_some());
    }

    #[test]
    fn rewrite_skips_patch_output() {
        // Patches carry meaningful trailing whitespace and blank context
        // lines; the line filters would corrupt them.
        for command in ["git diff", "git diff --cached", "git show HEAD", "git log -p", "git log --patch -3", "git log -u"] {
            assert!(rewrite_command(command, &[], BIN).is_none(), "rewrote {command:?}");
        }
        assert!(rewrite_command("git log --oneline -5", &[], BIN).is_some());
    }

    #[test]
    fn compress_filters_known_noise() {
        let status = "On branch main\nChanges not staged for commit:\n  (use \"git add <file>...\" to update what will be committed)\n  (use \"git restore <file>...\" to discard changes in working directory)\n\tmodified:   src/a.rs\n";
        let out = compress(&strings(&["git", "status"]), status).unwrap();
        assert!(!out.contains("(use \"git"));
        assert!(out.contains("modified:   src/a.rs"));

        let cargo = "   Compiling a v0.1.0\n   Compiling b v0.1.0\nrunning 3 tests\ntest x::one ... ok\ntest x::two ... FAILED\ntest x::three ... ok\n\ntest result: FAILED. 2 passed; 1 failed\n";
        let out = compress(&strings(&["cargo", "test"]), cargo).unwrap();
        assert!(!out.contains("Compiling"));
        assert!(!out.contains("x::one"));
        assert!(out.contains("test x::two ... FAILED"));
        assert!(out.contains("test result: FAILED"));

        let repeated = "start\nsame\nsame\nsame\nsame\nend\n\n\n\nafter   \n";
        let out = compress(&strings(&["ls"]), repeated).unwrap();
        assert_eq!(out, "start\nsame\n… (repeated 4×)\nend\n\nafter\n");

        let colored = "\u{1b}[32mok\u{1b}[0m line\n";
        assert_eq!(compress(&strings(&["ls"]), colored).unwrap(), "ok line\n");

        let vitest = " ✓ src/a.test.ts (3 tests) 5ms\n ✗ src/b.test.ts\n Test Files  1 failed | 1 passed\n";
        let out = compress(&strings(&["pnpm", "test"]), vitest).unwrap();
        assert!(!out.contains("a.test.ts"));
        assert!(out.contains("b.test.ts"));
    }

    #[test]
    fn compress_skips_failures_and_json() {
        assert!(compress(&strings(&["git", "status"]), "{\"a\": [1, 2]}\n").is_none());
        assert!(compress(&strings(&["ls"]), "  [1,\n 2]  \n").is_none());
        // Nothing to drop: the original passes through untouched.
        assert!(compress(&strings(&["ls"]), "a\nb\n").is_none());
        assert!(compress(&strings(&["ls"]), "").is_none());
    }

    #[test]
    fn hook_response_rewrites_bash_only() {
        let read = r#"{"tool_name":"Read","tool_input":{"file_path":"/x"}}"#;
        assert!(hook_response(read, &[], BIN).is_none());
        let piped = r#"{"tool_name":"Bash","tool_input":{"command":"git status | head"}}"#;
        assert!(hook_response(piped, &[], BIN).is_none());
        assert!(hook_response("not json", &[], BIN).is_none());
        let bash = r#"{"tool_name":"Bash","tool_input":{"command":"git status","description":"Show status"}}"#;
        let out = hook_response(bash, &[], BIN).unwrap();
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        let hook = &value["hookSpecificOutput"];
        assert_eq!(hook["hookEventName"], "PreToolUse");
        assert_eq!(
            hook["updatedInput"]["command"],
            "'/b/branchwork-saver' run -- git status"
        );
        assert_eq!(hook["updatedInput"]["description"], "Show status");
        assert!(hook.get("permissionDecision").is_none());
    }

    #[test]
    fn statusline_merges_rate_limits_and_keeps_missing_windows() {
        let input = r#"{"session_id":"x","rate_limits":{"five_hour":{"used_percentage":42.4,"resets_at":1797183951},"seven_day":{"used_percentage":35,"resets_at":1797700000}}}"#;
        let merged = statusline_quota(input, None, 1_000).unwrap();
        assert_eq!(merged["fetchedAtMs"], 1_000.0);
        assert_eq!(merged["five_hour"]["used_percentage"], 42.4);
        assert_eq!(merged["seven_day"]["resets_at"], 1797700000);
        // A later report without five_hour keeps the last known five_hour window.
        let later = r#"{"rate_limits":{"seven_day":{"used_percentage":36,"resets_at":1797700000}}}"#;
        let again = statusline_quota(later, Some(&merged), 2_000).unwrap();
        assert_eq!(again["fetchedAtMs"], 2_000.0);
        assert_eq!(again["five_hour"]["used_percentage"], 42.4);
        assert_eq!(again["seven_day"]["used_percentage"], 36.0);
        // No rate limits at all, or bad shapes: nothing to record.
        assert!(statusline_quota(r#"{"session_id":"x"}"#, None, 1).is_none());
        assert!(statusline_quota(r#"{"rate_limits":{"five_hour":{"used_percentage":"x"}}}"#, None, 1).is_none());
        assert!(statusline_quota("not json", None, 1).is_none());
    }

    #[test]
    fn statusline_text_is_short() {
        let input = r#"{"rate_limits":{"five_hour":{"used_percentage":42.4,"resets_at":1},"seven_day":{"used_percentage":35,"resets_at":2}}}"#;
        let merged = statusline_quota(input, None, 1).unwrap();
        assert_eq!(statusline_text(&merged), "5h 42% · 7d 35%");
    }
}
