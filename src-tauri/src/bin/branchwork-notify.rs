//! `branchwork-notify <session> <event>` — tiny hook sidecar (spec §6.6.3).
//!
//! Agent CLI hooks call this binary; it forwards one line over the Unix
//! socket at `BRANCHWORK_NOTIFY_SOCKET` and exits. It never reads the user
//! config, never prints secrets, and performs no validation beyond cheap
//! shape caps — the backend re-validates everything.
//!
//! When a hook pipes its JSON payload on stdin (Claude Code does), the
//! conversation `session_id` is appended to the line if it is UUID-shaped.
//! Any read or parse problem just leaves it out.

/// Hook payloads are small; anything larger is not parsed.
const MAX_STDIN: u64 = 64 * 1024;

fn uuid_shaped(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// `session_id` from the hook JSON on stdin, when stdin is piped.
fn conversation_from_stdin() -> Option<String> {
    use std::io::{IsTerminal, Read};
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        return None;
    }
    let mut text = String::new();
    stdin.lock().take(MAX_STDIN + 1).read_to_string(&mut text).ok()?;
    if text.len() as u64 > MAX_STDIN {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let id = value.get("session_id")?.as_str()?;
    uuid_shaped(id).then(|| id.to_owned())
}

#[cfg(unix)]
fn run(session: &std::ffi::OsString, event: &std::ffi::OsString) -> i32 {
    use std::io::Write;
    let (Some(session), Some(event)) = (session.to_str(), event.to_str()) else {
        eprintln!("branchwork-notify: arguments must be UTF-8");
        return 2;
    };
    if session.len() > 32 || event.len() > 16 || session.is_empty() || event.is_empty() {
        eprintln!("branchwork-notify: bad argument shape");
        return 2;
    }
    // Read the hook payload before dialing, so a slow stdin never holds the
    // app's notify socket.
    let conversation = conversation_from_stdin();
    let socket = match std::env::var_os("BRANCHWORK_NOTIFY_SOCKET") {
        Some(path) => path,
        None => {
            eprintln!("branchwork-notify: BRANCHWORK_NOTIFY_SOCKET is not set");
            return 2;
        }
    };
    let mut stream = match std::os::unix::net::UnixStream::connect(socket) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("branchwork-notify: could not dial socket: {error}");
            return 1;
        }
    };
    let line = match conversation {
        Some(conversation) => format!("{session} {event} {conversation}"),
        None => format!("{session} {event}"),
    };
    if writeln!(stream, "{line}").is_err() {
        eprintln!("branchwork-notify: could not write event");
        return 1;
    }
    0
}

#[cfg(not(unix))]
fn run(_session: &std::ffi::OsString, _event: &std::ffi::OsString) -> i32 {
    eprintln!("branchwork-notify: not supported on this platform");
    2
}

fn main() {
    let mut args = std::env::args_os();
    let _program = args.next();
    let (session, event) = match (args.next(), args.next(), args.next()) {
        (Some(session), Some(event), None) => (session, event),
        _ => {
            eprintln!("usage: branchwork-notify <session> <event>");
            std::process::exit(2);
        }
    };
    std::process::exit(run(&session, &event));
}
