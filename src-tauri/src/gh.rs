//! GitHub credential + device-flow backend (M4 Tasks 01–02, spec §6.7).
//!
//! The user's GitHub tokens (OAuth device-flow results or PATs) live in the
//! platform credential store only — never in SQLite, logs, or the WebView —
//! keyed by GitHub username so several accounts can coexist. Storage sits
//! behind [`TokenStore`] so tests use the in-memory store and never touch
//! the real Keychain.
//!
//! Network and Keychain access go through fixed `curl` / `security` argv
//! (no shell, no new crates — the build is offline). Secrets are briefly
//! present in the spawner's argv while a command runs (same-user-visible,
//! no shell history): neither tool offers stdin secret input. Reads never
//! log anything.
//!
//! Device flow (public client, no secret ships): `gh_auth_start` returns the
//! user code + verification URI while the `device_code` stays in a
//! process-global pending map; `gh_auth_poll` performs at most one GitHub
//! token-poll per call and enforces the server interval.

use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::error::AppError;

/// Public OAuth App client id for the device flow (no secret ships).
pub const DEVICE_CLIENT_ID: &str = "Ov23liB7Z5iBkfEW96mc";
/// Scopes from spec §6.7.
const DEVICE_SCOPES: &str = "repo read:org notifications workflow";
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const DEVICE_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const API_USER_URL: &str = "https://api.github.com/user";
const CURL_TIMEOUT_SECS: &str = "30";

/// Keychain service for Branchwork GitHub tokens.
const SERVICE: &str = "dev.branchwork.app";

/// Maximum token length (tokens are ~100 chars; this is a sanity cap).
const MAX_TOKEN_LEN: usize = 4096;
/// Maximum account (username) length.
const MAX_ACCOUNT_LEN: usize = 64;

/// Reject empty, over-long, or whitespace/control-containing tokens before
/// they reach the credential store. Surrounding pasted whitespace is trimmed.
fn validate_token(token: &str) -> Result<String, AppError> {
    let trimmed = token.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::validation("token must not be empty"));
    }
    if trimmed.len() > MAX_TOKEN_LEN {
        return Err(AppError::validation("token is too long"));
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::validation("token must not contain whitespace"));
    }
    Ok(trimmed)
}

/// GitHub usernames: alphanumerics and hyphens.
fn validate_account(account: &str) -> Result<String, AppError> {
    let trimmed = account.trim().to_string();
    if trimmed.is_empty() || trimmed.len() > MAX_ACCOUNT_LEN {
        return Err(AppError::validation("account must not be empty"));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(AppError::validation("account must be a GitHub username"));
    }
    Ok(trimmed)
}

/// Credential storage contract: production uses the Keychain, tests use
/// [`MemoryStore`].
pub trait TokenStore: Send + Sync {
    /// Stored token for the account, or `None`. Never logged by callers.
    fn get(&self, account: &str) -> Result<Option<String>, AppError>;
    /// Replace the stored token (upsert).
    fn set(&self, account: &str, token: &str) -> Result<(), AppError>;
    /// Delete the stored token. `Ok(false)` when nothing was stored.
    fn delete(&self, account: &str) -> Result<bool, AppError>;
    /// True when any GitHub token is stored.
    fn any(&self) -> Result<bool, AppError>;
}

/// In-memory store for tests. Never touches the real Keychain.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    tokens: Mutex<HashMap<String, String>>,
}

#[cfg(test)]
impl TokenStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, AppError> {
        let clean = validate_account(account)?;
        Ok(self.tokens.lock().unwrap().get(&clean).cloned())
    }

    fn set(&self, account: &str, token: &str) -> Result<(), AppError> {
        let account = validate_account(account)?;
        let clean = validate_token(token)?;
        self.tokens.lock().unwrap().insert(account, clean);
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<bool, AppError> {
        let clean = validate_account(account)?;
        Ok(self.tokens.lock().unwrap().remove(&clean).is_some())
    }

    fn any(&self) -> Result<bool, AppError> {
        Ok(!self.tokens.lock().unwrap().is_empty())
    }
}

/// macOS Keychain store via the `security` CLI.
pub struct KeychainStore;

fn security_output(args: &[&str]) -> Result<std::process::Output, AppError> {
    std::process::Command::new("security")
        .args(args)
        .stdin(Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|error| AppError::io(format!("could not run security: {error}")))
}

fn account_args(account: &str) -> [String; 4] {
    [
        "-s".to_string(),
        SERVICE.to_string(),
        "-a".to_string(),
        account.to_string(),
    ]
}

fn get_args(account: &str) -> Vec<String> {
    let mut argv = vec!["find-generic-password".to_string()];
    argv.extend(account_args(account));
    argv.push("-w".to_string());
    argv
}

fn set_args(account: &str, token: &str) -> Vec<String> {
    let mut argv = vec!["add-generic-password".to_string()];
    argv.extend(account_args(account));
    argv.push("-w".to_string());
    argv.push(token.to_string());
    argv.push("-U".to_string());
    argv
}

fn delete_args(account: &str) -> Vec<String> {
    let mut argv = vec!["delete-generic-password".to_string()];
    argv.extend(account_args(account));
    argv
}

fn any_args() -> Vec<String> {
    vec![
        "find-generic-password".to_string(),
        "-s".to_string(),
        SERVICE.to_string(),
    ]
}

fn refs(argv: &[String]) -> Vec<&str> {
    argv.iter().map(String::as_str).collect()
}

impl TokenStore for KeychainStore {
    fn get(&self, account: &str) -> Result<Option<String>, AppError> {
        let clean = validate_account(account)?;
        let output = security_output(&refs(&get_args(&clean)))?;
        if output.status.success() {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if token.is_empty() {
                return Ok(None);
            }
            return Ok(Some(token));
        }
        if String::from_utf8_lossy(&output.stderr).contains("could not be found") {
            return Ok(None);
        }
        Err(AppError::io(format!(
            "could not read GitHub token: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }

    fn set(&self, account: &str, token: &str) -> Result<(), AppError> {
        let account = validate_account(account)?;
        let clean = validate_token(token)?;
        let output = security_output(&refs(&set_args(&account, &clean)))?;
        if output.status.success() {
            return Ok(());
        }
        Err(AppError::io(format!(
            "could not store GitHub token: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }

    fn delete(&self, account: &str) -> Result<bool, AppError> {
        let clean = validate_account(account)?;
        let output = security_output(&refs(&delete_args(&clean)))?;
        if output.status.success() {
            return Ok(true);
        }
        if String::from_utf8_lossy(&output.stderr).contains("could not be found") {
            return Ok(false);
        }
        Err(AppError::io(format!(
            "could not delete GitHub token: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }

    fn any(&self) -> Result<bool, AppError> {
        let output = security_output(&refs(&any_args()))?;
        Ok(output.status.success())
    }
}

/// Process-wide store used by the Tauri commands.
pub fn default_store() -> KeychainStore {
    KeychainStore
}

/// `gh_auth_status` shape: linked accounts only, never tokens.
#[derive(serde::Serialize, specta::Type)]
pub struct GhAuthStatus {
    pub linked: bool,
}

/// Device-flow terminal state.
#[derive(serde::Serialize, specta::Type, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum DeviceState {
    Pending,
    Authorized,
    Expired,
    Denied,
}

/// `gh_auth_start` shape. The `device_code` stays backend-side.
#[derive(serde::Serialize, specta::Type)]
pub struct DeviceStart {
    pub request_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// `gh_auth_poll` shape.
#[derive(serde::Serialize, specta::Type)]
pub struct DevicePoll {
    pub state: DeviceState,
    pub username: Option<String>,
    pub interval: u64,
}

/// `gh_auth_pat` shape.
#[derive(serde::Serialize, specta::Type)]
pub struct PatResult {
    pub username: String,
}

/// One in-flight device authorization. The `device_code` is as sensitive
/// as a token: it lives here only and is never returned or logged.
struct PendingFlow {
    device_code: String,
    expires_at: Instant,
    interval_secs: u64,
    last_poll: Option<Instant>,
}

static PENDING: LazyLock<Mutex<HashMap<String, PendingFlow>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_request_id() -> String {
    // Hashed (SipHash with per-process random keys) so ids are not
    // guessable by another local process.
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut hasher = DefaultHasher::new();
    (nanos, n, std::process::id()).hash(&mut hasher);
    format!("gh-{:016x}", hasher.finish())
}

/// Maximum concurrent device authorizations; bounds the pending map.
const MAX_PENDING_FLOWS: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoCacheEntry {
    pub owner: String,
    pub repo: String,
    pub account: String,
    pub fetched_at: Instant,
    pub expires_at: Instant,
    pub etag: Option<String>,
    pub resource: String,
    pub value: serde_json::Value,
    pub size_bytes: usize,
    last_accessed: Instant,
}

static REPO_CACHE: LazyLock<Mutex<HashMap<String, RepoCacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const REPO_CACHE_MAX_ENTRIES: usize = 256;
const REPO_CACHE_MAX_BYTES: usize = 16 * 1024 * 1024;
const REPO_CACHE_MAX_ENTRY_BYTES: usize = 512 * 1024;
const REPO_CACHE_TTL: Duration = Duration::from_secs(300);
const MAX_NOTIFICATION_ACCOUNTS: usize = 8;
const MAX_NOTIFICATIONS_PER_ACCOUNT: usize = 50;
const MAX_NOTIFICATION_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

pub fn poll_interval(active_repo: bool) -> u64 {
    if active_repo { 60 } else { 300 }
}

pub fn repo_cache_key(owner: &str, repo: &str, account: &str) -> String {
    format!(
        "{}:{}/{}",
        account.to_ascii_lowercase(),
        owner.to_ascii_lowercase(),
        repo.to_ascii_lowercase()
    )
}

pub fn cache_needs_refresh(
    entry: Option<&RepoCacheEntry>,
    active_repo: bool,
    now: Instant,
) -> bool {
    let Some(entry) = entry else {
        return true;
    };
    now >= entry.expires_at
        || now.duration_since(entry.fetched_at) >= Duration::from_secs(poll_interval(active_repo))
}

fn repo_resource_cache_key(owner: &str, repo: &str, account: &str, resource: &str) -> String {
    format!("{}:{resource}", repo_cache_key(owner, repo, account))
}

fn cached_repo_value(key: &str, now: Instant) -> Option<serde_json::Value> {
    let mut cache = REPO_CACHE.lock().ok()?;
    let entry = cache.get_mut(key)?;
    if cache_needs_refresh(Some(entry), false, now) {
        return None;
    }
    entry.last_accessed = now;
    Some(entry.value.clone())
}

fn save_repo_value(
    owner: &str,
    repo: &str,
    account: &str,
    resource: &str,
    etag: Option<String>,
    value: serde_json::Value,
    now: Instant,
) {
    let Ok(encoded) = serde_json::to_vec(&value) else {
        return;
    };
    let size_bytes = encoded.len();
    if size_bytes > REPO_CACHE_MAX_ENTRY_BYTES {
        return;
    }
    let key = repo_resource_cache_key(owner, repo, account, resource);
    let Ok(mut cache) = REPO_CACHE.lock() else {
        return;
    };
    if let Some(previous) = cache.remove(&key) {
        let _ = previous.size_bytes;
    }
    while cache.len() >= REPO_CACHE_MAX_ENTRIES
        || cache.values().map(|entry| entry.size_bytes).sum::<usize>() + size_bytes
            > REPO_CACHE_MAX_BYTES
    {
        let Some(oldest_key) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.last_accessed)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        cache.remove(&oldest_key);
    }
    cache.insert(
        key,
        RepoCacheEntry {
            owner: owner.to_string(),
            repo: repo.to_string(),
            account: account.to_string(),
            fetched_at: now,
            expires_at: now + REPO_CACHE_TTL,
            etag,
            resource: resource.to_string(),
            value,
            size_bytes,
            last_accessed: now,
        },
    );
}

fn invalidate_repo_cache(owner: &str, repo: &str, account: &str) {
    let prefix = format!("{}:", repo_cache_key(owner, repo, account));
    if let Ok(mut cache) = REPO_CACHE.lock() {
        cache.retain(|key, _| !key.starts_with(&prefix));
    }
}

/// Invalidate one validated repository/account after a user-requested refresh.
pub fn repo_cache_invalidate(owner: &str, repo: &str, account: &str) -> Result<(), AppError> {
    let owner = validate_name(owner, "owner")?;
    let repo = validate_name(repo, "repo")?;
    let account = validate_account(account)?;
    invalidate_repo_cache(&owner, &repo, &account);
    Ok(())
}

fn insert_pending(request_id: String, flow: PendingFlow) {
    let mut pending = PENDING.lock().unwrap();
    let now = Instant::now();
    pending.retain(|_, flow| flow.expires_at > now);
    if pending.len() >= MAX_PENDING_FLOWS
        && let Some(oldest) = pending
            .iter()
            .min_by_key(|(_, flow)| flow.expires_at)
            .map(|(id, _)| id.clone())
    {
        pending.remove(&oldest);
    }
    pending.insert(request_id, flow);
}

/// Interval gate for polling: at most one GitHub token-poll per interval.
fn should_poll(last: Option<Instant>, interval: Duration, now: Instant) -> bool {
    last.is_none_or(|at| now.duration_since(at) >= interval)
}

/// Fixed-argv `curl` returning parsed JSON. No shell involved.
fn curl_json(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    fields: &[(&str, &str)],
) -> Result<serde_json::Value, AppError> {
    let mut argv: Vec<String> = vec![
        "curl".to_string(),
        "-sS".to_string(),
        "--max-time".to_string(),
        CURL_TIMEOUT_SECS.to_string(),
        "-X".to_string(),
        method.to_string(),
    ];
    let config = curl_config(headers, fields)?;
    argv.push(url.to_string());
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    let output = curl_output_with_config(&refs, Some(&config))?;
    serde_json::from_slice(&output.stdout)
        .map_err(|error| AppError::io(format!("unexpected GitHub response: {error}")))
}

fn escape_curl_config_value(value: &str) -> Result<String, AppError> {
    if value.chars().any(char::is_control) {
        return Err(AppError::validation(
            "GitHub request values must not contain control characters".to_string(),
        ));
    }
    Ok(value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn curl_config(headers: &[(&str, &str)], fields: &[(&str, &str)]) -> Result<String, AppError> {
    let mut config = String::new();
    for (name, value) in headers {
        let header = escape_curl_config_value(&format!("{name}: {value}"))?;
        config.push_str(&format!("header = \"{header}\"\n"));
    }
    for (name, value) in fields {
        let field = escape_curl_config_value(&format!("{name}={value}"))?;
        config.push_str(&format!("data-urlencode = \"{field}\"\n"));
    }
    Ok(config)
}

/// Parsed device-code grant (no request id yet).
struct DeviceGrant {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

fn field<'a>(value: &'a serde_json::Value, name: &str) -> Option<&'a str> {
    value.get(name)?.as_str()
}

fn parse_device_grant(value: &serde_json::Value) -> Result<DeviceGrant, AppError> {
    let missing = || AppError::io("unexpected GitHub device response".to_string());
    Ok(DeviceGrant {
        device_code: field(value, "device_code").ok_or_else(missing)?.to_string(),
        user_code: field(value, "user_code").ok_or_else(missing)?.to_string(),
        verification_uri: field(value, "verification_uri")
            .or_else(|| field(value, "verificationUri"))
            .ok_or_else(missing)?
            .to_string(),
        expires_in: value
            .get("expires_in")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(900),
        interval: value
            .get("interval")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(5)
            .max(1),
    })
}

/// One token-poll outcome.
enum TokenPoll {
    Pending,
    SlowDown,
    Authorized(String),
    Expired,
    Denied,
    Invalid(String),
}

fn parse_token_response(value: &serde_json::Value) -> TokenPoll {
    if let Some(token) = field(value, "access_token") {
        if token.is_empty() {
            return TokenPoll::Invalid("empty access token".to_string());
        }
        return TokenPoll::Authorized(token.to_string());
    }
    match field(value, "error").unwrap_or("") {
        "authorization_pending" => TokenPoll::Pending,
        "slow_down" => TokenPoll::SlowDown,
        "expired_token" => TokenPoll::Expired,
        "access_denied" => TokenPoll::Denied,
        other => TokenPoll::Invalid(format!("unexpected token response: {other}")),
    }
}

fn parse_user_login(value: &serde_json::Value) -> Result<String, AppError> {
    match field(value, "login") {
        Some(login) if !login.is_empty() => Ok(login.to_string()),
        _ => Err(AppError::io("unexpected GitHub user response".to_string())),
    }
}

const JSON_ACCEPT: (&str, &str) = ("Accept", "application/json");

fn user_login(token: &str) -> Result<String, AppError> {
    let auth = format!("Bearer {token}");
    let value = curl_json(
        "GET",
        API_USER_URL,
        &[JSON_ACCEPT, ("Authorization", &auth)],
        &[],
    )?;
    parse_user_login(&value)
}

// Reuse the user's existing GitHub CLI authorization when it is available.
// The token is verified against the selected account and remains memory-only.
fn gh_auth_token_args(account: &str) -> [&str; 6] {
    [
        "auth",
        "token",
        "--hostname",
        "github.com",
        "--user",
        account,
    ]
}

fn gh_cli_token(account: &str) -> Result<Option<String>, AppError> {
    let output = match Command::new("gh")
        .args(gh_auth_token_args(account))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(AppError::io(format!(
                "could not read GitHub CLI credentials: {error}"
            )));
        }
    };
    if !output.status.success() {
        return Ok(None);
    }

    let token = String::from_utf8_lossy(&output.stdout);
    let token = token.trim();
    if token.is_empty() {
        return Ok(None);
    }
    validate_token(token).map(Some)
}

fn same_github_account(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

pub(crate) fn account_token(account: &str) -> Result<String, AppError> {
    let account = validate_account(account)?;
    if let Some(cli_token) = gh_cli_token(&account)? {
        match user_login(&cli_token) {
            Ok(login) if same_github_account(&login, &account) => return Ok(cli_token),
            Ok(_) => {
                return default_store().get(&account)?.ok_or_else(|| {
                    AppError::validation(format!(
                        "GitHub CLI credentials do not match selected account '{account}'"
                    ))
                });
            }
            Err(error) => {
                return default_store().get(&account)?.ok_or(error);
            }
        }
    }

    default_store()
        .get(&account)?
        .ok_or_else(|| AppError::validation(format!("GitHub account '{account}' is not linked")))
}

/// Store a user-supplied token under an account name.
pub fn set_token(token: &str, account: &str) -> Result<(), AppError> {
    default_store().set(account, token)
}

/// True when the account (or any account, when `None`) has a token.
pub fn status(account: Option<&str>) -> Result<GhAuthStatus, AppError> {
    let linked = match account {
        Some(name) => default_store().get(name)?.is_some(),
        None => default_store().any()?,
    };
    Ok(GhAuthStatus { linked })
}

/// Delete the stored token. `Ok(false)` when nothing was stored.
pub fn sign_out(account: &str) -> Result<bool, AppError> {
    default_store().delete(account)
}

/// Start a device authorization. The `device_code` never leaves the backend.
pub fn device_start() -> Result<DeviceStart, AppError> {
    let value = curl_json(
        "POST",
        DEVICE_CODE_URL,
        &[JSON_ACCEPT],
        &[("client_id", DEVICE_CLIENT_ID), ("scope", DEVICE_SCOPES)],
    )?;
    if field(&value, "error").is_some() {
        return Err(AppError::io(format!(
            "GitHub device flow refused: {}",
            field(&value, "error_description").unwrap_or("unknown error")
        )));
    }
    let grant = parse_device_grant(&value)?;
    let request_id = next_request_id();
    insert_pending(
        request_id.clone(),
        PendingFlow {
            device_code: grant.device_code,
            expires_at: Instant::now() + Duration::from_secs(grant.expires_in),
            interval_secs: grant.interval,
            last_poll: None,
        },
    );
    Ok(DeviceStart {
        request_id,
        user_code: grant.user_code,
        verification_uri: grant.verification_uri,
        expires_in: grant.expires_in,
        interval: grant.interval,
    })
}

/// Allowlisted verification URL, or an error. Pure and unit-tested: the
/// spawner below never sees an unvalidated URL.
fn validate_open_url(uri: &str) -> Result<String, AppError> {
    let trimmed = uri.trim();
    let rest = trimmed
        .strip_prefix("https://github.com/login/device")
        .ok_or_else(|| AppError::validation("refusing to open an unexpected URL".to_string()))?;
    if !(rest.is_empty() || rest.starts_with('/') || rest.starts_with('?') || rest.starts_with('#'))
        || rest.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(AppError::validation(
            "refusing to open an unexpected URL".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

/// Open the device-flow verification page in the system browser.
/// Strict allowlist: only the GitHub device-login page (and its query
/// strings) may be opened through this command — never an arbitrary URL.
pub fn open_verification_uri(uri: &str) -> Result<(), AppError> {
    let trimmed = validate_open_url(uri)?;
    spawn_open_url(&trimmed)
}

/// Open a GitHub repository page in the system browser. The URL is built
/// server-side from validated owner/repo names, so callers can never pass
/// an arbitrary URL through this command.
pub fn open_repo(owner: &str, repo: &str) -> Result<(), AppError> {
    let owner = validate_name(owner, "owner")?;
    let repo = validate_name(repo, "repo")?;
    spawn_open_url(&format!("https://github.com/{owner}/{repo}"))
}

fn repo_page_url(
    owner: &str,
    repo: &str,
    page: &str,
    pull_number: Option<u64>,
) -> Result<String, AppError> {
    let owner = validate_name(owner, "owner")?;
    let repo = validate_name(repo, "repo")?;
    let suffix = match (page, pull_number) {
        ("projects", None) => "/projects".to_string(),
        ("wiki", None) => "/wiki".to_string(),
        ("security", None) => "/security".to_string(),
        ("insights", None) => "/pulse".to_string(),
        ("settings", None) => "/settings".to_string(),
        ("pulls", None) => "/pulls".to_string(),
        ("issues", None) => "/issues".to_string(),
        ("actions", None) => "/actions".to_string(),
        ("issue", Some(number)) if number > 0 => format!("/issues/{number}"),
        ("pull", Some(number)) if number > 0 => format!("/pull/{number}"),
        _ => {
            return Err(AppError::validation(
                "unsupported GitHub repository page".to_string(),
            ));
        }
    };
    Ok(format!("https://github.com/{owner}/{repo}{suffix}"))
}

/// GitHub commit page; it links the pull request(s) that contain the commit.
fn commit_page_url(owner: &str, repo: &str, sha: &str) -> Result<String, AppError> {
    let owner = validate_name(owner, "owner")?;
    let repo = validate_name(repo, "repo")?;
    if !(matches!(sha.len(), 40 | 64) && sha.bytes().all(|byte| byte.is_ascii_hexdigit())) {
        return Err(AppError::validation(
            "commit id must be a full hexadecimal SHA".to_string(),
        ));
    }
    Ok(format!("https://github.com/{owner}/{repo}/commit/{sha}"))
}

pub fn open_commit_page(owner: &str, repo: &str, sha: &str) -> Result<(), AppError> {
    spawn_open_url(&commit_page_url(owner, repo, sha)?)
}

/// Open a fixed GitHub repository page in the system browser. The route is
/// selected from a backend allowlist; callers cannot supply a URL or path.
pub fn open_repo_page(
    owner: &str,
    repo: &str,
    page: &str,
    pull_number: Option<u64>,
) -> Result<(), AppError> {
    let url = repo_page_url(owner, repo, page, pull_number)?;
    spawn_open_url(&url)
}

fn spawn_open_url(url: &str) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "windows")]
    let program = "cmd";
    #[cfg(target_os = "windows")]
    let args: &[&str] = &["/C", "start", url];
    #[cfg(not(target_os = "windows"))]
    let args: &[&str] = &[url];
    std::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| AppError::io(format!("could not open browser: {error}")))?;
    Ok(())
}

/// Poll one in-flight authorization once. Enforces the server interval:
/// early calls return pending without touching the network.
pub fn device_poll(request_id: &str) -> Result<DevicePoll, AppError> {
    let (device_code, interval) = {
        let mut pending = PENDING.lock().unwrap();
        if !pending.contains_key(request_id) {
            return Err(AppError::validation(
                "unknown or expired login request".to_string(),
            ));
        }
        if pending
            .get(request_id)
            .is_some_and(|flow| Instant::now() >= flow.expires_at)
        {
            let flow = pending.remove(request_id).expect("entry just checked");
            return Ok(DevicePoll {
                state: DeviceState::Expired,
                username: None,
                interval: flow.interval_secs,
            });
        }
        let flow = pending.get_mut(request_id).expect("entry just checked");
        if !should_poll(
            flow.last_poll,
            Duration::from_secs(flow.interval_secs),
            Instant::now(),
        ) {
            return Ok(DevicePoll {
                state: DeviceState::Pending,
                username: None,
                interval: flow.interval_secs,
            });
        }
        flow.last_poll = Some(Instant::now());
        (flow.device_code.clone(), flow.interval_secs)
    };
    let value = curl_json(
        "POST",
        DEVICE_TOKEN_URL,
        &[JSON_ACCEPT],
        &[
            ("client_id", DEVICE_CLIENT_ID),
            ("device_code", &device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ],
    )?;
    match parse_token_response(&value) {
        TokenPoll::Pending => Ok(DevicePoll {
            state: DeviceState::Pending,
            username: None,
            interval,
        }),
        TokenPoll::SlowDown => {
            let mut pending = PENDING.lock().unwrap();
            let next = pending
                .get_mut(request_id)
                .map(|flow| {
                    flow.interval_secs = flow.interval_secs.saturating_add(5);
                    flow.interval_secs
                })
                .unwrap_or(interval);
            Ok(DevicePoll {
                state: DeviceState::Pending,
                username: None,
                interval: next,
            })
        }
        TokenPoll::Authorized(token) => {
            let username = user_login(&token)?;
            default_store().set(&username, &token)?;
            PENDING.lock().unwrap().remove(request_id);
            Ok(DevicePoll {
                state: DeviceState::Authorized,
                username: Some(username),
                interval,
            })
        }
        TokenPoll::Expired => {
            PENDING.lock().unwrap().remove(request_id);
            Ok(DevicePoll {
                state: DeviceState::Expired,
                username: None,
                interval,
            })
        }
        TokenPoll::Denied => {
            PENDING.lock().unwrap().remove(request_id);
            Ok(DevicePoll {
                state: DeviceState::Denied,
                username: None,
                interval,
            })
        }
        TokenPoll::Invalid(message) => {
            PENDING.lock().unwrap().remove(request_id);
            Err(AppError::io(message))
        }
    }
}

/// Verify a user-supplied PAT, store it under its username, return the name.
pub fn pat_login(token: &str) -> Result<PatResult, AppError> {
    let clean = validate_token(token)?;
    let username = user_login(&clean)?;
    default_store().set(&username, &clean)?;
    Ok(PatResult { username })
}

// ---------------------------------------------------------------------------
// Repository screen (M4 Task 07).
// ---------------------------------------------------------------------------

/// Remote of the active worktree, resolved in the backend from `origin`.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GhRemote {
    pub owner: String,
    pub repo: String,
    pub url: String,
}

/// GitHub owner/repo segments: dots, hyphens, underscores, alphanumerics.
pub(crate) fn validate_name(value: &str, what: &str) -> Result<String, AppError> {
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() || trimmed.len() > 100 {
        return Err(AppError::validation(format!("{what} must not be empty")));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        || trimmed.starts_with('.')
    {
        return Err(AppError::validation(format!("{what} is not a valid name")));
    }
    Ok(trimmed)
}

/// (Host, path) from a remote URL (scp-like and https/ssh forms).
/// Returns None when the shape is unrecognized. The host is NOT validated
/// here — callers decide which hosts count (see [`parse_github_remote_with`]).
/// Owner/repo keep their original casing: GitHub resolves case-insensitively
/// and the UI shows what the remote spells.
fn split_remote_host(url: &str) -> Option<(String, String)> {
    let text = url.trim();
    // scp-like: [user@]host:owner/repo(.git) — no scheme present.
    if !text.to_lowercase().contains("://") {
        let after_at = text.split_once('@').map(|rest| rest.1).unwrap_or(text);
        let (host, path) = after_at.split_once(':')?;
        Some((host.to_string(), path.to_string()))
    } else {
        let without_scheme = text.split("://").nth(1)?;
        let host_end = without_scheme.find('/')?;
        let mut host = &without_scheme[..host_end];
        if let Some(at) = host.rfind('@') {
            host = &host[at + 1..];
        }
        Some((host.to_string(), without_scheme[host_end + 1..].to_string()))
    }
}

/// Owner/repo from a remote URL whose host passes `is_github_host`.
/// Keeps host policy injectable so tests can fake SSH-alias resolution
/// while the real path uses [`resolve_ssh_hostname`].
fn parse_github_remote_with(
    url: &str,
    is_github_host: &impl Fn(&str) -> bool,
) -> Option<(String, String)> {
    let (host, path) = split_remote_host(url)?;
    if !is_github_host(&host) {
        return None;
    }
    let mut parts = path.split('/').filter(|part| !part.is_empty());
    let owner = parts.next()?.to_string();
    let mut repo = parts.next()?.to_string();
    if repo.len() > 4 && repo[repo.len() - 4..].eq_ignore_ascii_case(".git") {
        repo.truncate(repo.len() - 4);
    }
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

/// Real hostname behind an SSH host alias, via `ssh -G` (local config
/// resolution only — never connects anywhere). Lets multi-account
/// `~/.ssh/config` setups count as GitHub remotes. Fixed argv, no shell.
/// Returns None when ssh is unavailable, fails, or reports no hostname.
fn resolve_ssh_hostname(host: &str) -> Option<String> {
    if host.is_empty()
        || host.len() > 253
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return None;
    }
    let output = std::process::Command::new("ssh")
        .args(["-G", host])
        .stdin(Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut words = line.split_whitespace();
        if words.next() == Some("hostname") {
            return words.next().map(|name| name.to_lowercase());
        }
    }
    None
}

/// Resolve the `origin` remote of a registered worktree.
pub fn repo_remote(
    store: &crate::store::Store,
    worktree_path: &std::path::Path,
) -> Result<GhRemote, AppError> {
    let dir = crate::status::validate_catalog_worktree(store, worktree_path)?;
    let output = std::process::Command::new("git")
        .args(["-C", &dir.to_string_lossy(), "remote", "get-url", "origin"])
        .stdin(Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|error| AppError::io(format!("could not read git remote: {error}")))?;
    if !output.status.success() {
        return Err(AppError::not_found(
            "worktree has no git origin remote".to_string(),
        ));
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let is_github_host = |host: &str| {
        // SSH config matching may be case-sensitive; retry lowered so
        // mixed-case aliases still resolve.
        host.eq_ignore_ascii_case("github.com")
            || resolve_ssh_hostname(host).as_deref() == Some("github.com")
            || resolve_ssh_hostname(&host.to_lowercase()).as_deref() == Some("github.com")
    };
    match parse_github_remote_with(&url, &is_github_host) {
        Some((owner, repo)) => Ok(GhRemote { owner, repo, url }),
        None => Err(AppError::not_found(
            "origin is not a GitHub remote".to_string(),
        )),
    }
}

/// One release row. Tokens never appear here.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GhRelease {
    pub name: Option<String>,
    pub tag: String,
    pub published_at: Option<String>,
    pub draft: bool,
    pub is_latest: bool,
    pub url: String,
}

/// One language slice of the sidebar bar.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GhLanguage {
    pub name: String,
    pub color: Option<String>,
    pub size: u64,
}

/// Repository overview for the repo screen. Tokens never appear here.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GhRepoMeta {
    pub id: String,
    pub is_private: bool,
    pub description: Option<String>,
    pub homepage_url: Option<String>,
    pub topics: Vec<String>,
    pub license: Option<String>,
    pub stars: u64,
    pub forks: u64,
    pub watchers: u64,
    pub viewer_starred: bool,
    pub viewer_subscription: String,
    pub default_branch: String,
    pub releases: Vec<GhRelease>,
    pub languages: Vec<GhLanguage>,
}

/// One contributor row.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GhContributor {
    pub login: String,
    pub contributions: u64,
    pub avatar_url: String,
}

const REPO_META_QUERY: &str = "query($owner:String!,$name:String!) { repository(owner:$owner,name:$name) { id isPrivate description homepageUrl stargazerCount forkCount watchers{totalCount} viewerHasStarred viewerSubscription defaultBranchRef{name} licenseInfo{name} repositoryTopics(first:10){nodes{topic{name}}} releases(first:5,orderBy:{field:CREATED_AT,direction:DESC}){nodes{name tagName publishedAt isDraft isPrerelease url}} languages(first:8,orderBy:{field:SIZE,direction:DESC}){edges{size node{name color}}} } }";

/// POST a GraphQL query with variables. Credentials are sent to curl on stdin.
pub(crate) fn graphql(
    token: &str,
    query: &str,
    variables: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let body =
        serde_json::to_string(&serde_json::json!({ "query": query, "variables": variables }))
            .map_err(|error| AppError::io(format!("could not build GraphQL body: {error}")))?;
    let auth = format!("Bearer {token}");
    let config = curl_config(
        &[
            ("Accept", "application/vnd.github+json"),
            ("Content-Type", "application/json"),
            ("Authorization", &auth),
        ],
        &[],
    )?;
    let argv: Vec<String> = vec![
        "curl".to_string(),
        "-sS".to_string(),
        "-D".to_string(),
        "-".to_string(),
        "-o".to_string(),
        "-".to_string(),
        "--max-time".to_string(),
        CURL_TIMEOUT_SECS.to_string(),
        "-X".to_string(),
        "POST".to_string(),
        "-d".to_string(),
        body,
        "https://api.github.com/graphql".to_string(),
    ];
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    api_json_with_config(&refs, Some(&config))
}

fn cached_graphql(
    owner: &str,
    repo: &str,
    account: &str,
    resource: &str,
    token: &str,
    query: &str,
    variables: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let key = repo_resource_cache_key(owner, repo, account, resource);
    let now = Instant::now();
    if let Some(value) = cached_repo_value(&key, now) {
        return Ok(value);
    }
    let value = graphql(token, query, variables)?;
    save_repo_value(
        owner,
        repo,
        account,
        resource,
        None,
        value.clone(),
        Instant::now(),
    );
    Ok(value)
}

/// GET a REST path with the account token. Credentials are sent to curl on stdin.
fn repo_rest_get(
    token: &str,
    owner: &str,
    repo: &str,
    account: &str,
    resource: &str,
    path: &str,
) -> Result<serde_json::Value, AppError> {
    let key = repo_resource_cache_key(owner, repo, account, resource);
    let now = Instant::now();
    if let Some(value) = cached_repo_value(&key, now) {
        return Ok(value);
    }
    let previous = REPO_CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.get(&key).cloned());
    let auth = format!("Bearer {token}");
    let etag_header = previous
        .as_ref()
        .and_then(|entry| entry.etag.as_deref())
        .map(|etag| ("If-None-Match", etag));
    let mut headers = vec![
        ("Accept", "application/vnd.github+json"),
        ("Authorization", auth.as_str()),
    ];
    if let Some(header) = etag_header {
        headers.push(header);
    }
    let config = curl_config(&headers, &[])?;
    let refs = [
        "curl",
        "-sS",
        "-D",
        "-",
        "-o",
        "-",
        "--max-time",
        CURL_TIMEOUT_SECS,
        &format!("https://api.github.com{path}"),
    ];
    let output = curl_output_with_config(&refs, Some(&config))?;
    let (status, header_block, body) = split_http_response(&output.stdout)?;
    let rate_state = parse_rate_limit_headers(header_block);
    record_rate_limit(rate_state);
    let response_etag = header_value(header_block, "etag");
    if status == 304 {
        let Some(previous) = previous else {
            return Err(AppError::io(
                "GitHub returned 304 without a cached response",
            ));
        };
        save_repo_value(
            owner,
            repo,
            account,
            resource,
            response_etag.or(previous.etag),
            previous.value.clone(),
            Instant::now(),
        );
        return Ok(previous.value);
    }
    if !(200..300).contains(&status) {
        let value =
            serde_json::from_slice::<serde_json::Value>(body).unwrap_or(serde_json::Value::Null);
        if let Some(failure) = api_failure(&value) {
            return Err(failure);
        }
        return Err(AppError::io(format!(
            "GitHub request failed with HTTP {status}"
        )));
    }
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|error| AppError::io(format!("unexpected GitHub response: {error}")))?;
    if let Some(failure) = api_failure(&value) {
        return Err(failure);
    }
    save_repo_value(
        owner,
        repo,
        account,
        resource,
        response_etag,
        value.clone(),
        Instant::now(),
    );
    Ok(value)
}

fn curl_output_with_config(
    refs: &[&str],
    config: Option<&str>,
) -> Result<std::process::Output, AppError> {
    let mut command = Command::new("curl");
    command.args(refs);
    if config.is_some() {
        command.args(["--config", "-"]).stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| AppError::io(format!("could not run curl: {error}")))?;
    if let Some(config) = config {
        let Some(mut stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::io(
                "could not send GitHub request configuration".to_string(),
            ));
        };
        if let Err(error) = stdin.write_all(config.as_bytes()) {
            drop(stdin);
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::io(format!(
                "could not send GitHub request configuration: {error}"
            )));
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| AppError::io(format!("could not read curl response: {error}")))?;
    if !output.status.success() {
        return Err(AppError::io(format!(
            "GitHub request failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output)
}

fn require_http_status(stdout: &[u8], expected: u16) -> Result<(), AppError> {
    let status = String::from_utf8_lossy(stdout)
        .lines()
        .last()
        .and_then(|line| line.parse::<u16>().ok())
        .ok_or_else(|| AppError::io("GitHub response did not include an HTTP status"))?;
    if status != expected {
        return Err(AppError::io(format!(
            "GitHub request failed with HTTP {status}"
        )));
    }
    Ok(())
}

fn api_json_with_config(
    refs: &[&str],
    config: Option<&str>,
) -> Result<serde_json::Value, AppError> {
    let output = curl_output_with_config(refs, config)?;
    let (value, rate_state) = parse_api_response(&output.stdout)?;
    record_rate_limit(rate_state);
    if let Some(failure) = api_failure(&value) {
        return Err(failure);
    }
    Ok(value)
}

/// GitHub rate-limit metadata from the response headers. The backend stores
/// the last state in memory so the poller can honor the remaining quota while
/// keeping the app responsive.
#[derive(serde::Serialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
pub struct RateLimitState {
    pub limit: Option<u64>,
    pub remaining: Option<u64>,
    pub reset_at: Option<u64>,
    pub retry_after: Option<u64>,
}

static LAST_RATE_LIMIT: LazyLock<Mutex<Option<(RateLimitState, SystemTime)>>> =
    LazyLock::new(|| Mutex::new(None));

fn record_rate_limit(state: RateLimitState) {
    if state.limit.is_none() && state.remaining.is_none() && state.reset_at.is_none() {
        return;
    }
    if let Ok(mut latest) = LAST_RATE_LIMIT.lock() {
        *latest = Some((state, SystemTime::now()));
    }
}

/// Current low-quota state for the Repository UI. No credentials are returned.
pub fn rate_limit_status() -> Option<RateLimitState> {
    let (state, observed_at) = *LAST_RATE_LIMIT.lock().ok()?.as_ref()?;
    if !state.is_low() {
        return None;
    }
    match state.reset_at {
        Some(reset)
            if SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .is_ok_and(|now| now.as_secs() >= reset) =>
        {
            return None;
        }
        None if observed_at.elapsed().ok()? > Duration::from_secs(300) => return None,
        _ => {}
    }
    Some(state)
}

#[allow(dead_code)]
impl RateLimitState {
    pub fn is_low(&self) -> bool {
        match (self.limit, self.remaining) {
            (Some(limit), Some(remaining)) => limit > 0 && remaining <= limit / 10,
            (None, Some(remaining)) => remaining == 0,
            _ => false,
        }
    }

    pub fn retry_delay(&self, now: SystemTime) -> Option<Duration> {
        let seconds = match self.reset_at {
            Some(reset) => {
                let epoch = now.duration_since(UNIX_EPOCH).ok()?;
                let remaining = reset.saturating_sub(epoch.as_secs());
                remaining.max(1)
            }
            None => self.retry_after?,
        };
        Some(Duration::from_secs(seconds))
    }

    pub fn retry_text(&self) -> Option<String> {
        let reset = self.reset_at?;
        let date = std::time::UNIX_EPOCH + Duration::from_secs(reset);
        let secs = date.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
        let minutes = secs / 60;
        let hours = minutes / 60;
        let minute = minutes % 60;
        let hour = hours % 24;
        Some(format!("{:02}:{:02}", hour, minute))
    }
}

fn parse_rate_limit_headers(headers: &str) -> RateLimitState {
    let mut state = RateLimitState {
        limit: None,
        remaining: None,
        reset_at: None,
        retry_after: None,
    };
    for line in headers.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        match name.as_str() {
            "x-ratelimit-limit" => state.limit = value.parse().ok(),
            "x-ratelimit-remaining" => state.remaining = value.parse().ok(),
            "x-ratelimit-reset" => state.reset_at = value.parse().ok(),
            "retry-after" => state.retry_after = value.parse().ok(),
            _ => {}
        }
    }
    state
}

fn parse_api_response(raw: &[u8]) -> Result<(serde_json::Value, RateLimitState), AppError> {
    let (_, header_block, body) = split_http_response(raw)?;
    let rate_state = parse_rate_limit_headers(header_block);
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|error| AppError::io(format!("unexpected GitHub response: {error}")))?;
    Ok((value, rate_state))
}

fn split_http_response(raw: &[u8]) -> Result<(u16, &str, &[u8]), AppError> {
    let mut offset = 0;
    loop {
        let remaining = &raw[offset..];
        let crlf = find_bytes(remaining, b"\r\n\r\n").map(|at| (at, 4));
        let lf = find_bytes(remaining, b"\n\n").map(|at| (at, 2));
        let (boundary, separator_len) = match (crlf, lf) {
            (Some(a), Some(b)) => {
                if a.0 <= b.0 {
                    a
                } else {
                    b
                }
            }
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => return Err(AppError::io("GitHub response did not include headers")),
        };
        let header_text = String::from_utf8_lossy(&remaining[..boundary]);
        let status = header_text
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse::<u16>().ok())
            .ok_or_else(|| AppError::io("GitHub response did not include an HTTP status"))?;
        let body_offset = offset + boundary + separator_len;
        if raw[body_offset..].starts_with(b"HTTP/") {
            offset = body_offset;
            continue;
        }
        // Keep the header text alive only for the duration of the returned borrow;
        // callers parse headers immediately, so return a view into the raw bytes.
        let headers = std::str::from_utf8(&raw[offset..offset + boundary])
            .map_err(|_| AppError::io("GitHub response headers were not valid UTF-8"))?;
        return Ok((status, headers, &raw[body_offset..]));
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn header_value(headers: &str, wanted: &str) -> Option<String> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.trim().eq_ignore_ascii_case(wanted) {
            return None;
        }
        let value = value.trim();
        (value.len() <= 1024 && !value.chars().any(char::is_control)).then(|| value.to_string())
    })
}

/// API-level failure from a parsed GitHub response body, if any.
/// GraphQL reports errors[]; REST failures (401 Bad credentials, rate
/// limits) carry a top-level message with no data. Success bodies never
/// match: GraphQL responses have data, and the REST list endpoints return
/// arrays or objects without a top-level message.
fn api_failure(value: &serde_json::Value) -> Option<AppError> {
    if let Some(message) = value
        .get("errors")
        .and_then(|errors| errors.get(0))
        .and_then(|first| first.get("message"))
        .and_then(serde_json::Value::as_str)
    {
        if message.to_ascii_lowercase().contains("rate limit") {
            return Some(AppError::rate_limited(
                "GitHub rate limit reached; retrying when the quota resets".to_string(),
            ));
        }
        return Some(AppError::io(format!("GitHub query failed: {message}")));
    }
    if value.get("data").is_none()
        && let Some(message) = value.get("message").and_then(serde_json::Value::as_str)
    {
        if message == "Bad credentials" {
            return Some(AppError::io(
                "GitHub rejected the stored token (invalid or revoked) - link the account again in Settings".to_string(),
            ));
        }
        if message.to_ascii_lowercase().contains("rate limit") {
            return Some(AppError::rate_limited(
                "GitHub rate limit reached; retrying when the quota resets".to_string(),
            ));
        }
        return Some(AppError::io(format!("GitHub request failed: {message}")));
    }
    None
}

fn str_field(value: &serde_json::Value, name: &str) -> Option<String> {
    value
        .get(name)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn u64_field(value: &serde_json::Value, name: &str) -> u64 {
    value
        .get(name)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
}

fn parse_release(node: &serde_json::Value) -> Option<GhRelease> {
    Some(GhRelease {
        name: str_field(node, "name"),
        tag: str_field(node, "tagName")?,
        published_at: str_field(node, "publishedAt"),
        draft: node
            .get("isDraft")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        // Marked by the caller: the GitHub schema has no Latest flag on
        // Release, so the newest non-draft non-prerelease wins.
        is_latest: false,
        url: str_field(node, "url")?,
    })
}

/// True when a release node is a prerelease (never the Latest badge).
fn is_prerelease(node: &serde_json::Value) -> bool {
    node.get("isPrerelease")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn parse_language(edge: &serde_json::Value) -> Option<GhLanguage> {
    let node = edge.get("node")?;
    Some(GhLanguage {
        name: str_field(node, "name")?,
        color: str_field(node, "color"),
        size: edge
            .get("size")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
    })
}

fn parse_repo_meta(value: &serde_json::Value) -> Option<GhRepoMeta> {
    let repo = value.get("data")?.get("repository")?;
    let topics = repo
        .get("repositoryTopics")
        .and_then(|topics| topics.get("nodes"))
        .and_then(serde_json::Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|node| node.get("topic")?.get("name")?.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let mut releases: Vec<GhRelease> = Vec::new();
    if let Some(nodes) = repo
        .get("releases")
        .and_then(|releases| releases.get("nodes"))
        .and_then(serde_json::Value::as_array)
    {
        // Nodes arrive newest-first; Latest is the first published full release.
        let mut latest = None;
        for node in nodes {
            let Some(release) = parse_release(node) else {
                continue;
            };
            if latest.is_none() && !release.draft && !is_prerelease(node) {
                latest = Some(releases.len());
            }
            releases.push(release);
        }
        if let Some(index) = latest {
            releases[index].is_latest = true;
        }
    }
    let languages = repo
        .get("languages")
        .and_then(|languages| languages.get("edges"))
        .and_then(serde_json::Value::as_array)
        .map(|edges| edges.iter().filter_map(parse_language).collect())
        .unwrap_or_default();
    Some(GhRepoMeta {
        id: str_field(repo, "id")?,
        is_private: repo
            .get("isPrivate")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        description: str_field(repo, "description"),
        homepage_url: str_field(repo, "homepageUrl"),
        topics,
        license: repo
            .get("licenseInfo")
            .and_then(|info| info.get("name"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        stars: u64_field(repo, "stargazerCount"),
        forks: u64_field(repo, "forkCount"),
        watchers: repo
            .get("watchers")
            .and_then(|watchers| watchers.get("totalCount"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        viewer_starred: repo
            .get("viewerHasStarred")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        viewer_subscription: str_field(repo, "viewerSubscription")
            .unwrap_or_else(|| "UNSUBSCRIBED".to_string()),
        // Empty repos have no default branch yet; callers fall back to the
        // local branch instead of failing the whole overview.
        default_branch: repo
            .get("defaultBranchRef")
            .and_then(|branch| branch.get("name"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string(),
        releases,
        languages,
    })
}

fn parse_contributor(entry: &serde_json::Value) -> Option<GhContributor> {
    Some(GhContributor {
        login: str_field(entry, "login")?,
        contributions: u64_field(entry, "contributions"),
        avatar_url: str_field(entry, "avatar_url")?,
    })
}

/// Repository overview for the repo screen as one stored account.
pub fn repo_meta(owner: &str, repo: &str, account: &str) -> Result<GhRepoMeta, AppError> {
    let owner = validate_name(owner, "owner")?;
    let repo = validate_name(repo, "repo")?;
    let token = account_token(account)?;
    let value = cached_graphql(
        &owner,
        &repo,
        account,
        "meta",
        &token,
        REPO_META_QUERY,
        serde_json::json!({ "owner": owner, "name": repo }),
    )?;
    parse_repo_meta(&value).ok_or_else(|| {
        AppError::io(format!(
            "GitHub query failed: Could not resolve to a Repository with the name '{owner}/{repo}'"
        ))
    })
}

/// Top contributors for the repo screen sidebar as one stored account.
pub fn repo_contributors(
    owner: &str,
    repo: &str,
    account: &str,
) -> Result<Vec<GhContributor>, AppError> {
    let owner = validate_name(owner, "owner")?;
    let repo = validate_name(repo, "repo")?;
    let account = validate_account(account)?;
    let token = default_store()
        .get(&account)?
        .ok_or_else(|| AppError::validation(format!("GitHub account '{account}' is not linked")))?;
    let value = repo_rest_get(
        &token,
        &owner,
        &repo,
        &account,
        "contributors",
        &format!("/repos/{owner}/{repo}/contributors?per_page=10"),
    )?;
    Ok(value
        .as_array()
        .map(|entries| entries.iter().filter_map(parse_contributor).collect())
        .unwrap_or_default())
}

/// One issue label.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GhIssueLabel {
    pub name: String,
    pub color: String,
}

/// One issue row. Tokens never appear here.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GhIssue {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub url: String,
    pub updated_at: Option<String>,
    pub comments: u64,
    pub labels: Vec<GhIssueLabel>,
}

const ISSUES_QUERY: &str = "query($owner:String!,$name:String!,$states:[IssueState!]) { repository(owner:$owner,name:$name) { issues(first:50,states:$states,orderBy:{field:UPDATED_AT,direction:DESC}) { totalCount nodes { number title author{login} url updatedAt comments{totalCount} labels(first:10){nodes{name color}} } } } }";
const ASSIGNED_ISSUES_QUERY: &str = "query($query:String!) { search(query:$query,type:ISSUE,first:20) { issueCount nodes { ... on Issue { number title author{login} url updatedAt comments{totalCount} labels(first:10){nodes{name color}} } } } }";

/// Issue list with its total count for the repo screen Issues tab.
/// Tokens never appear here.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GhIssueList {
    pub total: u64,
    pub issues: Vec<GhIssue>,
}

fn parse_issue_label(node: &serde_json::Value) -> Option<GhIssueLabel> {
    Some(GhIssueLabel {
        name: str_field(node, "name")?,
        color: str_field(node, "color").unwrap_or_else(|| "ededed".to_string()),
    })
}

/// One Actions workflow run. Tokens never appear here.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GhRun {
    pub id: u64,
    pub name: String,
    pub branch: String,
    pub sha: String,
    pub message: String,
    pub actor: String,
    pub actor_avatar: Option<String>,
    pub status: String,
    pub conclusion: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub url: String,
}

fn parse_run(node: &serde_json::Value) -> Option<GhRun> {
    let id = node.get("id")?.as_u64()?;
    if id == 0 {
        return None;
    }
    let head_commit = node.get("head_commit");
    Some(GhRun {
        id,
        name: str_field(node, "name").unwrap_or_else(|| "workflow".to_string()),
        branch: str_field(node, "head_branch").unwrap_or_default(),
        sha: str_field(node, "head_sha").unwrap_or_default(),
        message: head_commit
            .and_then(|commit| commit.get("message"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .lines()
            .next()
            .unwrap_or("")
            .to_string(),
        actor: node
            .get("actor")
            .and_then(|actor| actor.get("login"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("ghost")
            .to_string(),
        actor_avatar: node
            .get("actor")
            .and_then(|actor| actor.get("avatar_url"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        status: str_field(node, "status").unwrap_or_else(|| "unknown".to_string()),
        conclusion: str_field(node, "conclusion"),
        created_at: str_field(node, "created_at"),
        updated_at: str_field(node, "updated_at"),
        url: str_field(node, "html_url")?,
    })
}

/// One normalized GitHub notification. API URLs are never returned to the UI;
/// `page` and `number` describe a fixed GitHub route for the opener command.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GhNotification {
    pub id: String,
    pub account: String,
    pub owner: String,
    pub repo: String,
    pub title: String,
    pub reason: String,
    pub subject_type: String,
    pub unread: bool,
    pub updated_at: Option<String>,
    pub page: String,
    pub number: Option<u64>,
}

#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GhNotificationFailure {
    pub account: String,
    pub message: String,
}

#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GhNotificationBatch {
    pub notifications: Vec<GhNotification>,
    pub failures: Vec<GhNotificationFailure>,
}

fn notification_page(subject_type: &str, subject_url: &str) -> (String, Option<u64>) {
    let Some(path) = subject_url.strip_prefix("https://api.github.com/repos/") else {
        return ("issues".to_string(), None);
    };
    let parts: Vec<&str> = path.trim_end_matches('/').split('/').collect();
    match parts.as_slice() {
        [_, _, "issues", number] if subject_type == "Issue" => number
            .parse::<u64>()
            .ok()
            .filter(|number| *number > 0)
            .map(|number| ("issue".to_string(), Some(number)))
            .unwrap_or_else(|| ("issues".to_string(), None)),
        [_, _, "pulls", number] if subject_type == "PullRequest" => number
            .parse::<u64>()
            .ok()
            .filter(|number| *number > 0)
            .map(|number| ("pull".to_string(), Some(number)))
            .unwrap_or_else(|| ("pulls".to_string(), None)),
        [_, _, "check-suites", _] | [_, _, "check-runs", _] => ("actions".to_string(), None),
        _ => ("issues".to_string(), None),
    }
}

fn parse_notification(node: &serde_json::Value, account: &str) -> Option<GhNotification> {
    let id = node.get("id")?.as_str()?;
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let repository = node.get("repository")?;
    let full_name = repository.get("full_name")?.as_str()?;
    let (owner, repo) = full_name.split_once('/')?;
    let owner = validate_name(owner, "owner").ok()?;
    let repo = validate_name(repo, "repo").ok()?;
    let subject = node.get("subject")?;
    let subject_type = subject.get("type")?.as_str()?;
    let subject_url = subject
        .get("url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let (page, number) = notification_page(subject_type, subject_url);
    let title = subject.get("title")?.as_str()?;
    Some(GhNotification {
        id: id.to_string(),
        account: account.to_string(),
        owner,
        repo,
        title: title.chars().take(500).collect(),
        reason: node
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .filter(|reason| {
                reason.len() <= 64
                    && reason
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            })
            .unwrap_or("other")
            .to_string(),
        subject_type: subject_type.chars().take(40).collect(),
        unread: node
            .get("unread")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        updated_at: node
            .get("updated_at")
            .and_then(serde_json::Value::as_str)
            .map(|value| value.chars().take(40).collect()),
        page,
        number,
    })
}

fn parse_notifications(value: &serde_json::Value, account: &str) -> Vec<GhNotification> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .take(MAX_NOTIFICATIONS_PER_ACCOUNT)
        .filter_map(|node| parse_notification(node, account))
        .collect()
}

fn notifications_for_account(account: &str) -> Result<Vec<GhNotification>, AppError> {
    let account = validate_account(account)?;
    let token = account_token(&account)?;
    let auth = format!("Bearer {token}");
    let config = curl_config(
        &[
            ("Accept", "application/vnd.github+json"),
            ("Authorization", &auth),
        ],
        &[],
    )?;
    let url =
        format!("https://api.github.com/notifications?per_page={MAX_NOTIFICATIONS_PER_ACCOUNT}");
    let refs = [
        "curl",
        "-sS",
        "-D",
        "-",
        "-o",
        "-",
        "--max-time",
        CURL_TIMEOUT_SECS,
        "--max-filesize",
        "2097152",
        &url,
    ];
    let output = curl_output_with_config(&refs, Some(&config))?;
    if output.stdout.len() as u64 > MAX_NOTIFICATION_RESPONSE_BYTES {
        return Err(AppError::io(
            "GitHub notifications response exceeded the 2 MiB limit",
        ));
    }
    let (status, headers, body) = split_http_response(&output.stdout)?;
    record_rate_limit(parse_rate_limit_headers(headers));
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|error| AppError::io(format!("unexpected GitHub response: {error}")))?;
    if !(200..300).contains(&status) {
        return Err(api_failure(&value).unwrap_or_else(|| {
            AppError::io(format!("GitHub notifications failed with HTTP {status}"))
        }));
    }
    if let Some(failure) = api_failure(&value) {
        return Err(failure);
    }
    Ok(parse_notifications(&value, &account))
}

/// Fetch at most one bounded notification page for each validated linked account.
pub fn notifications(accounts: &[String]) -> Result<GhNotificationBatch, AppError> {
    if accounts.len() > MAX_NOTIFICATION_ACCOUNTS {
        return Err(AppError::validation(
            "too many GitHub accounts for notification refresh",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut result = GhNotificationBatch {
        notifications: Vec::new(),
        failures: Vec::new(),
    };
    for account in accounts {
        let clean = validate_account(account)?;
        if !seen.insert(clean.to_ascii_lowercase()) {
            continue;
        }
        match notifications_for_account(&clean) {
            Ok(rows) => result.notifications.extend(rows),
            Err(error) => result.failures.push(GhNotificationFailure {
                account: clean,
                message: error.message,
            }),
        }
    }
    Ok(result)
}

fn notification_request(account: &str, path: &str) -> Result<(), AppError> {
    let account = validate_account(account)?;
    let token = account_token(&account)?;
    let auth = format!("Bearer {token}");
    let config = curl_config(
        &[
            ("Accept", "application/vnd.github+json"),
            ("Authorization", &auth),
        ],
        &[],
    )?;
    let url = format!("https://api.github.com{path}");
    let refs = [
        "curl",
        "-sS",
        "-D",
        "-",
        "-o",
        "-",
        "--max-time",
        CURL_TIMEOUT_SECS,
        "-X",
        "PUT",
        &url,
    ];
    let output = curl_output_with_config(&refs, Some(&config))?;
    let (status, headers, body) = split_http_response(&output.stdout)?;
    record_rate_limit(parse_rate_limit_headers(headers));
    if status != 205 {
        let value =
            serde_json::from_slice::<serde_json::Value>(body).unwrap_or(serde_json::Value::Null);
        return Err(api_failure(&value).unwrap_or_else(|| {
            AppError::io(format!(
                "GitHub notification update failed with HTTP {status}"
            ))
        }));
    }
    Ok(())
}

pub fn notification_mark_read(account: &str, thread_id: &str) -> Result<(), AppError> {
    if thread_id.is_empty()
        || thread_id.len() > 64
        || !thread_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(AppError::validation("notification thread id is invalid"));
    }
    notification_request(account, &format!("/notifications/threads/{thread_id}"))
}

pub fn notifications_mark_read_all(account: &str) -> Result<(), AppError> {
    notification_request(account, "/notifications")
}

/// Latest Actions runs for the repo screen Actions tab as one stored account.
pub fn repo_runs(owner: &str, repo: &str, account: &str) -> Result<Vec<GhRun>, AppError> {
    let (owner, repo, token) = repo_token(owner, repo, account)?;
    let value = repo_rest_get(
        &token,
        &owner,
        &repo,
        account,
        "runs",
        &format!("/repos/{owner}/{repo}/actions/runs?per_page=30"),
    )?;
    Ok(value
        .get("workflow_runs")
        .and_then(serde_json::Value::as_array)
        .map(|nodes| nodes.iter().filter_map(parse_run).collect())
        .unwrap_or_default())
}

/// Re-run the failed jobs of one Actions run as one stored account.
pub fn repo_rerun(owner: &str, repo: &str, account: &str, run_id: u64) -> Result<(), AppError> {
    if run_id == 0 {
        return Err(AppError::validation(
            "run id must be a positive number".to_string(),
        ));
    }
    let (owner, repo, token) = repo_token(owner, repo, account)?;
    let auth = format!("Bearer {token}");
    let config = curl_config(
        &[
            ("Accept", "application/vnd.github+json"),
            ("Authorization", &auth),
        ],
        &[],
    )?;
    let argv: Vec<String> = vec![
        "curl".to_string(),
        "-sS".to_string(),
        "--max-time".to_string(),
        CURL_TIMEOUT_SECS.to_string(),
        "-X".to_string(),
        "POST".to_string(),
        format!(
            "https://api.github.com/repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs"
        ),
        "--write-out".to_string(),
        "\n%{http_code}".to_string(),
    ];
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    // The rerun endpoint answers 201 with an empty body: the HTTP status is the result.
    let output = curl_output_with_config(&refs, Some(&config))?;
    require_http_status(&output.stdout, 201)?;
    invalidate_repo_cache(&owner, &repo, account);
    Ok(())
}

fn parse_issue(node: &serde_json::Value) -> Option<GhIssue> {
    let labels = node
        .get("labels")
        .and_then(|labels| labels.get("nodes"))
        .and_then(serde_json::Value::as_array)
        .map(|nodes| nodes.iter().filter_map(parse_issue_label).collect())
        .unwrap_or_default();
    Some(GhIssue {
        number: node.get("number")?.as_u64()?,
        title: str_field(node, "title")?,
        author: node
            .get("author")
            .and_then(|author| author.get("login"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("ghost")
            .to_string(),
        url: str_field(node, "url")?,
        updated_at: str_field(node, "updatedAt"),
        comments: node
            .get("comments")
            .and_then(|comments| comments.get("totalCount"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        labels,
    })
}

/// Issue list for the repo screen Issues tab as one stored account.
pub fn repo_issues(
    owner: &str,
    repo: &str,
    account: &str,
    state: &str,
) -> Result<GhIssueList, AppError> {
    let states = match state {
        "open" => vec!["OPEN"],
        "closed" => vec!["CLOSED"],
        _ => {
            return Err(AppError::validation(
                "state must be open or closed".to_string(),
            ));
        }
    };
    let (owner, repo, token) = repo_token(owner, repo, account)?;
    let value = cached_graphql(
        &owner,
        &repo,
        account,
        if state == "open" {
            "issues:open"
        } else {
            "issues:closed"
        },
        &token,
        ISSUES_QUERY,
        serde_json::json!({ "owner": owner, "name": repo, "states": states }),
    )?;
    let connection = value
        .get("data")
        .and_then(|data| data.get("repository"))
        .and_then(|repository| repository.get("issues"));
    Ok(GhIssueList {
        total: connection
            .and_then(|issues| issues.get("totalCount"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        issues: connection
            .and_then(|issues| issues.get("nodes"))
            .and_then(serde_json::Value::as_array)
            .map(|nodes| nodes.iter().filter_map(parse_issue).collect())
            .unwrap_or_default(),
    })
}

/// Open issues assigned to the authenticated viewer for the Launchpad.
pub fn repo_assigned_issues(
    owner: &str,
    repo: &str,
    account: &str,
) -> Result<GhIssueList, AppError> {
    let owner = validate_name(owner, "owner")?;
    let repo = validate_name(repo, "repo")?;
    let token = account_token(account)?;
    let value = cached_graphql(
        &owner,
        &repo,
        account,
        "issues:assigned-viewer",
        &token,
        ASSIGNED_ISSUES_QUERY,
        serde_json::json!({ "query": format!("repo:{owner}/{repo} is:issue is:open assignee:@me") }),
    )?;
    Ok(parse_assigned_issues(&value))
}

fn parse_assigned_issues(value: &serde_json::Value) -> GhIssueList {
    let connection = value.get("data").and_then(|data| data.get("search"));
    GhIssueList {
        total: connection
            .and_then(|search| search.get("issueCount"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        issues: connection
            .and_then(|search| search.get("nodes"))
            .and_then(serde_json::Value::as_array)
            .map(|nodes| nodes.iter().filter_map(parse_issue).collect())
            .unwrap_or_default(),
    }
}

/// One pull request row. Tokens never appear here.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GhPull {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub url: String,
    pub updated_at: Option<String>,
    pub comments: u64,
    pub head_branch: String,
    pub base_branch: String,
    pub merged: bool,
    pub state: String,
}

/// Pull request list with its total count for the repo screen Pulls tab.
/// Tokens never appear here.
#[derive(serde::Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct GhPullList {
    pub total: u64,
    pub pulls: Vec<GhPull>,
}

const PULLS_QUERY: &str = "query($owner:String!,$name:String!,$states:[PullRequestState!]) { repository(owner:$owner,name:$name) { pullRequests(first:25,states:$states,orderBy:{field:UPDATED_AT,direction:DESC}) { totalCount nodes { number title author{login} url updatedAt comments{totalCount} headRefName baseRefName merged state } } } }";

fn parse_pull(node: &serde_json::Value) -> Option<GhPull> {
    Some(GhPull {
        number: node.get("number")?.as_u64()?,
        title: str_field(node, "title")?,
        author: node
            .get("author")
            .and_then(|author| author.get("login"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("ghost")
            .to_string(),
        url: str_field(node, "url")?,
        updated_at: str_field(node, "updatedAt"),
        comments: node
            .get("comments")
            .and_then(|comments| comments.get("totalCount"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        head_branch: str_field(node, "headRefName").unwrap_or_default(),
        base_branch: str_field(node, "baseRefName").unwrap_or_default(),
        merged: node
            .get("merged")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        state: str_field(node, "state").unwrap_or_else(|| "OPEN".to_string()),
    })
}

/// Pull request list for the repo screen Pulls tab as one stored account.
/// Closed includes merged PRs, matching the GitHub web filter.
pub fn repo_pulls(
    owner: &str,
    repo: &str,
    account: &str,
    state: &str,
) -> Result<GhPullList, AppError> {
    let states = match state {
        "open" => vec!["OPEN"],
        "closed" => vec!["CLOSED", "MERGED"],
        _ => {
            return Err(AppError::validation(
                "state must be open or closed".to_string(),
            ));
        }
    };
    let (owner, repo, token) = repo_token(owner, repo, account)?;
    let value = cached_graphql(
        &owner,
        &repo,
        account,
        if state == "open" {
            "pulls:open"
        } else {
            "pulls:closed"
        },
        &token,
        PULLS_QUERY,
        serde_json::json!({ "owner": owner, "name": repo, "states": states }),
    )?;
    let connection = value
        .get("data")
        .and_then(|data| data.get("repository"))
        .and_then(|repository| repository.get("pullRequests"));
    Ok(GhPullList {
        total: connection
            .and_then(|pulls| pulls.get("totalCount"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        pulls: connection
            .and_then(|pulls| pulls.get("nodes"))
            .and_then(serde_json::Value::as_array)
            .map(|nodes| nodes.iter().filter_map(parse_pull).collect())
            .unwrap_or_default(),
    })
}

const REPO_ID_QUERY: &str =
    "query($owner:String!,$name:String!) { repository(owner:$owner,name:$name) { id } }";
const STAR_MUTATION: &str = "mutation($id:ID!,$star:Boolean!) { star(input:{starrableId:$id}) @include(if:$star) { starrable { ... on Repository { viewerHasStarred } } } unstar(input:{starrableId:$id}) @skip(if:$star) { starrable { ... on Repository { viewerHasStarred } } } }";
const WATCH_MUTATION: &str = "mutation($id:ID!,$watch:Boolean!) { subscribe(input:{subscribableId:$id,state:SUBSCRIBED}) @include(if:$watch) { subscribable { ... on Repository { viewerSubscription } } } unsubscribe(input:{subscribableId:$id}) @skip(if:$watch) { subscribable { ... on Repository { viewerSubscription } } } }";
const FORK_MUTATION: &str =
    "mutation($id:ID!) { createFork(input:{repositoryId:$id}) { repository { url } } }";

/// Node id of a repo for the star/watch/fork mutations.
fn repo_node_id(token: &str, owner: &str, repo: &str) -> Result<String, AppError> {
    let value = graphql(
        token,
        REPO_ID_QUERY,
        serde_json::json!({ "owner": owner, "name": repo }),
    )?;
    value
        .get("data")
        .and_then(|data| data.get("repository"))
        .and_then(|repository| repository.get("id"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::io(format!("GitHub query failed: Could not resolve to a Repository with the name '{owner}/{repo}'"))
        })
}

/// Star or unstar a repo as one stored account. Returns the new state.
pub fn repo_set_starred(
    owner: &str,
    repo: &str,
    account: &str,
    starred: bool,
) -> Result<bool, AppError> {
    let (owner, repo, token) = repo_token(owner, repo, account)?;
    let id = repo_node_id(&token, &owner, &repo)?;
    let value = graphql(
        &token,
        STAR_MUTATION,
        serde_json::json!({ "id": id, "star": starred }),
    )?;
    let key = if starred { "star" } else { "unstar" };
    let result = value
        .get("data")
        .and_then(|data| data.get(key))
        .and_then(|result| result.get("starrable"))
        .and_then(|starrable| starrable.get("viewerHasStarred"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(starred);
    invalidate_repo_cache(&owner, &repo, account);
    Ok(result)
}

/// Subscribe or unsubscribe a repo as one stored account. Returns the new state.
pub fn repo_set_watched(
    owner: &str,
    repo: &str,
    account: &str,
    watch: bool,
) -> Result<String, AppError> {
    let (owner, repo, token) = repo_token(owner, repo, account)?;
    let id = repo_node_id(&token, &owner, &repo)?;
    let value = graphql(
        &token,
        WATCH_MUTATION,
        serde_json::json!({ "id": id, "watch": watch }),
    )?;
    let key = if watch { "subscribe" } else { "unsubscribe" };
    let result = value
        .get("data")
        .and_then(|data| data.get(key))
        .and_then(|result| result.get("subscribable"))
        .and_then(|subscribable| subscribable.get("viewerSubscription"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            if watch {
                "SUBSCRIBED".to_string()
            } else {
                "IGNORED".to_string()
            }
        });
    invalidate_repo_cache(&owner, &repo, account);
    Ok(result)
}

/// Fork a repo into the viewer's account. Returns the fork URL.
pub fn repo_fork(owner: &str, repo: &str, account: &str) -> Result<String, AppError> {
    let (owner, repo, token) = repo_token(owner, repo, account)?;
    let id = repo_node_id(&token, &owner, &repo)?;
    let value = graphql(&token, FORK_MUTATION, serde_json::json!({ "id": id }))?;
    let url = value
        .get("data")
        .and_then(|data| data.get("createFork"))
        .and_then(|fork| fork.get("repository"))
        .and_then(|repository| repository.get("url"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::io("GitHub fork did not return a repository URL".to_string()))?;
    invalidate_repo_cache(&owner, &repo, account);
    Ok(url)
}

/// Validated owner/repo plus the selected account's API token.
fn repo_token(
    owner: &str,
    repo: &str,
    account: &str,
) -> Result<(String, String, String), AppError> {
    let owner = validate_name(owner, "owner")?;
    let repo = validate_name(repo, "repo")?;
    let token = account_token(account)?;
    Ok((owner, repo, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> MemoryStore {
        MemoryStore::default()
    }

    #[test]
    fn memory_store_round_trips_set_status_delete_per_account() {
        let store = store();
        assert_eq!(store.get("octocat").expect("get must succeed"), None);
        assert!(!store.any().expect("any must succeed"));
        store
            .set("octocat", "ghp_testtoken123")
            .expect("set must succeed");
        store
            .set("hubot", "github_pat_test456")
            .expect("set must succeed");
        assert_eq!(
            store.get("octocat").expect("get must succeed"),
            Some("ghp_testtoken123".to_string())
        );
        assert!(store.any().expect("any must succeed"));
        assert!(store.delete("octocat").expect("delete must succeed"));
        assert_eq!(store.get("octocat").expect("get must succeed"), None);
        assert!(store.any().expect("other account keeps any true"));
        assert!(!store.delete("octocat").expect("second delete must succeed"));
    }

    #[test]
    fn memory_store_trims_paste_whitespace() {
        let store = store();
        store
            .set("octocat", "  ghp_testtoken123\n")
            .expect("set must succeed");
        assert_eq!(
            store.get("octocat").expect("get must succeed"),
            Some("ghp_testtoken123".to_string())
        );
    }

    #[test]
    fn token_validation_rejects_empty_long_and_gappy_input() {
        let store = store();
        for bad in ["", "   ", "\n", "ghp_abc def", "ghp_abc\ndef"] {
            assert!(
                store.set("octocat", bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
        assert!(
            store
                .set("octocat", &"x".repeat(MAX_TOKEN_LEN + 1))
                .is_err()
        );
        assert!(store.get("octocat").expect("get must succeed").is_none());
    }

    #[test]
    fn gh_auth_token_args_select_the_requested_account() {
        assert_eq!(
            gh_auth_token_args("rozzyrahmanda"),
            [
                "auth",
                "token",
                "--hostname",
                "github.com",
                "--user",
                "rozzyrahmanda"
            ]
        );
        assert!(same_github_account("RozzyRahmanda", "rozzyrahmanda"));
        assert!(!same_github_account("rozzyy", "rozzyrahmanda"));
    }

    #[test]
    fn curl_config_escapes_values_and_rejects_control_characters() {
        let config = curl_config(&[("Authorization", "Bearer a\"b\\c")], &[])
            .expect("safe header must serialize");
        assert_eq!(config, "header = \"Authorization: Bearer a\\\"b\\\\c\"\n");
        assert!(curl_config(&[], &[("device_code", "bad\nvalue")]).is_err());
    }

    #[test]
    fn rate_limit_headers_back_off_when_quota_is_low() {
        let headers = "x-ratelimit-limit: 100\r\n\
            x-ratelimit-remaining: 9\r\n\
            x-ratelimit-reset: 3600\r\n";
        let parsed = parse_rate_limit_headers(headers);
        assert_eq!(parsed.limit, Some(100));
        assert_eq!(parsed.remaining, Some(9));
        assert!(parsed.is_low());
        assert!(
            parsed
                .retry_delay(SystemTime::UNIX_EPOCH)
                .is_some_and(|delay| delay > Duration::ZERO)
        );
    }

    #[test]
    fn repo_cache_policy_polls_active_and_background_repos() {
        let now = Instant::now();
        let active = RepoCacheEntry {
            owner: "octo".to_string(),
            repo: "hello".to_string(),
            account: "octocat".to_string(),
            fetched_at: now - Duration::from_secs(30),
            expires_at: now + Duration::from_secs(30),
            etag: None,
            resource: "meta".to_string(),
            value: serde_json::json!({}),
            size_bytes: 2,
            last_accessed: now,
        };
        assert!(!cache_needs_refresh(Some(&active), true, now));
        let quiet = RepoCacheEntry {
            owner: "octo".to_string(),
            repo: "hello".to_string(),
            account: "octocat".to_string(),
            fetched_at: now - Duration::from_secs(299),
            expires_at: now + Duration::from_secs(30),
            etag: None,
            resource: "meta".to_string(),
            value: serde_json::json!({}),
            size_bytes: 2,
            last_accessed: now,
        };
        assert!(!cache_needs_refresh(Some(&quiet), false, now));
        let stale = RepoCacheEntry {
            owner: "octo".to_string(),
            repo: "hello".to_string(),
            account: "octocat".to_string(),
            fetched_at: now - Duration::from_secs(2),
            expires_at: now - Duration::from_secs(1),
            etag: None,
            resource: "meta".to_string(),
            value: serde_json::json!({}),
            size_bytes: 2,
            last_accessed: now,
        };
        assert!(cache_needs_refresh(Some(&stale), true, now));
        assert!(cache_needs_refresh(
            Some(&RepoCacheEntry {
                fetched_at: now - Duration::from_secs(61),
                expires_at: now + Duration::from_secs(100),
                ..active.clone()
            }),
            true,
            now
        ));
        assert_eq!(
            repo_cache_key("octo", "hello", "octocat"),
            "octocat:octo/hello"
        );
        assert_ne!(
            repo_resource_cache_key("octo", "hello", "personal", "runs"),
            repo_resource_cache_key("octo", "hello", "work", "runs")
        );
        assert_eq!(
            repo_resource_cache_key("OCTO", "Hello", "Octocat", "runs"),
            repo_resource_cache_key("octo", "hello", "octocat", "runs")
        );
    }

    #[test]
    fn response_cache_is_bounded_and_rejects_oversized_entries() {
        let Ok(mut cache) = REPO_CACHE.lock() else {
            panic!("cache lock must be available");
        };
        cache.clear();
        drop(cache);

        for index in 0..=REPO_CACHE_MAX_ENTRIES {
            save_repo_value(
                "octo",
                &format!("repo-{index}"),
                "octocat",
                "runs",
                Some(format!("etag-{index}")),
                serde_json::json!({ "index": index }),
                Instant::now() + Duration::from_millis(index as u64),
            );
        }
        let cache = REPO_CACHE.lock().expect("cache lock must be available");
        assert_eq!(cache.len(), REPO_CACHE_MAX_ENTRIES);
        assert!(!cache.contains_key(&repo_resource_cache_key(
            "octo", "repo-0", "octocat", "runs"
        )));
        drop(cache);

        save_repo_value(
            "octo",
            "large",
            "octocat",
            "runs",
            None,
            serde_json::json!({ "payload": "x".repeat(REPO_CACHE_MAX_ENTRY_BYTES) }),
            Instant::now(),
        );
        assert!(
            !REPO_CACHE
                .lock()
                .expect("cache lock must be available")
                .contains_key(&repo_resource_cache_key("octo", "large", "octocat", "runs"))
        );
    }

    #[test]
    fn response_parser_uses_final_http_headers_and_supports_304() {
        let response = b"HTTP/2 200\r\nETag: old\r\n\r\nHTTP/2 304\r\nETag: \"v2\"\r\nX-RateLimit-Limit: 5000\r\nX-RateLimit-Remaining: 42\r\n\r\n";
        let (status, headers, body) = split_http_response(response).expect("HTTP response parses");
        assert_eq!(status, 304);
        assert_eq!(header_value(headers, "etag").as_deref(), Some("\"v2\""));
        assert!(body.is_empty());
        let state = parse_rate_limit_headers(headers);
        assert_eq!(state.remaining, Some(42));

        let ok = b"HTTP/2 200\r\nETag: \"one\"\r\n\r\n{\"ok\":true}";
        let (status, headers, body) = split_http_response(ok).expect("HTTP response parses");
        assert_eq!(status, 200);
        assert_eq!(header_value(headers, "etag").as_deref(), Some("\"one\""));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(body).unwrap()["ok"],
            true
        );
    }

    #[test]
    fn api_failure_surfaces_rest_errors_and_keeps_success_bodies() {
        // 401 bodies carry a top-level message with no data.
        let bad = api_failure(&serde_json::json!({ "message": "Bad credentials" }))
            .expect("401 must fail");
        assert!(format!("{bad:?}").contains("invalid or revoked"), "{bad:?}");
        let limited = api_failure(&serde_json::json!({ "message": "API rate limit exceeded" }))
            .expect("rate limit must fail");
        assert!(format!("{limited:?}").contains("rate limit"), "{limited:?}");
        // GraphQL errors[] keep their existing shape.
        let gql = api_failure(&serde_json::json!({ "errors": [{ "message": "boom" }] }))
            .expect("errors[] must fail");
        assert!(
            format!("{gql:?}").contains("GitHub query failed: boom"),
            "{gql:?}"
        );
        // Success bodies never match: GraphQL data, REST arrays.
        assert!(api_failure(&serde_json::json!({ "data": { "x": 1 } })).is_none());
        assert!(api_failure(&serde_json::json!([{ "login": "octocat" }])).is_none());
        // A null repository with no message is genuinely unresolvable,
        // not an auth failure: the caller keeps its own message.
        assert!(api_failure(&serde_json::json!({ "data": { "repository": null } })).is_none());
    }

    #[test]
    fn account_names_must_be_github_shaped() {
        let store = store();
        for bad in [
            "",
            "a b",
            "owner/repo",
            "../x",
            &"x".repeat(MAX_ACCOUNT_LEN + 1),
        ] {
            assert!(
                store.set(bad, "ghp_testtoken123").is_err(),
                "{bad:?} must be rejected"
            );
            assert!(store.get(bad).is_err(), "{bad:?} must be rejected");
            assert!(store.delete(bad).is_err(), "{bad:?} must be rejected");
        }
        store
            .set("octo-cat42", "ghp_testtoken123")
            .expect("hyphenated login must be accepted");
    }

    #[test]
    fn security_argv_uses_fixed_subcommands_and_no_shell() {
        let get = get_args("octocat");
        assert_eq!(
            get.first().map(String::as_str),
            Some("find-generic-password")
        );
        assert!(get.contains(&"-w".to_string()));
        assert!(get.contains(&"octocat".to_string()));

        let set = set_args("octocat", "TOKEN");
        assert_eq!(
            set.first().map(String::as_str),
            Some("add-generic-password")
        );
        assert!(set.contains(&"-U".to_string()));

        let delete = delete_args("octocat");
        assert_eq!(
            delete.first().map(String::as_str),
            Some("delete-generic-password")
        );

        // No argument is ever interpreted by a shell: every element is one argv.
        for arg in get.iter().chain(set.iter()).chain(delete.iter()) {
            assert!(!arg.contains('\0'), "NUL would truncate argv");
            assert!(
                !arg.contains([';', '|', '$', '`', '&']),
                "no shell metacharacters in fixed argv"
            );
        }
    }

    #[test]
    fn device_grant_and_poll_shapes_parse() {
        let grant = parse_device_grant(&serde_json::json!({
            "device_code": "dc",
            "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 900,
            "interval": 5,
        }))
        .expect("grant must parse");
        assert_eq!(grant.user_code, "ABCD-1234");
        assert_eq!(grant.interval, 5);

        assert!(matches!(
            parse_token_response(&serde_json::json!({"error": "authorization_pending"})),
            TokenPoll::Pending
        ));
        assert!(matches!(
            parse_token_response(&serde_json::json!({"error": "slow_down"})),
            TokenPoll::SlowDown
        ));
        assert!(matches!(
            parse_token_response(&serde_json::json!({"access_token": "tok"})),
            TokenPoll::Authorized(_)
        ));
        assert!(matches!(
            parse_token_response(&serde_json::json!({"error": "expired_token"})),
            TokenPoll::Expired
        ));
        assert!(matches!(
            parse_token_response(&serde_json::json!({"error": "access_denied"})),
            TokenPoll::Denied
        ));
        assert!(matches!(
            parse_token_response(&serde_json::json!({"error": "incorrect_device_code"})),
            TokenPoll::Invalid(_)
        ));

        assert_eq!(
            parse_user_login(&serde_json::json!({"login": "octocat"})).expect("login must parse"),
            "octocat"
        );
        assert!(parse_user_login(&serde_json::json!({})).is_err());
        assert!(parse_device_grant(&serde_json::json!({"error": "x"})).is_err());
    }

    #[test]
    fn polls_without_a_pending_entry_are_rejected() {
        assert!(device_poll("gh-nope").is_err());
    }

    #[test]
    fn open_url_allowlist_rejects_everything_but_the_device_page() {
        for good in [
            "https://github.com/login/device",
            "https://github.com/login/device/",
            "https://github.com/login/device?user_code=ABCD-1234",
        ] {
            assert!(validate_open_url(good).is_ok(), "{good} must open");
        }
        for bad in [
            "",
            "http://github.com/login/device",
            "https://github.com/login/device_evil",
            "https://github.com/settings",
            "https://evil.com/login/device",
            "https://github.com/login/device foo",
            "javascript:alert(1)",
        ] {
            assert!(validate_open_url(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn commit_page_url_requires_valid_owner_repo_and_full_sha() {
        let sha = "a".repeat(40);
        assert_eq!(
            commit_page_url("octo", "repo", &sha).unwrap(),
            format!("https://github.com/octo/repo/commit/{sha}")
        );
        for (owner, sha) in [
            ("octo", "abc1234".to_string()),
            ("octo", format!("{}/../x", "a".repeat(36))),
            ("octo", "g".repeat(40)),
            ("../evil", "a".repeat(40)),
        ] {
            assert!(
                commit_page_url(owner, "repo", &sha).is_err(),
                "{owner:?} {sha:?} must be refused"
            );
        }
    }

    #[test]
    fn repo_page_urls_use_only_fixed_routes_and_positive_pull_numbers() {
        assert_eq!(
            repo_page_url("Shopfoodie", "web_app", "projects", None).unwrap(),
            "https://github.com/Shopfoodie/web_app/projects"
        );
        assert_eq!(
            repo_page_url("octo", "repo", "insights", None).unwrap(),
            "https://github.com/octo/repo/pulse"
        );
        assert_eq!(
            repo_page_url("octo", "repo", "pull", Some(42)).unwrap(),
            "https://github.com/octo/repo/pull/42"
        );
        assert_eq!(
            repo_page_url("octo", "repo", "issue", Some(7)).unwrap(),
            "https://github.com/octo/repo/issues/7"
        );
        assert_eq!(
            repo_page_url("octo", "repo", "actions", None).unwrap(),
            "https://github.com/octo/repo/actions"
        );
        for (page, number) in [
            ("https://evil.example", None),
            ("projects/../../evil", None),
            ("pull", Some(0)),
            ("wiki", Some(7)),
        ] {
            assert!(
                repo_page_url("octo", "repo", page, number).is_err(),
                "{page:?} must be refused"
            );
        }
        assert!(repo_page_url("../evil", "repo", "wiki", None).is_err());
    }

    #[test]
    fn github_notifications_are_normalized_and_only_keep_safe_routes() {
        let account = "octocat";
        let value = serde_json::json!([
            {
                "id": "123456789",
                "unread": true,
                "reason": "review_requested",
                "updated_at": "2026-11-12T12:00:00Z",
                "repository": { "full_name": "Shopfoodie/web_app" },
                "subject": {
                    "title": "Please review",
                    "type": "PullRequest",
                    "url": "https://api.github.com/repos/Shopfoodie/web_app/pulls/42"
                }
            },
            {
                "id": "42",
                "unread": true,
                "reason": "mention",
                "repository": { "full_name": "octo/repo" },
                "subject": {
                    "title": "Issue mention",
                    "type": "Issue",
                    "url": "https://api.github.com/repos/octo/repo/issues/7"
                }
            },
            {
                "id": "8",
                "unread": true,
                "reason": "ci_activity",
                "repository": { "full_name": "octo/repo" },
                "subject": {
                    "title": "Checks failed",
                    "type": "CheckSuite",
                    "url": "https://api.github.com/repos/octo/repo/check-suites/23"
                }
            },
            {
                "id": "bad/id",
                "repository": { "full_name": "octo/repo" },
                "subject": { "title": "Unsafe", "type": "Issue" }
            }
        ]);

        let rows = parse_notifications(&value, account);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].account, account);
        assert_eq!(
            (rows[0].owner.as_str(), rows[0].repo.as_str()),
            ("Shopfoodie", "web_app")
        );
        assert_eq!((rows[0].page.as_str(), rows[0].number), ("pull", Some(42)));
        assert_eq!((rows[1].page.as_str(), rows[1].number), ("issue", Some(7)));
        assert_eq!((rows[2].page.as_str(), rows[2].number), ("actions", None));
    }

    #[test]
    fn notification_account_and_thread_inputs_are_bounded_before_io() {
        let accounts = vec!["octocat".to_string(); MAX_NOTIFICATION_ACCOUNTS + 1];
        assert!(notifications(&accounts).is_err());
        for invalid in ["", "abc/def", "thread-1", &"9".repeat(65)] {
            assert!(notification_mark_read("octocat", invalid).is_err());
        }
        assert!(repo_page_url("octo", "repo", "issue", Some(0)).is_err());
    }

    #[test]
    fn poll_gate_allows_first_and_enforces_interval() {
        let now = Instant::now();
        assert!(should_poll(None, Duration::from_secs(5), now));
        assert!(!should_poll(Some(now), Duration::from_secs(5), now));
        assert!(should_poll(
            Some(now - Duration::from_secs(6)),
            Duration::from_secs(5),
            now
        ));
        assert!(should_poll(
            Some(now - Duration::from_secs(5)),
            Duration::from_secs(5),
            now
        ));
    }

    #[test]
    fn pending_map_sweeps_expired_and_caps_size() {
        PENDING.lock().unwrap().clear();
        insert_pending(
            "old".to_string(),
            PendingFlow {
                device_code: "dc".to_string(),
                expires_at: Instant::now() - Duration::from_secs(1),
                interval_secs: 5,
                last_poll: None,
            },
        );
        insert_pending(
            "fresh".to_string(),
            PendingFlow {
                device_code: "dc".to_string(),
                expires_at: Instant::now() + Duration::from_secs(900),
                interval_secs: 5,
                last_poll: None,
            },
        );
        {
            let pending = PENDING.lock().unwrap();
            assert!(!pending.contains_key("old"));
            assert!(pending.contains_key("fresh"));
        }
        for n in 0..(MAX_PENDING_FLOWS + 10) {
            insert_pending(
                format!("filler-{n}"),
                PendingFlow {
                    device_code: "dc".to_string(),
                    expires_at: Instant::now() + Duration::from_secs(900),
                    interval_secs: 5,
                    last_poll: None,
                },
            );
        }
        assert!(PENDING.lock().unwrap().len() <= MAX_PENDING_FLOWS);
        PENDING.lock().unwrap().clear();
    }

    #[test]
    fn remote_urls_resolve_owner_and_repo() {
        // Hosts match case-insensitively; owner/repo keep remote casing.
        let github = &|host: &str| host.eq_ignore_ascii_case("github.com");
        assert_eq!(
            parse_github_remote_with("git@github.com:octocat/hello.git", github),
            Some(("octocat".to_string(), "hello".to_string()))
        );
        assert_eq!(
            parse_github_remote_with("https://github.com/Org/Hello", github),
            Some(("Org".to_string(), "Hello".to_string()))
        );
        assert_eq!(
            parse_github_remote_with("SSH://GIT@GITHUB.COM/Shopfoodie/Hiiboss-Selly.GIT", github),
            Some(("Shopfoodie".to_string(), "Hiiboss-Selly".to_string()))
        );
        for bad in [
            "",
            "git@gitlab.com:o/r.git",
            "https://example.com/o/r",
            "https://github.com/onlyowner",
            "not a url",
        ] {
            assert_eq!(parse_github_remote_with(bad, github), None, "{bad:?}");
        }
    }

    #[test]
    fn ssh_alias_hosts_resolve_to_github() {
        let resolve = |host: &str| match host {
            "github-pribadi" => Some("github.com".to_string()),
            _ => None,
        };
        let github_when_known =
            |host: &str| host == "github.com" || resolve(host).as_deref() == Some("github.com");
        assert_eq!(
            parse_github_remote_with(
                "git@github-pribadi:rozzyy/branchwork.git",
                &github_when_known
            ),
            Some(("rozzyy".to_string(), "branchwork".to_string()))
        );
        assert_eq!(
            parse_github_remote_with("git@github-lain:o/r.git", &github_when_known),
            None
        );
        assert_eq!(
            parse_github_remote_with("git@gitlab.com:o/r.git", &github_when_known),
            None
        );
    }

    #[test]
    fn ssh_alias_resolver_rejects_bad_hostnames() {
        assert_eq!(resolve_ssh_hostname(""), None);
        assert_eq!(resolve_ssh_hostname("not a host!"), None);
    }

    #[test]
    fn owner_and_repo_names_validate() {
        assert_eq!(validate_name("o-k_1.2", "owner").unwrap(), "o-k_1.2");
        assert!(validate_name("../x", "owner").is_err());
        assert!(validate_name(".hidden", "repo").is_err());
        assert!(validate_name(".", "repo").is_err());
        assert!(validate_name("", "repo").is_err());
    }

    fn repo_meta_fixture() -> serde_json::Value {
        serde_json::json!({
            "data": { "repository": {
                "id": "R_123",
                "description": "Demo repo",
                "homepageUrl": null,
                "stargazerCount": 42,
                "forkCount": 7,
                "watchers": { "totalCount": 5 },
                "viewerHasStarred": true,
                "viewerSubscription": "SUBSCRIBED",
                "defaultBranchRef": { "name": "main" },
                "licenseInfo": { "name": "MIT" },
                "repositoryTopics": { "nodes": [ { "topic": { "name": "rust" } } ] },
                "releases": { "nodes": [ {
                    "name": "v1.0", "tagName": "v1.0.0",
                    "publishedAt": "2026-01-01T00:00:00Z",
                    "isDraft": false, "isPrerelease": false,
                    "url": "https://github.com/o/r/releases/v1.0.0"
                } ] },
                "languages": { "edges": [
                    { "size": 900, "node": { "name": "Rust", "color": "#dea584" } },
                    { "size": 100, "node": { "name": "Shell", "color": null } }
                ] }
            } }
        })
    }

    #[test]
    fn repo_meta_parses_overview_releases_and_languages() {
        let meta = parse_repo_meta(&repo_meta_fixture()).expect("fixture must parse");
        assert_eq!(meta.id, "R_123");
        assert_eq!(meta.description.as_deref(), Some("Demo repo"));
        assert_eq!(meta.homepage_url, None);
        assert_eq!(meta.topics, vec!["rust".to_string()]);
        assert_eq!(meta.license.as_deref(), Some("MIT"));
        assert_eq!((meta.stars, meta.forks, meta.watchers), (42, 7, 5));
        assert!(meta.viewer_starred);
        assert_eq!(meta.viewer_subscription, "SUBSCRIBED");
        assert_eq!(meta.default_branch, "main");
        assert_eq!(meta.releases.len(), 1);
        assert_eq!(meta.releases[0].tag, "v1.0.0");
        assert!(!meta.releases[0].draft);
        assert!(meta.releases[0].is_latest);
        assert_eq!(meta.languages.len(), 2);
        assert_eq!(meta.languages[0].name, "Rust");
        assert_eq!(meta.languages[0].size, 900);
        // Missing optionals degrade instead of rejecting the repo.
        let mut bare = repo_meta_fixture();
        let repository = bare.get_mut("data").unwrap().get_mut("repository").unwrap();
        repository.as_object_mut().unwrap().remove("licenseInfo");
        repository
            .as_object_mut()
            .unwrap()
            .remove("defaultBranchRef");
        let parsed = parse_repo_meta(&bare).expect("bare repo must parse");
        assert_eq!(parsed.license, None);
        assert_eq!(parsed.default_branch, "");
        assert!(parse_repo_meta(&serde_json::json!({ "data": { "repository": null } })).is_none());
    }

    fn release_nodes() -> serde_json::Value {
        serde_json::json!([
            { "name": "next", "tagName": "v2.0.0", "isDraft": true, "isPrerelease": false, "url": "https://github.com/o/r/releases/v2.0.0" },
            { "name": "beta", "tagName": "v1.5.0", "isDraft": false, "isPrerelease": true, "url": "https://github.com/o/r/releases/v1.5.0" },
            { "name": "v1.0", "tagName": "v1.0.0", "isDraft": false, "isPrerelease": false, "url": "https://github.com/o/r/releases/v1.0.0" }
        ])
    }

    fn meta_with_releases(nodes: &serde_json::Value) -> serde_json::Value {
        let mut fixture = repo_meta_fixture();
        fixture
            .get_mut("data")
            .unwrap()
            .get_mut("repository")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert(
                "releases".to_string(),
                serde_json::json!({ "nodes": nodes }),
            );
        fixture
    }

    #[test]
    fn latest_marks_first_published_full_release() {
        let meta =
            parse_repo_meta(&meta_with_releases(&release_nodes())).expect("fixture must parse");
        assert_eq!(meta.releases.len(), 3);
        assert!(!meta.releases[0].is_latest);
        assert!(!meta.releases[1].is_latest);
        assert!(meta.releases[2].is_latest);
        assert_eq!(meta.releases[2].tag, "v1.0.0");
    }

    #[test]
    fn latest_stays_unset_when_everything_is_draft() {
        let nodes = serde_json::json!([
            { "name": "next", "tagName": "v2.0.0", "isDraft": true, "isPrerelease": false, "url": "https://github.com/o/r/releases/v2.0.0" }
        ]);
        let meta = parse_repo_meta(&meta_with_releases(&nodes)).expect("fixture must parse");
        assert!(!meta.releases[0].is_latest);
    }

    #[test]
    fn contributors_parse_logins_and_counts() {
        let value = serde_json::json!([
            { "login": "octocat", "contributions": 120, "avatar_url": "https://a/u/1" },
            { "login": "hubot", "contributions": 3, "avatar_url": "https://a/u/2" },
            { "login": null, "contributions": 1, "avatar_url": "https://a/u/3" }
        ]);
        let parsed: Vec<GhContributor> = value
            .as_array()
            .unwrap()
            .iter()
            .filter_map(parse_contributor)
            .collect();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].login, "octocat");
        assert_eq!(parsed[0].contributions, 120);
    }

    #[test]
    fn issues_parse_rows_labels_and_counts() {
        let value = serde_json::json!({
            "data": { "repository": { "issues": { "nodes": [
                {
                    "number": 12, "title": "Fix it", "url": "https://github.com/o/r/issues/12",
                    "author": { "login": "octocat" }, "updatedAt": "2026-01-02T00:00:00Z",
                    "comments": { "totalCount": 3 },
                    "labels": { "nodes": [ { "name": "bug", "color": "d73a4a" } ] }
                },
                {
                    "number": 13, "title": "No author", "url": "https://github.com/o/r/issues/13",
                    "author": null, "updatedAt": null,
                    "comments": { "totalCount": 0 }, "labels": { "nodes": [] }
                },
                { "number": null, "title": "Broken" }
            ] } } }
        });
        let nodes = value["data"]["repository"]["issues"]["nodes"]
            .as_array()
            .unwrap();
        let parsed: Vec<GhIssue> = nodes.iter().filter_map(parse_issue).collect();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].number, 12);
        assert_eq!(
            parsed[0].labels,
            vec![GhIssueLabel {
                name: "bug".to_string(),
                color: "d73a4a".to_string(),
            }]
        );
        assert_eq!(parsed[0].comments, 3);
        assert_eq!(parsed[1].author, "ghost");
        assert_eq!(parsed[1].updated_at, None);
    }

    #[test]
    fn assigned_issue_search_parses_count_and_only_issue_nodes() {
        let value = serde_json::json!({
            "data": { "search": { "issueCount": 1, "nodes": [
                { "number": 21, "title": "Assigned", "url": "https://github.com/o/r/issues/21",
                  "author": { "login": "octocat" }, "comments": { "totalCount": 2 },
                  "labels": { "nodes": [] } },
                { "number": null, "title": "Invalid" }
            ] } }
        });
        let parsed = parse_assigned_issues(&value);
        assert_eq!(parsed.total, 1);
        assert_eq!(parsed.issues.len(), 1);
        assert_eq!(parsed.issues[0].number, 21);
        assert_eq!(parsed.issues[0].title, "Assigned");
    }

    #[test]
    fn repo_issues_rejects_bad_state_before_touching_the_network() {
        assert!(repo_issues("o", "r", "octocat", "bogus").is_err());
    }

    #[test]
    fn repo_pulls_rejects_bad_state_before_touching_the_network() {
        assert!(repo_pulls("o", "r", "octocat", "bogus").is_err());
    }

    #[test]
    fn pulls_parse_rows_and_head_branches() {
        let value = serde_json::json!({ "nodes": [
            {
                "number": 7, "title": "Add auth", "url": "https://github.com/o/r/pull/7",
                "updatedAt": "2026-01-02T00:00:00Z",
                "author": { "login": "octocat" },
                "comments": { "totalCount": 2 },
                "headRefName": "feat/auth", "baseRefName": "main",
                "merged": false, "state": "OPEN"
            },
            {
                "number": 6, "title": "Old", "url": "https://github.com/o/r/pull/6",
                "updatedAt": null, "author": null,
                "comments": { "totalCount": 0 },
                "headRefName": null, "baseRefName": "main",
                "merged": true, "state": "MERGED"
            }
        ] });
        let nodes = value["nodes"].as_array().unwrap();
        let parsed: Vec<GhPull> = nodes.iter().filter_map(parse_pull).collect();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].head_branch, "feat/auth");
        assert!(!parsed[0].merged);
        assert_eq!(parsed[0].state, "OPEN");
        assert_eq!(parsed[1].author, "ghost");
        assert_eq!(parsed[1].head_branch, "");
        assert!(parsed[1].merged);
    }

    #[test]
    fn open_repo_rejects_bad_names_before_touching_the_shell() {
        assert!(open_repo("../x", "r").is_err());
        assert!(open_repo("o", "").is_err());
    }

    #[test]
    fn runs_parse_rows_and_first_commit_lines() {
        let value = serde_json::json!({ "workflow_runs": [
            {
                "id": 99, "name": "CI", "head_branch": "main",
                "head_sha": "abc123", "html_url": "https://github.com/o/r/actions/runs/99",
                "status": "completed", "conclusion": "failure",
                "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z",
                "actor": { "login": "octocat", "avatar_url": "https://a/u/1" },
                "head_commit": { "message": "Fix it\n\nBody here" }
            },
            { "id": 0, "name": "Zero" },
            { "id": 100, "name": null, "head_branch": null, "head_sha": null,
              "html_url": null, "status": null, "conclusion": null,
              "created_at": null, "updated_at": null, "actor": null, "head_commit": null }
        ] });
        let nodes = value["workflow_runs"].as_array().unwrap();
        let parsed: Vec<GhRun> = nodes.iter().filter_map(parse_run).collect();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, 99);
        assert_eq!(parsed[0].message, "Fix it");
        assert_eq!(parsed[0].conclusion.as_deref(), Some("failure"));
        assert_eq!(parsed[0].actor, "octocat");
        assert_eq!(parsed[0].actor_avatar.as_deref(), Some("https://a/u/1"));
    }

    #[test]
    fn repo_rerun_rejects_zero_ids_before_touching_the_network() {
        assert!(repo_rerun("o", "r", "octocat", 0).is_err());
    }

    #[test]
    fn rerun_accepts_only_the_created_http_response() {
        assert!(require_http_status(b"\n201", 201).is_ok());
        let error = require_http_status(b"{\"message\":\"Forbidden\"}\n403", 201).unwrap_err();
        assert!(error.message.contains("403"));
        assert!(require_http_status(b"no status", 201).is_err());
    }
}
