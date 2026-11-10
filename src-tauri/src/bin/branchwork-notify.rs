//! `branchwork-notify <session> <event>` — tiny hook sidecar (spec §6.6.3).
//!
//! Agent CLI hooks call this binary; it forwards one line over the Unix
//! socket at `BRANCHWORK_NOTIFY_SOCKET` and exits. It never reads the user
//! config, never prints secrets, and performs no validation beyond cheap
//! shape caps — the backend re-validates everything.

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
    if writeln!(stream, "{session} {event}").is_err() {
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
