//! `branchwork-saver` — token-saver sidecar for agent sessions.
//!
//! `branchwork-saver hook` is a Claude Code `PreToolUse` hook: it reads the
//! tool call on stdin and, only when the session env sets
//! `BRANCHWORK_SAVER=rtk`, rewrites allowlisted simple Bash commands to the
//! run mode. Any error prints nothing, so the call proceeds unchanged.
//!
//! `branchwork-saver statusline` is a Claude Code statusline command: it records the live
//! `rate_limits` (5-hour and weekly usage) from the report on stdin into
//! `$CLAUDE_CONFIG_DIR/branchwork-quota.json` for Branchwork's usage meter and prints a short
//! summary for Claude's own status line. Only numbers are stored.
//!
//! `branchwork-saver run -- <argv>` runs the command with inherited stdin
//! and stderr, filters stdout on success (fail-open), keeps the exit code,
//! and appends measured `<before> <after>` byte counts to the session's
//! stats file next to the notify socket.

use branchwork_lib::saver;
use std::io::{Read, Write};
use std::process::{Command, Stdio};

const MAX_HOOK_INPUT: u64 = 1024 * 1024;
/// Larger stdout is streamed through unfiltered.
const MAX_CAPTURE: usize = 4 * 1024 * 1024;

fn hook() -> i32 {
    if std::env::var("BRANCHWORK_SAVER").as_deref() != Ok("rtk") {
        return 0;
    }
    let mut input = String::new();
    if std::io::stdin().take(MAX_HOOK_INPUT).read_to_string(&mut input).is_err() {
        return 0;
    }
    let protected: Vec<String> = std::env::var("BRANCHWORK_SAVER_PROTECT")
        .unwrap_or_default()
        .split(',')
        .map(|entry| entry.trim().to_owned())
        .filter(|entry| !entry.is_empty())
        .collect();
    let Ok(bin) = std::env::current_exe() else { return 0 };
    if let Some(reply) = saver::hook_response(&input, &protected, &bin.to_string_lossy()) {
        println!("{reply}");
    }
    0
}

fn statusline() -> i32 {
    let mut input = String::new();
    if std::io::stdin().take(MAX_HOOK_INPUT).read_to_string(&mut input).is_err() {
        return 0;
    }
    let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from) else {
        return 0;
    };
    let path = dir.join("branchwork-quota.json");
    let previous = std::fs::File::open(&path).ok().and_then(|file| {
        let mut text = String::new();
        file.take(64 * 1024).read_to_string(&mut text).ok()?;
        serde_json::from_str::<serde_json::Value>(&text).ok()
    });
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let Some(quota) = saver::statusline_quota(&input, previous.as_ref(), now_ms) else {
        if let Some(previous) = previous {
            println!("{}", saver::statusline_text(&previous));
        }
        return 0;
    };
    // Write then rename, so the app never reads a half-written file.
    let tmp = dir.join(format!("branchwork-quota.{}.tmp", std::process::id()));
    if std::fs::write(&tmp, quota.to_string()).is_ok() && std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    println!("{}", saver::statusline_text(&quota));
    0
}

fn record_saving(before: usize, after: usize) {
    let (Some(socket), Ok(agent)) = (
        std::env::var_os("BRANCHWORK_NOTIFY_SOCKET"),
        std::env::var("BRANCHWORK_AGENT_SESSION"),
    ) else {
        return;
    };
    if !saver::valid_agent_id(&agent) {
        return;
    }
    let Some(dir) = std::path::Path::new(&socket).parent() else { return };
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(dir.join(format!("saver-{agent}.log"))) {
        let _ = writeln!(file, "{before} {after}");
    }
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

fn run(argv: &[String]) -> i32 {
    let Some(program) = argv.first() else {
        eprintln!("usage: branchwork-saver run -- <command> [args...]");
        return 2;
    };
    let mut child = match Command::new(program)
        .args(&argv[1..])
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            eprintln!("{program}: {error}");
            return 127;
        }
    };
    let mut stdout = std::io::stdout().lock();
    let mut captured = Vec::new();
    let mut overflow = false;
    if let Some(mut pipe) = child.stdout.take() {
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) if !overflow => {
                    captured.extend_from_slice(&chunk[..read]);
                    if captured.len() > MAX_CAPTURE {
                        // Too big to buffer: hand everything through raw.
                        overflow = true;
                        let _ = stdout.write_all(&captured);
                        captured.clear();
                    }
                }
                Ok(read) => {
                    let _ = stdout.write_all(&chunk[..read]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
    }
    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => {
            let _ = stdout.write_all(&captured);
            eprintln!("{program}: {error}");
            return 1;
        }
    };
    if !overflow {
        let filtered = status
            .success()
            .then(|| std::str::from_utf8(&captured).ok())
            .flatten()
            .and_then(|text| saver::compress(argv, text));
        match filtered {
            Some(text) => {
                let _ = stdout.write_all(text.as_bytes());
                record_saving(captured.len(), text.len());
            }
            None => {
                let _ = stdout.write_all(&captured);
            }
        }
    }
    let _ = stdout.flush();
    exit_code(status)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("hook") if args.len() == 1 => hook(),
        Some("statusline") if args.len() == 1 => statusline(),
        Some("run") if args.get(1).map(String::as_str) == Some("--") => run(&args[2..]),
        _ => {
            eprintln!("usage: branchwork-saver hook | statusline | run -- <command> [args...]");
            2
        }
    };
    std::process::exit(code);
}
