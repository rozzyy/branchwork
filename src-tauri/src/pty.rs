use crate::error::{AppError, ErrorKind};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::Path,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    thread,
};
use tauri::{AppHandle, Emitter};

const MAX_COLUMNS: u16 = 500;
const MAX_ROWS: u16 = 500;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_SESSIONS: usize = 8;
const OUTPUT_BUFFER_BYTES: usize = 8 * 1024;
const MAX_PENDING_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PtySession {
    pub session_id: String,
}

#[derive(Debug, Clone)]
enum PtyEvent {
    Output(PtyOutput),
    Exit(PtyExit),
    Error(PtyErrorEvent),
}

type EventSink = Arc<dyn Fn(PtyEvent) + Send + Sync>;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutput {
    pub session_id: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub session_id: String,
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PtyErrorEvent {
    pub session_id: String,
    pub message: String,
}

struct PtySessionState {
    session_id: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    terminator: SessionTerminator,
    closing: std::sync::atomic::AtomicBool,
    event_sink: EventSink,
    events: Mutex<BufferedEvents>,
}

struct BufferedEvents {
    attachment_id: Option<u64>,
    latest_attachment_id: u64,
    completed: bool,
    history: VecDeque<PtyEvent>,
    output_bytes: usize,
    history_truncated: bool,
}

impl PtySessionState {
    fn emit(&self, event: PtyEvent) {
        self.deliver(event, false);
    }

    fn finish(&self, event: PtyEvent) {
        self.deliver(event, true);
    }

    fn deliver(&self, event: PtyEvent, completed: bool) {
        let mut events = self
            .events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        events.completed |= completed;

        if let PtyEvent::Output(output) = &event {
            events.output_bytes += output.data.len();
        }
        events.history.push_back(event.clone());
        while events.output_bytes > MAX_PENDING_OUTPUT_BYTES {
            let Some(oldest) = events.history.pop_front() else {
                break;
            };
            if let PtyEvent::Output(output) = oldest {
                events.output_bytes = events.output_bytes.saturating_sub(output.data.len());
            }
            events.history_truncated = true;
        }
        if events.attachment_id.is_some() {
            (self.event_sink)(event);
        }
    }

    fn attach(&self, attachment_id: u64) {
        let mut events = self
            .events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if attachment_id <= events.latest_attachment_id {
            return;
        }
        events.latest_attachment_id = attachment_id;
        events.attachment_id = Some(attachment_id);
        if events.history_truncated {
            (self.event_sink)(PtyEvent::Error(PtyErrorEvent {
                session_id: self.session_id.clone(),
                message: "Terminal output history exceeded 256 KiB; older output is not available"
                    .to_owned(),
            }));
        }
        for event in &events.history {
            (self.event_sink)(event.clone());
        }
    }

    fn detach(&self, attachment_id: u64) {
        let mut events = self
            .events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if events.attachment_id == Some(attachment_id) {
            events.attachment_id = None;
        }
    }

    fn is_completed(&self) -> bool {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .completed
    }
}

#[cfg(unix)]
struct SessionTerminator {
    process_group_leader: libc::pid_t,
}

#[cfg(windows)]
struct SessionTerminator {
    job: WindowsJob,
}

#[cfg(windows)]
struct WindowsJob(isize);

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

#[cfg(unix)]
impl SessionTerminator {
    fn new(master: &dyn MasterPty, child: &dyn Child) -> Result<Self, AppError> {
        let process_group_leader = master
            .process_group_leader()
            .or_else(|| child.process_id().and_then(|pid| pid.try_into().ok()))
            .ok_or_else(|| {
                AppError::new(
                    ErrorKind::PtySpawn,
                    "Could not identify terminal process group",
                )
            })?;
        Ok(Self {
            process_group_leader,
        })
    }

    fn terminate(&self) -> Result<(), AppError> {
        let result = unsafe { libc::kill(-self.process_group_leader, libc::SIGKILL) };
        if result == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(pty_error("Could not stop terminal process group", error))
    }

    /// Ask the process group to exit on its own (SIGINT). Already-dead groups
    /// are not an error; the caller decides whether to wait or escalate.
    fn interrupt(&self) -> Result<(), AppError> {
        let result = unsafe { libc::kill(-self.process_group_leader, libc::SIGINT) };
        if result == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(pty_error(
            "Could not interrupt terminal process group",
            error,
        ))
    }
}

#[cfg(windows)]
impl SessionTerminator {
    fn new(_master: &dyn MasterPty, child: &dyn Child) -> Result<Self, AppError> {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };

        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(pty_error(
                "Could not create terminal process job",
                std::io::Error::last_os_error(),
            ));
        }
        let job = WindowsJob(handle as isize);
        let mut limits = JOB_OBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(pty_error(
                "Could not configure terminal process job",
                std::io::Error::last_os_error(),
            ));
        }
        let process = child.as_raw_handle().ok_or_else(|| {
            AppError::new(
                ErrorKind::PtySpawn,
                "Could not access terminal process handle",
            )
        })?;
        if unsafe { AssignProcessToJobObject(handle, process) } == 0 {
            return Err(pty_error(
                "Could not assign terminal process to job",
                std::io::Error::last_os_error(),
            ));
        }
        Ok(Self { job })
    }

    fn terminate(&self) -> Result<(), AppError> {
        if unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job.0 as _, 1) }
            == 0
        {
            return Err(pty_error(
                "Could not stop terminal process job",
                std::io::Error::last_os_error(),
            ));
        }
        Ok(())
    }

    /// No console control signal exists for job objects: graceful stop
    /// degrades to an immediate terminate on Windows.
    fn interrupt(&self) -> Result<(), AppError> {
        Ok(())
    }
}

struct PtyManagerInner {
    sessions: Mutex<HashMap<String, Arc<PtySessionState>>>,
    next_id: AtomicU64,
}

impl Drop for PtyManagerInner {
    fn drop(&mut self) {
        let sessions = self
            .sessions
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for (session_id, session) in sessions.drain() {
            if !session.is_completed()
                && let Err(error) = session.terminator.terminate()
            {
                eprintln!("Could not stop PTY session {session_id} during shutdown: {error}");
            }
        }
    }
}

#[derive(Clone)]
pub struct PtyManager {
    inner: Arc<PtyManagerInner>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(PtyManagerInner {
                sessions: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
            }),
        }
    }
}

impl PtyManager {
    pub fn spawn(
        &self,
        worktree_path: &Path,
        columns: u16,
        rows: u16,
        app: AppHandle,
        env: &std::collections::HashMap<String, String>,
    ) -> Result<PtySession, AppError> {
        validate_dimensions(columns, rows)?;
        let mut command = CommandBuilder::new_default_prog();
        command.cwd(worktree_path);
        apply_terminal_defaults(&mut command);
        apply_spawn_env(&mut command, env)?;
        let sink = Arc::new(move |event| emit_event(&app, event));
        self.spawn_command(command, columns, rows, sink)
    }

    fn spawn_command(
        &self,
        command: CommandBuilder,
        columns: u16,
        rows: u16,
        sink: EventSink,
    ) -> Result<PtySession, AppError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(pty_size(columns, rows))
            .map_err(|error| pty_error("Could not create terminal", error))?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| pty_error("Could not start terminal", error))?;
        drop(pair.slave);

        let terminator = match SessionTerminator::new(pair.master.as_ref(), child.as_ref()) {
            Ok(terminator) => terminator,
            Err(error) => {
                if let Err(cleanup_error) = terminate_child(&mut child) {
                    eprintln!(
                        "Could not stop PTY child after termination setup failed: {cleanup_error}"
                    );
                }
                return Err(error);
            }
        };
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                if let Err(cleanup_error) = terminate_and_reap(&mut child, &terminator) {
                    eprintln!("Could not clean up PTY after reader setup failed: {cleanup_error}");
                }
                return Err(pty_error("Could not read terminal output", error));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                if let Err(cleanup_error) = terminate_and_reap(&mut child, &terminator) {
                    eprintln!("Could not clean up PTY after writer setup failed: {cleanup_error}");
                }
                return Err(pty_error("Could not write to terminal", error));
            }
        };

        let session_id = format!("pty-{}", self.inner.next_id.fetch_add(1, Ordering::Relaxed));
        let session_state = Arc::new(PtySessionState {
            session_id: session_id.clone(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            terminator,
            closing: std::sync::atomic::AtomicBool::new(false),
            event_sink: sink,
            events: Mutex::new(BufferedEvents {
                attachment_id: None,
                latest_attachment_id: 0,
                completed: false,
                history: VecDeque::new(),
                output_bytes: 0,
                history_truncated: false,
            }),
        });
        match self.inner.sessions.lock() {
            Ok(mut sessions) => {
                let active_sessions = sessions
                    .values()
                    .filter(|session| !session.is_completed())
                    .count();
                if active_sessions >= MAX_SESSIONS {
                    drop(sessions);
                    return match terminate_and_reap(&mut child, &session_state.terminator) {
                        Ok(()) => Err(AppError::validation(format!(
                            "No more than {MAX_SESSIONS} terminal sessions can be active"
                        ))),
                        Err(error) => Err(error),
                    };
                }
                sessions.insert(session_id.clone(), Arc::clone(&session_state));
            }
            Err(_) => {
                if let Err(error) = terminate_and_reap(&mut child, &session_state.terminator) {
                    eprintln!("Could not stop PTY session after manager failure: {error}");
                }
                return Err(AppError::internal("PTY session manager is unavailable"));
            }
        }

        let weak_inner = Arc::downgrade(&self.inner);
        let thread_session_id = session_id.clone();
        let thread_session = Arc::clone(&session_state);
        let child_slot = Arc::new(Mutex::new(Some(child)));
        let thread_child = Arc::clone(&child_slot);
        let thread_result = thread::Builder::new()
            .name(format!("branchwork-{session_id}"))
            .spawn(move || {
                let child = thread_child
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take();
                if let Some(mut child) = child {
                    read_session_output(
                        reader,
                        &mut child,
                        thread_session_id,
                        thread_session,
                        weak_inner,
                    );
                }
            });
        if let Err(error) = thread_result {
            let session = self
                .inner
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&session_id);
            let child = child_slot
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            if let Some(mut child) = child {
                if let Some(session) = session.as_ref() {
                    if let Err(error) = terminate_and_reap(&mut child, &session.terminator) {
                        eprintln!(
                            "Could not stop PTY session after reader startup failure: {error}"
                        );
                    }
                } else if let Err(error) = terminate_child(&mut child) {
                    eprintln!("Could not stop PTY session after reader startup failure: {error}");
                }
            } else if let Some(session) = session
                && let Err(error) = session.terminator.terminate()
            {
                eprintln!("Could not stop PTY session after reader startup failure: {error}");
            }
            return Err(pty_error("Could not start terminal output reader", error));
        }

        Ok(PtySession { session_id })
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), AppError> {
        validate_session_id(session_id)?;
        if data.len() > MAX_INPUT_BYTES {
            return Err(AppError::validation(format!(
                "Terminal input must not exceed {MAX_INPUT_BYTES} bytes"
            )));
        }
        let session = self.session(session_id)?;
        if session.closing.load(Ordering::Acquire) || session.is_completed() {
            return Err(AppError::not_found("Terminal session was not found"));
        }
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| AppError::internal("PTY session writer is unavailable"))?;
        writer
            .write_all(data)
            .map_err(|error| pty_error("Could not write to terminal", error))
    }

    pub fn resize(&self, session_id: &str, columns: u16, rows: u16) -> Result<(), AppError> {
        validate_session_id(session_id)?;
        validate_dimensions(columns, rows)?;
        let session = self.session(session_id)?;
        if session.closing.load(Ordering::Acquire) || session.is_completed() {
            return Err(AppError::not_found("Terminal session was not found"));
        }
        let master = session
            .master
            .lock()
            .map_err(|_| AppError::internal("PTY session master is unavailable"))?;
        master
            .resize(pty_size(columns, rows))
            .map_err(|error| pty_error("Could not resize terminal", error))
    }

    pub fn attach(&self, session_id: &str, attachment_id: u64) -> Result<(), AppError> {
        validate_attachment_id(attachment_id)?;
        let session = self.session(session_id)?;
        session.attach(attachment_id);
        Ok(())
    }

    pub fn detach(&self, session_id: &str, attachment_id: u64) -> Result<(), AppError> {
        validate_attachment_id(attachment_id)?;
        self.session(session_id)?.detach(attachment_id);
        Ok(())
    }

    /// Stop a session the way the Agents screen closes a pane: ask the process
    /// group to exit (SIGINT; immediate terminate on Windows), wait up to
    /// `grace_ms` for the exit event, then force-close whatever is left.
    /// Returns true when the process exited on its own within the grace period.
    pub fn stop(&self, session_id: &str, grace_ms: u64) -> Result<bool, AppError> {
        let session = self.session(session_id)?;
        if session.is_completed() {
            self.close(session_id)?;
            return Ok(true);
        }
        session.terminator.interrupt()?;
        let grace = std::time::Duration::from_millis(grace_ms.min(30_000));
        let step = std::time::Duration::from_millis(20);
        let deadline = std::time::Instant::now() + grace;
        while std::time::Instant::now() < deadline {
            if session.is_completed() {
                self.close(session_id)?;
                return Ok(true);
            }
            std::thread::sleep(step);
        }
        let graceful = session.is_completed();
        self.close(session_id)?;
        Ok(graceful)
    }

    pub fn close(&self, session_id: &str) -> Result<(), AppError> {
        let session = self.session(session_id)?;
        if session.is_completed() {
            let mut sessions = self
                .inner
                .sessions
                .lock()
                .map_err(|_| AppError::internal("PTY session manager is unavailable"))?;
            if sessions
                .get(session_id)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                sessions.remove(session_id);
            }
            return Ok(());
        }
        session.closing.store(true, Ordering::Release);
        let kill_result = session.terminator.terminate();
        if let Err(error) = kill_result {
            session.closing.store(false, Ordering::Release);
            return Err(error);
        }
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| AppError::internal("PTY session manager is unavailable"))?;
        if sessions
            .get(session_id)
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            sessions.remove(session_id);
        }
        Ok(())
    }

    fn session(&self, session_id: &str) -> Result<Arc<PtySessionState>, AppError> {
        validate_session_id(session_id)?;
        self.inner
            .sessions
            .lock()
            .map_err(|_| AppError::internal("PTY session manager is unavailable"))?
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("Terminal session was not found"))
    }
}

fn read_session_output(
    mut reader: Box<dyn Read + Send>,
    child: &mut Box<dyn Child + Send + Sync>,
    session_id: String,
    session: Arc<PtySessionState>,
    inner: Weak<PtyManagerInner>,
) {
    let mut buffer = vec![0; OUTPUT_BUFFER_BYTES];
    let read_error = loop {
        match reader.read(&mut buffer) {
            Ok(0) => break None,
            Ok(length) => {
                session.emit(PtyEvent::Output(PtyOutput {
                    session_id: session_id.clone(),
                    data: buffer[..length].to_vec(),
                }));
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => break Some(error),
        }
    };

    if let Some(error) = read_error
        && session_is_active(&inner, &session_id)
    {
        session.emit(PtyEvent::Error(PtyErrorEvent {
            session_id: session_id.clone(),
            message: format!("Could not read terminal output: {error}"),
        }));
        if let Err(kill_error) = terminate_session(&inner, &session_id) {
            eprintln!("Could not stop PTY session {session_id} after output failure: {kill_error}");
        }
    }

    match child.wait() {
        Ok(status) => session.finish(PtyEvent::Exit(PtyExit {
            session_id: session_id.clone(),
            exit_code: status.signal().is_none().then(|| status.exit_code()),
            signal: status.signal().map(str::to_owned),
        })),
        Err(error) => session.finish(PtyEvent::Error(PtyErrorEvent {
            session_id: session_id.clone(),
            message: format!("Could not wait for terminal to exit: {error}"),
        })),
    }
}

fn session_is_active(inner: &Weak<PtyManagerInner>, session_id: &str) -> bool {
    let Some(inner) = inner.upgrade() else {
        return false;
    };
    match inner.sessions.lock() {
        Ok(sessions) => sessions
            .get(session_id)
            .is_some_and(|session| !session.closing.load(Ordering::Acquire)),
        Err(_) => true,
    }
}

fn terminate_session(inner: &Weak<PtyManagerInner>, session_id: &str) -> Result<(), AppError> {
    let inner = inner
        .upgrade()
        .ok_or_else(|| AppError::not_found("Terminal session was not found"))?;
    let session = inner
        .sessions
        .lock()
        .map_err(|_| AppError::internal("PTY session manager is unavailable"))?
        .get(session_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("Terminal session was not found"))?;
    session.terminator.terminate()
}

fn emit_event(app: &AppHandle, event: PtyEvent) {
    let result = match event {
        PtyEvent::Output(payload) => app.emit("pty:output", payload),
        PtyEvent::Exit(payload) => app.emit("pty:exit", payload),
        PtyEvent::Error(payload) => app.emit("pty:error", payload),
    };
    if let Err(error) = result {
        eprintln!("Could not emit PTY event: {error}");
    }
}

fn pty_size(columns: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols: columns,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Give interactive programs a usable terminal type in packaged builds, where
/// the app may not inherit the launching shell's environment. Explicit
/// per-session values are applied afterwards and can still override this.
fn apply_terminal_defaults(command: &mut CommandBuilder) {
    command.env("TERM", "xterm-256color");
}

fn validate_dimensions(columns: u16, rows: u16) -> Result<(), AppError> {
    if columns == 0 || columns > MAX_COLUMNS || rows == 0 || rows > MAX_ROWS {
        return Err(AppError::validation(format!(
            "Terminal dimensions must be between 1 and {MAX_COLUMNS} columns and 1 and {MAX_ROWS} rows"
        )));
    }
    Ok(())
}

fn validate_session_id(session_id: &str) -> Result<(), AppError> {
    let Some(suffix) = session_id.strip_prefix("pty-") else {
        return Err(AppError::validation("Invalid terminal session id"));
    };
    if suffix.is_empty() || suffix.len() > 20 || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AppError::validation("Invalid terminal session id"));
    }
    Ok(())
}

fn validate_attachment_id(attachment_id: u64) -> Result<(), AppError> {
    if attachment_id == 0 {
        return Err(AppError::validation("Invalid terminal attachment id"));
    }
    Ok(())
}

const MAX_SPAWN_ENV_VARS: usize = 64;
const MAX_SPAWN_ENV_KEY_LEN: usize = 128;
const MAX_SPAWN_ENV_VALUE_LEN: usize = 8192;

/// Keys are shell-name shaped (`CLAUDE_CONFIG_DIR`); values must not carry NUL.
pub fn validate_spawn_env(env: &std::collections::HashMap<String, String>) -> Result<(), AppError> {
    if env.len() > MAX_SPAWN_ENV_VARS {
        return Err(AppError::validation(
            "Too many terminal environment variables",
        ));
    }
    for (key, value) in env {
        let mut chars = key.chars();
        let valid_key = key.len() <= MAX_SPAWN_ENV_KEY_LEN
            && matches!(chars.next(), Some(first) if first.is_ascii_alphabetic() || first == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid_key {
            return Err(AppError::validation(
                "Terminal environment names must look like SHELL_VAR",
            ));
        }
        if value.len() > MAX_SPAWN_ENV_VALUE_LEN || value.contains('\0') {
            return Err(AppError::validation(
                "Terminal environment values must be short plain text",
            ));
        }
    }
    Ok(())
}

/// Validate and apply an isolated environment onto a PTY command.
pub fn apply_spawn_env(
    command: &mut CommandBuilder,
    env: &std::collections::HashMap<String, String>,
) -> Result<(), AppError> {
    validate_spawn_env(env)?;
    for (key, value) in env {
        command.env(key, value);
    }
    Ok(())
}

fn pty_error(message: &str, error: impl std::fmt::Display) -> AppError {
    let mut app_error = AppError::new(ErrorKind::PtySpawn, message);
    app_error.detail = Some(error.to_string());
    app_error
}

fn terminate_child(child: &mut Box<dyn Child + Send + Sync>) -> Result<(), AppError> {
    child
        .kill()
        .map_err(|error| pty_error("Could not stop terminal", error))?;
    child
        .wait()
        .map(|_| ())
        .map_err(|error| pty_error("Could not wait for terminal to stop", error))
}

fn terminate_and_reap(
    child: &mut Box<dyn Child + Send + Sync>,
    terminator: &SessionTerminator,
) -> Result<(), AppError> {
    terminator.terminate()?;
    child
        .wait()
        .map(|_| ())
        .map_err(|error| pty_error("Could not wait for terminal to stop", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dimensions_reject_zero_and_oversized_values() {
        assert!(validate_dimensions(80, 24).is_ok());
        assert!(validate_dimensions(0, 24).is_err());
        assert!(validate_dimensions(80, 0).is_err());
        assert!(validate_dimensions(MAX_COLUMNS + 1, 24).is_err());
        assert!(validate_dimensions(80, MAX_ROWS + 1).is_err());
    }

    #[test]
    fn session_ids_must_match_the_generated_format() {
        assert!(validate_session_id("pty-1").is_ok());
        assert!(validate_session_id("pty-").is_err());
        assert!(validate_session_id("pty-one").is_err());
        assert!(validate_session_id("../pty-1").is_err());
        assert!(validate_attachment_id(1).is_ok());
        assert!(validate_attachment_id(0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn output_is_session_scoped_and_sessions_support_io_resize_and_close() {
        use std::{ffi::OsStr, sync::mpsc, time::Duration};

        let manager = PtyManager::default();
        let (sender, receiver) = mpsc::channel();
        let sink = Arc::new(move |event| {
            sender.send(event).unwrap();
        });
        let mut command = CommandBuilder::new(OsStr::new("/bin/sh"));
        command.args(["-c", "read value; printf 'received:%s\\n' \"$value\""]);
        let session = manager
            .spawn_command(command, 80, 24, sink.clone())
            .unwrap();
        let mut second_command = CommandBuilder::new(OsStr::new("/bin/sh"));
        second_command.args(["-c", "read value; printf 'received:%s\\n' \"$value\""]);
        let second_session = manager.spawn_command(second_command, 80, 24, sink).unwrap();
        manager.attach(&session.session_id, 1).unwrap();
        manager.attach(&second_session.session_id, 1).unwrap();

        manager.write(&session.session_id, b"hello\n").unwrap();
        manager
            .write(&second_session.session_id, b"other\n")
            .unwrap();
        manager.resize(&session.session_id, 100, 30).unwrap();
        let mut outputs = HashMap::new();
        let mut exits = HashMap::new();
        for _ in 0..12 {
            if outputs.len() == 2 && exits.len() == 2 {
                break;
            }
            match receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                PtyEvent::Output(output) => {
                    outputs
                        .entry(output.session_id)
                        .or_insert_with(String::new)
                        .push_str(&String::from_utf8_lossy(&output.data));
                }
                PtyEvent::Exit(exit) => {
                    exits.insert(exit.session_id, exit.exit_code);
                }
                PtyEvent::Error(error) => panic!("{}", error.message),
            }
        }
        assert!(
            outputs
                .get(&session.session_id)
                .is_some_and(|output| output.contains("received:hello"))
        );
        assert!(
            outputs
                .get(&second_session.session_id)
                .is_some_and(|output| output.contains("received:other"))
        );
        assert_eq!(exits.get(&session.session_id), Some(&Some(0)));
        assert_eq!(exits.get(&second_session.session_id), Some(&Some(0)));
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            if manager.write(&session.session_id, b"again").is_err() {
                break;
            }
            std::thread::yield_now();
        }
        assert_eq!(
            manager
                .write(&session.session_id, b"again")
                .unwrap_err()
                .kind,
            ErrorKind::NotFound
        );
        assert!(manager.resize("pty-999", 80, 24).is_err());
        assert!(manager.close("pty-999").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn write_rejects_input_over_the_limit_and_close_releases_the_child() {
        use std::ffi::OsStr;

        let manager = PtyManager::default();
        let (sender, receiver) = std::sync::mpsc::channel();
        let sink = Arc::new(move |event| {
            sender.send(event).unwrap();
        });
        let mut command = CommandBuilder::new(OsStr::new("/bin/sh"));
        command.args(["-c", "read value"]);
        let session = manager.spawn_command(command, 80, 24, sink).unwrap();
        manager.attach(&session.session_id, 1).unwrap();

        assert_eq!(
            manager
                .write(&session.session_id, &vec![b'x'; MAX_INPUT_BYTES + 1])
                .unwrap_err()
                .kind,
            ErrorKind::Validation
        );
        manager.close(&session.session_id).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut exited = false;
        while !exited && std::time::Instant::now() < deadline {
            match receiver.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(PtyEvent::Exit(exit)) => {
                    assert_eq!(exit.session_id, session.session_id);
                    exited = true;
                }
                Ok(PtyEvent::Output(output)) => {
                    assert_eq!(output.session_id, session.session_id);
                }
                Ok(PtyEvent::Error(error)) => panic!("{}", error.message),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => panic!("PTY event channel failed: {error}"),
            }
        }
        assert!(exited, "PTY child did not exit after close");
        assert_eq!(
            manager.close(&session.session_id).unwrap_err().kind,
            ErrorKind::NotFound
        );
    }

    #[cfg(unix)]
    #[test]
    fn spawn_env_rejects_bad_names_values_and_counts() {
        use std::collections::HashMap;

        for key in ["", "a b", "a-b", "a.b", "9LIVES", "A;B", "A=B", "é"] {
            let env = HashMap::from([(key.to_string(), "v".to_string())]);
            assert!(
                validate_spawn_env(&env).is_err(),
                "{key:?} must be rejected"
            );
        }
        let nul = HashMap::from([("OK_VAR".to_string(), "a\0b".to_string())]);
        assert!(validate_spawn_env(&nul).is_err());
        let big = HashMap::from([("OK_VAR".to_string(), "x".repeat(9000))]);
        assert!(validate_spawn_env(&big).is_err());
        let many: HashMap<String, String> = (0..65)
            .map(|i| (format!("VAR_{i}"), "v".to_string()))
            .collect();
        assert!(validate_spawn_env(&many).is_err());

        let good = HashMap::from([
            ("CLAUDE_CONFIG_DIR".to_string(), "/tmp/x".to_string()),
            ("_A1".to_string(), String::new()),
        ]);
        assert!(validate_spawn_env(&good).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn applied_env_reaches_the_child() {
        use std::{collections::HashMap, ffi::OsStr, sync::mpsc, time::Duration};

        let manager = PtyManager::default();
        let (sender, receiver) = mpsc::channel();
        let sink = Arc::new(move |event| {
            sender.send(event).unwrap();
        });
        let mut command = CommandBuilder::new(OsStr::new("/bin/sh"));
        command.args([
            "-c",
            "clear; printf 'marker-%s:%s\\n' \"$BRANCHWORK_SPAWN_ENV_TEST\" \"$TERM\"; sleep 30",
        ]);
        let mut env = HashMap::new();
        env.insert("BRANCHWORK_SPAWN_ENV_TEST".to_string(), "yes42".to_string());
        apply_terminal_defaults(&mut command);
        apply_spawn_env(&mut command, &env).unwrap();
        let session = manager.spawn_command(command, 80, 24, sink).unwrap();
        manager.attach(&session.session_id, 1).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut seen = String::new();
        while std::time::Instant::now() < deadline && !seen.contains("marker-yes42:xterm-256color")
        {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(PtyEvent::Output(output)) => {
                    seen.push_str(&String::from_utf8_lossy(&output.data));
                }
                Ok(PtyEvent::Exit(_)) | Ok(PtyEvent::Error(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => panic!("PTY event channel failed: {error}"),
            }
        }
        assert!(
            seen.contains("marker-yes42:xterm-256color"),
            "child saw: {seen:?}"
        );
        assert!(
            !seen.contains("TERM environment variable not set"),
            "clear emitted a missing TERM warning: {seen:?}"
        );
        manager.close(&session.session_id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stop_asks_with_sigint_before_force_closing() {
        use std::{ffi::OsStr, sync::mpsc};

        let manager = PtyManager::default();
        let (sender, receiver) = mpsc::channel();
        let sink = Arc::new(move |event| {
            sender.send(event).unwrap();
        });
        let mut command = CommandBuilder::new(OsStr::new("/bin/sh"));
        command.args(["-c", "sleep 30"]);
        let session = manager.spawn_command(command, 80, 24, sink).unwrap();

        assert!(manager.stop(&session.session_id, 2_000).unwrap());
        assert_eq!(
            manager.close(&session.session_id).unwrap_err().kind,
            ErrorKind::NotFound
        );
        let _ = receiver;
    }

    #[cfg(unix)]
    #[test]
    fn stop_escalates_when_sigint_is_ignored() {
        use std::{ffi::OsStr, sync::mpsc, time::Duration};

        let manager = PtyManager::default();
        let (sender, receiver) = mpsc::channel();
        let sink = Arc::new(move |event| {
            sender.send(event).unwrap();
        });
        // Ignored dispositions are inherited, so `sleep` survives SIGINT too.
        // Wait for the script's first output so the interrupt cannot land on
        // the pre-exec child, which still has default dispositions.
        let mut command = CommandBuilder::new(OsStr::new("/bin/sh"));
        command.args(["-c", "printf ready; trap '' INT; sleep 30"]);
        let session = manager.spawn_command(command, 80, 24, sink).unwrap();
        manager.attach(&session.session_id, 1).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut ready = String::new();
        while std::time::Instant::now() < deadline && !ready.contains("ready") {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(PtyEvent::Output(output)) => {
                    ready.push_str(&String::from_utf8_lossy(&output.data));
                }
                Ok(PtyEvent::Exit(_)) | Ok(PtyEvent::Error(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => panic!("PTY event channel failed: {error}"),
            }
        }
        assert!(ready.contains("ready"), "child never started: {ready:?}");

        assert!(!manager.stop(&session.session_id, 200).unwrap());
        assert_eq!(
            manager.close(&session.session_id).unwrap_err().kind,
            ErrorKind::NotFound
        );
        let _ = receiver;
    }

    #[cfg(unix)]
    #[test]
    fn dropping_the_manager_stops_its_child() {
        use std::{ffi::OsStr, sync::mpsc, time::Duration};

        let (sender, receiver) = mpsc::channel();
        let session_id = {
            let manager = PtyManager::default();
            let sink = Arc::new(move |event| {
                sender.send(event).unwrap();
            });
            let mut command = CommandBuilder::new(OsStr::new("/bin/sh"));
            command.args(["-c", "sleep 30 & printf 'child-started\\n'; wait"]);
            let session = manager.spawn_command(command, 80, 24, sink).unwrap();
            manager.attach(&session.session_id, 1).unwrap();

            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let mut child_started = false;
            while !child_started && std::time::Instant::now() < deadline {
                match receiver.recv_timeout(Duration::from_millis(100)) {
                    Ok(PtyEvent::Output(output)) => {
                        assert_eq!(output.session_id, session.session_id);
                        child_started |=
                            String::from_utf8_lossy(&output.data).contains("child-started");
                    }
                    Ok(PtyEvent::Exit(_)) => panic!("shell exited before its child started"),
                    Ok(PtyEvent::Error(error)) => panic!("{}", error.message),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(error) => panic!("PTY event channel failed: {error}"),
                }
            }
            assert!(child_started, "shell did not start its child");
            session.session_id
        };

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut exited = false;
        while !exited && std::time::Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(PtyEvent::Exit(exit)) => {
                    assert_eq!(exit.session_id, session_id);
                    exited = true;
                }
                Ok(PtyEvent::Output(output)) => assert_eq!(output.session_id, session_id),
                Ok(PtyEvent::Error(error)) => panic!("{}", error.message),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => panic!("PTY event channel failed: {error}"),
            }
        }
        assert!(exited, "PTY process tree did not exit after manager drop");
    }

    #[cfg(unix)]
    #[test]
    fn closing_a_session_kills_descendants_and_unblocks_its_reader() {
        use std::{ffi::OsStr, sync::mpsc, time::Duration};

        let manager = PtyManager::default();
        let (sender, receiver) = mpsc::channel();
        let sink = Arc::new(move |event| {
            sender.send(event).unwrap();
        });
        let mut command = CommandBuilder::new(OsStr::new("/bin/sh"));
        command.args(["-c", "sleep 30 & printf 'child-started\\n'; wait"]);
        let session = manager.spawn_command(command, 80, 24, sink).unwrap();
        manager.attach(&session.session_id, 1).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut child_started = false;
        while !child_started && std::time::Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(PtyEvent::Output(output)) => {
                    assert_eq!(output.session_id, session.session_id);
                    child_started |=
                        String::from_utf8_lossy(&output.data).contains("child-started");
                }
                Ok(PtyEvent::Exit(_)) => panic!("shell exited before its child started"),
                Ok(PtyEvent::Error(error)) => panic!("{}", error.message),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => panic!("PTY event channel failed: {error}"),
            }
        }
        assert!(child_started, "shell did not start its child");

        manager.close(&session.session_id).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut exited = false;
        while !exited && std::time::Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(PtyEvent::Exit(exit)) => {
                    assert_eq!(exit.session_id, session.session_id);
                    exited = true;
                }
                Ok(PtyEvent::Output(output)) => {
                    assert_eq!(output.session_id, session.session_id);
                }
                Ok(PtyEvent::Error(error)) => panic!("{}", error.message),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => panic!("PTY event channel failed: {error}"),
            }
        }
        assert!(
            exited,
            "PTY process tree kept the reader blocked after close"
        );
    }

    #[cfg(unix)]
    #[test]
    fn manager_caps_concurrent_sessions_and_releases_closed_slots() {
        use std::ffi::OsStr;

        let manager = PtyManager::default();
        let sink = Arc::new(|_| {});
        let mut sessions = Vec::new();
        for _ in 0..MAX_SESSIONS {
            let mut command = CommandBuilder::new(OsStr::new("/bin/sh"));
            command.args(["-c", "read value"]);
            sessions.push(
                manager
                    .spawn_command(command, 80, 24, sink.clone())
                    .unwrap(),
            );
        }

        let mut excess_command = CommandBuilder::new(OsStr::new("/bin/sh"));
        excess_command.args(["-c", "read value"]);
        assert_eq!(
            manager
                .spawn_command(excess_command, 80, 24, sink)
                .unwrap_err()
                .kind,
            ErrorKind::Validation
        );
        manager.close(&sessions[0].session_id).unwrap();

        let mut command = CommandBuilder::new(OsStr::new("/bin/sh"));
        command.args(["-c", "read value"]);
        let replacement = manager
            .spawn_command(command, 80, 24, Arc::new(|_| {}))
            .unwrap();
        sessions.push(replacement);
        for session in sessions {
            let _ = manager.close(&session.session_id);
        }
    }

    #[cfg(unix)]
    #[test]
    fn attach_and_detach_preserve_output_until_the_view_is_ready() {
        use std::{ffi::OsStr, sync::mpsc, time::Duration};

        let manager = PtyManager::default();
        let (sender, receiver) = mpsc::channel();
        let sink = Arc::new(move |event| {
            sender.send(event).unwrap();
        });
        let mut command = CommandBuilder::new(OsStr::new("/bin/sh"));
        command.args([
            "-c",
            "sleep 0.1; printf 'before-attach\\n'; read value; printf 'while-detached\\n'; read value",
        ]);
        let session = manager.spawn_command(command, 80, 24, sink).unwrap();

        assert!(receiver.recv_timeout(Duration::from_millis(250)).is_err());
        manager.attach(&session.session_id, 1).unwrap();
        let first = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(matches!(
            first,
            PtyEvent::Output(output)
                if output.session_id == session.session_id
                    && String::from_utf8_lossy(&output.data).contains("before-attach")
        ));

        manager.detach(&session.session_id, 1).unwrap();
        manager.write(&session.session_id, b"ready\n").unwrap();
        assert!(receiver.recv_timeout(Duration::from_millis(250)).is_err());
        manager.attach(&session.session_id, 2).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut received_detached_output = false;
        while !received_detached_output && std::time::Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(PtyEvent::Output(output)) => {
                    received_detached_output = output.session_id == session.session_id
                        && String::from_utf8_lossy(&output.data).contains("while-detached");
                }
                Ok(PtyEvent::Exit(_)) => panic!("shell exited before the detached output arrived"),
                Ok(PtyEvent::Error(error)) => panic!("{}", error.message),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => panic!("PTY event channel failed: {error}"),
            }
        }
        assert!(received_detached_output, "detached output was not replayed");

        manager.close(&session.session_id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn completed_session_keeps_buffered_events_until_attached() {
        use std::{ffi::OsStr, sync::mpsc, time::Duration};

        let manager = PtyManager::default();
        let (sender, receiver) = mpsc::channel();
        let sink = Arc::new(move |event| {
            sender.send(event).unwrap();
        });
        let mut command = CommandBuilder::new(OsStr::new("/bin/sh"));
        command.args(["-c", "printf 'finished-before-attach\\n'; exit 7"]);
        let session = manager.spawn_command(command, 80, 24, sink).unwrap();
        let session_state = manager.session(&session.session_id).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !session_state.is_completed() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            session_state.is_completed(),
            "terminal process did not exit"
        );
        assert!(
            receiver.try_recv().is_err(),
            "detached output was emitted early"
        );

        manager.attach(&session.session_id, 1).unwrap();
        let mut saw_output = false;
        let mut saw_exit = false;
        while !saw_exit {
            match receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                PtyEvent::Output(output) => {
                    saw_output |= output.session_id == session.session_id
                        && String::from_utf8_lossy(&output.data).contains("finished-before-attach");
                }
                PtyEvent::Exit(exit) => {
                    assert_eq!(exit.session_id, session.session_id);
                    assert_eq!(exit.exit_code, Some(7));
                    saw_exit = true;
                }
                PtyEvent::Error(error) => panic!("{}", error.message),
            }
        }
        assert!(saw_output, "buffered output was not replayed");
        manager.detach(&session.session_id, 1).unwrap();
        manager.attach(&session.session_id, 2).unwrap();
        let mut replayed_output = false;
        let mut replayed_exit = false;
        while !replayed_exit {
            match receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                PtyEvent::Output(output) => {
                    replayed_output |= output.session_id == session.session_id
                        && String::from_utf8_lossy(&output.data).contains("finished-before-attach");
                }
                PtyEvent::Exit(exit) => {
                    assert_eq!(exit.session_id, session.session_id);
                    assert_eq!(exit.exit_code, Some(7));
                    replayed_exit = true;
                }
                PtyEvent::Error(error) => panic!("{}", error.message),
            }
        }
        assert!(
            replayed_output,
            "completed output was not replayed after reattach"
        );
        manager.close(&session.session_id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stale_view_attach_and_detach_cannot_replace_the_latest_attachment() {
        use std::{ffi::OsStr, sync::mpsc, time::Duration};

        let manager = PtyManager::default();
        let (sender, receiver) = mpsc::channel();
        let sink = Arc::new(move |event| {
            sender.send(event).unwrap();
        });
        let mut command = CommandBuilder::new(OsStr::new("/bin/sh"));
        command.args([
            "-c",
            "printf 'ready\\n'; read value; printf 'still-attached\\n'; read value",
        ]);
        let session = manager.spawn_command(command, 80, 24, sink).unwrap();

        manager.attach(&session.session_id, 20).unwrap();
        manager.attach(&session.session_id, 10).unwrap();
        manager.detach(&session.session_id, 10).unwrap();
        manager.write(&session.session_id, b"continue\n").unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut received_live_output = false;
        while !received_live_output && std::time::Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(PtyEvent::Output(output)) => {
                    received_live_output = output.session_id == session.session_id
                        && String::from_utf8_lossy(&output.data).contains("still-attached");
                }
                Ok(PtyEvent::Exit(_)) => panic!("shell exited before the live output"),
                Ok(PtyEvent::Error(error)) => panic!("{}", error.message),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => panic!("PTY event channel failed: {error}"),
            }
        }
        assert!(
            received_live_output,
            "stale view lifecycle changed the current attachment"
        );
        manager.close(&session.session_id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn interactive_shell_exit_delivers_an_exit_event() {
        use std::{sync::mpsc, time::Duration};

        let manager = PtyManager::default();
        let (sender, receiver) = mpsc::channel();
        let sink = Arc::new(move |event| {
            sender.send(event).unwrap();
        });
        // Same program production spawns: the user's default shell, interactive
        // on a PTY, so typing `exit` must end the session like in a terminal.
        let session = manager
            .spawn_command(CommandBuilder::new_default_prog(), 80, 24, sink)
            .unwrap();
        manager.attach(&session.session_id, 1).unwrap();
        // Let the shell print its prompt, then type `exit` like a user would.
        std::thread::sleep(Duration::from_secs(1));
        while receiver.try_recv().is_ok() {}
        manager.write(&session.session_id, b"exit\n").unwrap();

        let start = std::time::Instant::now();
        let budget = Duration::from_secs(15);
        let mut output = String::new();
        loop {
            if start.elapsed() > budget {
                panic!(
                    "timed out waiting for the exit event after typing `exit`; output so far: {output:?}"
                );
            }
            let wait = (budget - start.elapsed()).min(Duration::from_secs(5));
            match receiver.recv_timeout(wait) {
                Ok(PtyEvent::Output(event)) => {
                    output.push_str(&String::from_utf8_lossy(&event.data));
                }
                Ok(PtyEvent::Exit(exit)) => {
                    assert_eq!(exit.session_id, session.session_id);
                    break;
                }
                Ok(PtyEvent::Error(error)) => {
                    output.push_str(&format!("\n[pty error: {}]", error.message));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => panic!("PTY event channel failed: {error}"),
            }
        }
    }
}
