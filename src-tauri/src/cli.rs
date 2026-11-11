//! Narrow commands for the CLI registry (spec §6.6.1).
//!
//! The WebView never gets generic shell access: `resolve_binary` answers only
//! "where is this one binary on the login shell's PATH", and
//! `ensure_profile_dir` only creates directories under
//! `~/.branchwork/profiles/`. Launching a CLI with its profile environment is
//! a later Stage 3 task.

use std::path::{Path, PathBuf};

use crate::error::AppError;

/// Binary names are single path segments: letters, digits, and `._+-`.
fn valid_binary(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '+' || c == '-')
}

/// CLI ids and profile slugs are lowercase segments; slugs may contain `-`.
fn valid_segment(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => (),
        _ => return false,
    }
    value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn system_home() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn profile_base(home: &Path) -> PathBuf {
    home.join(".branchwork").join("profiles")
}

fn profile_dir(home: &Path, cli_id: &str, slug: &str) -> Result<PathBuf, AppError> {
    if !valid_segment(cli_id) {
        return Err(AppError::validation("cli id must be a lowercase segment"));
    }
    if !valid_segment(slug) {
        return Err(AppError::validation(
            "profile slug must be 1-64 lowercase letters, digits, or '-'",
        ));
    }
    Ok(profile_base(home).join(format!("{cli_id}-{slug}")))
}

fn ensure_in(home: &Path, cli_id: &str, slug: &str) -> Result<PathBuf, AppError> {
    let dir = profile_dir(home, cli_id, slug)?;
    std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::create_dir_all(dir.join("home")))
        .map_err(|error| AppError::io(format!("could not create profile dir: {error}")))?;
    Ok(dir)
}

/// Credential files are plain filenames from the registry, never paths: no
/// separators, no parent references, so logout can only remove files directly
/// inside the profile dir.
fn valid_credential_file(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        && name != "."
        && name != ".."
}

/// Credential paths may nest inside the profile dir (e.g. the OpenCode token
/// at `home/.local/share/opencode/auth.json`). Every `/`-separated segment
/// must itself be a plain filename, so `..`, empty segments, and absolute
/// paths can never escape the profile dir through `Path::join`.
fn valid_credential_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 256
        && !path.starts_with('/')
        && path.split('/').all(valid_credential_file)
}

/// Remove the registry's declared credential files inside the profile dir.
/// Returns the names actually removed. Nothing else in the dir is touched.
fn logout_in(
    home: &Path,
    cli_id: &str,
    slug: &str,
    credential_files: &[String],
) -> Result<Vec<String>, AppError> {
    let dir = profile_dir(home, cli_id, slug)?;
    for name in credential_files {
        if !valid_credential_path(name) {
            return Err(AppError::validation(
                "credential files must stay inside the profile dir",
            ));
        }
    }
    let mut removed = Vec::new();
    for name in credential_files {
        match std::fs::remove_file(dir.join(name)) {
            Ok(()) => removed.push(name.clone()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(AppError::io(format!("could not remove {name}: {error}")));
            }
        }
    }
    Ok(removed)
}

fn valid_profile_cli(cli_id: &str) -> bool {
    matches!(
        cli_id,
        "claude" | "codex" | "opencode" | "gemini" | "copilot" | "muse"
    )
}

pub fn validate_profile_ref(cli_id: &str, slug: &str) -> Result<(), AppError> {
    if !valid_profile_cli(cli_id) {
        return Err(AppError::validation("unknown agent profile provider"));
    }
    if !valid_segment(slug) {
        return Err(AppError::validation(
            "profile slug must be 1-64 lowercase letters, digits, or '-'",
        ));
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), AppError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(AppError::validation(
            "profile storage may not pass through a symbolic link",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::io(format!(
            "could not inspect profile storage: {error}"
        ))),
    }
}

#[cfg(unix)]
fn remove_profile_link(path: &Path) -> std::io::Result<()> {
    std::fs::remove_file(path)
}

#[cfg(windows)]
fn remove_profile_link(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        std::fs::remove_dir(path)
    } else {
        std::fs::remove_file(path)
    }
}

fn remove_profile_dir(path: &Path) -> Result<(), AppError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => remove_profile_link(path)
            .map_err(|error| AppError::io(format!("could not remove profile link: {error}"))),
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(path)
            .map_err(|error| AppError::io(format!("could not remove profile data: {error}"))),
        Ok(_) => std::fs::remove_file(path)
            .map_err(|error| AppError::io(format!("could not remove profile data: {error}"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::io(format!(
            "could not inspect profile data: {error}"
        ))),
    }
}

fn remove_profile_in<F>(home: &Path, cli_id: &str, slug: &str, logout: F) -> Result<(), AppError>
where
    F: FnOnce(&str, &Path) -> Result<(), AppError>,
{
    validate_profile_ref(cli_id, slug)?;
    let dir = profile_dir(home, cli_id, slug)?;
    let branchwork_dir = home.join(".branchwork");
    let profiles_dir = branchwork_dir.join("profiles");
    reject_symlink(&branchwork_dir)?;
    reject_symlink(&profiles_dir)?;

    let target = match std::fs::symlink_metadata(&dir) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(AppError::io(format!(
                "could not inspect profile data: {error}"
            )));
        }
    };
    let claude_profile_exists = target
        .as_ref()
        .is_some_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink());
    let muse_profile_exists = cli_id == "muse"
        && target
            .as_ref()
            .is_some_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink());
    if muse_profile_exists || (cli_id == "claude" && claude_profile_exists) {
        if cli_id == "claude" {
            reject_symlink(&dir.join(".claude.json"))?;
        }
        logout(cli_id, &dir)?;
    }
    remove_profile_dir(&dir)
}

fn logout_vendor_auth(cli_id: &str, profile_dir: &Path) -> Result<(), AppError> {
    let (binary, args): (&str, &[&str]) = match cli_id {
        "claude" => ("claude", &["auth", "logout"]),
        "muse" => ("muse", &["logout"]),
        _ => return Ok(()),
    };
    let path = lookup_binary(binary)?;
    let mut command = std::process::Command::new(path);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if cli_id == "claude" {
        command.env("CLAUDE_CONFIG_DIR", profile_dir);
    }
    let output = command
        .output()
        .map_err(|error| AppError::io(format!("could not log out from {cli_id}: {error}")))?;
    if !output.status.success() {
        return Err(AppError::io(format!("{cli_id} logout failed")));
    }
    Ok(())
}

fn lookup_binary(binary: &str) -> Result<String, AppError> {
    if !valid_binary(binary) {
        return Err(AppError::validation(
            "binary must be a single executable name",
        ));
    }
    let output = login_shell_which(binary)?;
    let path = output.trim().to_string();
    if path.is_empty() || !Path::new(&path).is_absolute() {
        return Err(AppError::not_found(format!(
            "{binary} is not on the login shell PATH"
        )));
    }
    Ok(path)
}

#[cfg(windows)]
fn login_shell_which(binary: &str) -> Result<String, AppError> {
    // `valid_binary` rejects every cmd metacharacter, so interpolation is safe.
    let output = std::process::Command::new("cmd")
        .args(["/C", &format!("where {binary}")])
        .output()
        .map_err(|error| AppError::io(format!("could not search PATH: {error}")))?;
    if !output.status.success() {
        return Err(AppError::not_found(format!(
            "{binary} is not on the login shell PATH"
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(not(windows))]
fn login_shell_which(binary: &str) -> Result<String, AppError> {
    // Pass the name as an argument, never interpolated, so shell
    // metacharacters in the (validated) name cannot escape the lookup.
    let output = std::process::Command::new("sh")
        .args(["-l", "-c", "command -v -- \"$1\"", "sh", binary])
        .output()
        .map_err(|error| AppError::io(format!("could not search PATH: {error}")))?;
    if !output.status.success() {
        return Err(AppError::not_found(format!(
            "{binary} is not on the login shell PATH"
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn resolve_binary(binary: &str) -> Result<String, AppError> {
    lookup_binary(binary)
}

pub fn ensure_profile_dir(cli_id: &str, slug: &str) -> Result<String, AppError> {
    let home = system_home().ok_or_else(|| AppError::internal("no home directory"))?;
    let dir = ensure_in(&home, cli_id, slug)?;
    Ok(dir.to_string_lossy().into_owned())
}

pub fn logout_profile(
    cli_id: &str,
    slug: &str,
    credential_files: &[String],
) -> Result<Vec<String>, AppError> {
    let home = system_home().ok_or_else(|| AppError::internal("no home directory"))?;
    logout_in(&home, cli_id, slug, credential_files)
}

/// Remove all data for one Branchwork profile. Claude auth is revoked in its
/// isolated config dir; Muse auth is device-wide and is revoked explicitly.
pub fn remove_profile(cli_id: &str, slug: &str) -> Result<(), AppError> {
    let home = system_home().ok_or_else(|| AppError::internal("no home directory"))?;
    remove_profile_in(&home, cli_id, slug, logout_vendor_auth)
}

/// True when any of the registry's declared credential files exists inside
/// the profile dir — i.e. the vendor login actually completed there.
/// Same filename validation as logout: only plain filenames directly inside
/// the dir are ever probed.
fn has_credentials_in(
    home: &Path,
    cli_id: &str,
    slug: &str,
    credential_files: &[String],
) -> Result<bool, AppError> {
    let dir = profile_dir(home, cli_id, slug)?;
    for name in credential_files {
        if !valid_credential_path(name) {
            return Err(AppError::validation(
                "credential files must stay inside the profile dir",
            ));
        }
    }
    Ok(credential_files.iter().any(|name| dir.join(name).is_file()))
}

pub fn has_credentials(
    cli_id: &str,
    slug: &str,
    credential_files: &[String],
) -> Result<bool, AppError> {
    let home = system_home().ok_or_else(|| AppError::internal("no home directory"))?;
    has_credentials_in(&home, cli_id, slug, credential_files)
}

/// Seed Claude's one-time onboarding flag for an isolated profile dir.
///
/// The interactive `claude` TUI runs its Welcome/theme/login-method wizard
/// whenever the profile config lacks `hasCompletedOnboarding` — even when
/// the profile is already authenticated (the status probe then reports
/// logged in while the pane sits on the login picker). Seeding the flag at
/// profile creation lets a verified login go straight to the prompt: the
/// vendor merges keys on later writes, so the flag survives `auth login`.
///
/// Credential safety: this exclusive-creates `.claude.json` only when it
/// does not exist yet. It never reads, merges, overwrites, or logs the
/// file, so an existing OAuth token can neither be observed nor clobbered —
/// creation is atomic and whichever writer wins, no secret is touched.
/// Returns true when this call created the seed file.
fn seed_onboarding_in(home: &Path, cli_id: &str, slug: &str) -> Result<bool, AppError> {
    if cli_id != "claude" {
        return Err(AppError::validation(
            "onboarding seed is only for claude profiles",
        ));
    }
    validate_profile_ref(cli_id, slug)?;
    let dir = profile_dir(home, cli_id, slug)?;
    let branchwork_dir = home.join(".branchwork");
    let profiles_dir = branchwork_dir.join("profiles");
    reject_symlink(&branchwork_dir)?;
    reject_symlink(&profiles_dir)?;
    reject_symlink(&dir)?;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join(".claude.json"))
    {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(br#"{"hasCompletedOnboarding":true}"#)
                .map_err(|error| {
                    AppError::io(format!("could not seed onboarding flag: {error}"))
                })?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(AppError::not_found("profile dir does not exist"))
        }
        Err(error) => Err(AppError::io(format!(
            "could not seed onboarding flag: {error}"
        ))),
    }
}

pub fn seed_onboarding(cli_id: &str, slug: &str) -> Result<bool, AppError> {
    let home = system_home().ok_or_else(|| AppError::internal("no home directory"))?;
    seed_onboarding_in(&home, cli_id, slug)
}

/// Run a read-only vendor status probe and capture its stdout.
///
/// Only fixed, non-interactive argv pairs are allowed — the caller picks a
/// CLI id, never a command. stdin is closed so a probe can never prompt,
/// output is capped, and non-zero exit becomes an error. The output shapes
/// (claude account JSON, muse allowance JSON) carry identity/usage, never
/// secrets. Providers without a verified machine-readable command are
/// rejected: their linked state stays unknown instead of fabricated.
/// Env keys a probe may receive (profile isolation vars only). Values must
/// be absolute paths: a probe runs with the caller's profile env so its
/// answer describes that profile, never an attacker-chosen environment.
const PROBE_ENV_KEYS: [&str; 5] = [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
];

fn valid_probe_env(env: &std::collections::HashMap<String, String>) -> bool {
    env.iter().all(|(key, value)| {
        PROBE_ENV_KEYS.contains(&key.as_str())
            && Path::new(value).is_absolute()
            && !value.contains('\n')
    })
}

pub fn probe(
    cli_id: &str,
    env: Option<&std::collections::HashMap<String, String>>,
) -> Result<String, AppError> {
    let (binary, args): (&str, &[&str]) = match cli_id {
        "claude" => ("claude", &["auth", "status", "--json"]),
        "muse" => ("muse", &["usage", "--json"]),
        _ => {
            return Err(AppError::validation("no status probe for this CLI"));
        }
    };
    if let Some(env) = env
        && !valid_probe_env(env)
    {
        return Err(AppError::validation("probe env is not trusted"));
    }
    let path = lookup_binary(binary)?;
    let mut command = std::process::Command::new(path);
    command.args(args);
    if let Some(env) = env {
        command.envs(env.iter());
    }
    let output = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|error| AppError::io(format!("could not run status probe: {error}")))?;
    if !output.status.success() {
        return Err(AppError::io("status probe failed"));
    }
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    const MAX_PROBE_BYTES: usize = 64 * 1024;
    if text.len() > MAX_PROBE_BYTES {
        text.truncate(MAX_PROBE_BYTES);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_segment_binary_names() {
        for bad in ["", "a/b", "..\\x", "-v", "x;y", "a b", "|cat", "$HOME/x"] {
            assert!(lookup_binary(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn rejects_non_segment_ids_and_slugs() {
        let home = Path::new("/tmp/branchwork-cli-test");
        for bad in ["", "A", "a/b", "a b", "a.b", "-a", &"a".repeat(65)] {
            assert!(ensure_in(home, bad, "ok").is_err());
            assert!(ensure_in(home, "claude", bad).is_err());
        }
    }

    #[test]
    fn resolves_a_shell_binary_and_reports_a_missing_one() {
        #[cfg(windows)]
        let known = "cmd";
        #[cfg(not(windows))]
        let known = "sh";
        let found = lookup_binary(known).expect("system shell must resolve");
        assert!(Path::new(&found).is_absolute(), "{found} must be absolute");
        let missing = lookup_binary("branchwork-definitely-missing-binary");
        assert!(matches!(missing, Err(AppError { .. })));
    }

    #[test]
    fn creates_profile_dirs_under_an_isolated_home() {
        let home =
            std::env::temp_dir().join(format!("branchwork-cli-test-ensure-{}", std::process::id()));
        let dir = ensure_in(&home, "claude", "work-1").expect("profile dir must be created");
        assert_eq!(dir, home.join(".branchwork/profiles/claude-work-1"));
        assert!(dir.join("home").is_dir());
        struct RemoveOnDrop(PathBuf);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).ok();
            }
        }
        let _guard = RemoveOnDrop(home);
    }

    #[test]
    fn onboarding_seed_creates_flag_only_when_absent() {
        let home =
            std::env::temp_dir().join(format!("branchwork-cli-test-seed-{}", std::process::id()));
        let dir = ensure_in(&home, "claude", "seed-1").expect("profile dir must be created");
        struct RemoveOnDrop(PathBuf);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).ok();
            }
        }
        let _guard = RemoveOnDrop(home);
        assert!(seed_onboarding_in(&_guard.0, "claude", "seed-1").expect("seed must succeed"));
        let text = std::fs::read_to_string(dir.join(".claude.json")).expect("seed file must exist");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).expect("seed must be JSON")["hasCompletedOnboarding"],
            serde_json::Value::Bool(true)
        );
        // A second call reports no-op and never touches existing content —
        // an OAuth token written in the meantime is neither read nor clobbered.
        std::fs::write(
            dir.join(".claude.json"),
            r#"{"hasCompletedOnboarding":true,"oauthAccount":{"token":"secret"}}"#,
        )
        .unwrap();
        assert!(
            !seed_onboarding_in(&_guard.0, "claude", "seed-1").expect("repeat seed must succeed")
        );
        assert!(
            std::fs::read_to_string(dir.join(".claude.json"))
                .unwrap()
                .contains("secret"),
            "existing credentials must survive the seed"
        );
    }

    #[test]
    fn onboarding_seed_rejects_other_clis_and_bad_slugs() {
        let home = Path::new("/tmp/branchwork-cli-test-seed-reject");
        for (cli, slug) in [
            ("codex", "work"),
            ("muse", "work"),
            ("claude", "Bad Slug"),
            ("claude", "../escape"),
        ] {
            assert!(seed_onboarding_in(home, cli, slug).is_err());
        }
    }

    #[test]
    fn logout_removes_only_declared_credential_files() {
        let home =
            std::env::temp_dir().join(format!("branchwork-cli-test-logout-{}", std::process::id()));
        let dir = ensure_in(&home, "codex", "work-1").expect("profile dir must be created");
        std::fs::write(dir.join("auth.json"), "{}").unwrap();
        std::fs::write(dir.join("keep.txt"), "x").unwrap();
        struct RemoveOnDrop(std::path::PathBuf);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).ok();
            }
        }
        let _guard = RemoveOnDrop(home);
        let removed = logout_in(
            &_guard.0,
            "codex",
            "work-1",
            &["auth.json".to_string(), "absent.json".to_string()],
        )
        .expect("logout must succeed");
        assert_eq!(removed, vec!["auth.json".to_string()]);
        assert!(!dir.join("auth.json").exists());
        assert!(dir.join("keep.txt").exists());
    }

    #[test]
    fn account_removal_deletes_the_complete_isolated_profile() {
        let home =
            std::env::temp_dir().join(format!("branchwork-cli-test-remove-{}", std::process::id()));
        let dir = ensure_in(&home, "claude", "work").expect("profile dir must be created");
        std::fs::write(dir.join(".claude.json"), r#"{"oauthAccount":{}}"#).unwrap();
        std::fs::write(dir.join("settings.json"), "{}").unwrap();
        let other = ensure_in(&home, "codex", "work").expect("other profile dir must be created");
        struct RemoveOnDrop(PathBuf);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).ok();
            }
        }
        let _guard = RemoveOnDrop(home);
        let mut logout_called = false;

        remove_profile_in(&_guard.0, "claude", "work", |cli_id, profile_dir| {
            logout_called = true;
            assert_eq!(cli_id, "claude");
            assert_eq!(profile_dir, dir);
            Ok(())
        })
        .expect("account removal must succeed");

        assert!(logout_called);
        assert!(!dir.exists());
        assert!(other.is_dir());
    }

    #[test]
    fn account_removal_stops_when_vendor_logout_fails() {
        let home = std::env::temp_dir().join(format!(
            "branchwork-cli-test-remove-fail-{}",
            std::process::id()
        ));
        let dir = ensure_in(&home, "muse", "work").expect("profile dir must be created");
        struct RemoveOnDrop(PathBuf);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).ok();
            }
        }
        let _guard = RemoveOnDrop(home);

        let result = remove_profile_in(&_guard.0, "muse", "work", |cli_id, _| {
            assert_eq!(cli_id, "muse");
            Err(AppError::io("logout failed"))
        });

        assert!(result.is_err());
        assert!(dir.is_dir());
    }

    #[test]
    fn account_removal_does_not_log_out_muse_when_profile_is_missing() {
        let home = std::env::temp_dir().join(format!(
            "branchwork-cli-test-muse-missing-{}",
            std::process::id()
        ));
        struct RemoveOnDrop(PathBuf);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).ok();
            }
        }
        let _guard = RemoveOnDrop(home);
        let mut logout_called = false;

        remove_profile_in(&_guard.0, "muse", "missing", |_, _| {
            logout_called = true;
            Ok(())
        })
        .expect("removing a missing Muse profile must succeed");

        assert!(!logout_called);
    }

    #[test]
    fn account_removal_rejects_unknown_providers_and_path_traversal() {
        let home = Path::new("/tmp/branchwork-cli-test-remove-validation");
        let logout = |_: &str, _: &Path| -> Result<(), AppError> { Ok(()) };
        assert!(remove_profile_in(home, "unknown", "work", logout).is_err());
        assert!(remove_profile_in(home, "codex", "../outside", logout).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn account_removal_rejects_symlinked_profile_parents() {
        let home = std::env::temp_dir().join(format!(
            "branchwork-cli-test-remove-parent-link-{}",
            std::process::id()
        ));
        let outside = home.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), "keep").unwrap();
        std::fs::create_dir_all(home.join(".branchwork")).unwrap();
        std::os::unix::fs::symlink(&outside, home.join(".branchwork/profiles")).unwrap();
        struct RemoveOnDrop(PathBuf);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).ok();
            }
        }
        let _guard = RemoveOnDrop(home);

        let result = remove_profile_in(&_guard.0, "codex", "work", |_, _| Ok(()));

        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "keep"
        );
    }

    #[cfg(unix)]
    #[test]
    fn account_removal_unlinks_a_profile_symlink_without_logging_outside_data() {
        let home = std::env::temp_dir().join(format!(
            "branchwork-cli-test-remove-leaf-link-{}",
            std::process::id()
        ));
        let outside = home.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), "keep").unwrap();
        let profile_parent = home.join(".branchwork/profiles");
        std::fs::create_dir_all(&profile_parent).unwrap();
        std::os::unix::fs::symlink(&outside, profile_parent.join("claude-work")).unwrap();
        struct RemoveOnDrop(PathBuf);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).ok();
            }
        }
        let _guard = RemoveOnDrop(home);
        let mut logout_called = false;

        remove_profile_in(&_guard.0, "claude", "work", |_, _| {
            logout_called = true;
            Ok(())
        })
        .expect("removing a profile link must succeed");

        assert!(!logout_called);
        assert!(!profile_parent.join("claude-work").exists());
        assert_eq!(
            std::fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn has_credentials_reports_only_declared_files() {
        let home = std::env::temp_dir().join(format!(
            "branchwork-cli-test-hascreds-{}",
            std::process::id()
        ));
        let dir = ensure_in(&home, "claude", "work-1").expect("profile dir must be created");
        struct RemoveOnDrop(std::path::PathBuf);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).ok();
            }
        }
        let _guard = RemoveOnDrop(home);
        let files = |names: &[&str]| {
            names
                .iter()
                .map(|name| name.to_string())
                .collect::<Vec<_>>()
        };
        assert!(
            !has_credentials_in(&_guard.0, "claude", "work-1", &files(&[".claude.json"]))
                .expect("check must succeed")
        );
        std::fs::write(dir.join(".claude.json"), "{}").unwrap();
        assert!(
            has_credentials_in(&_guard.0, "claude", "work-1", &files(&[".claude.json"]))
                .expect("check must succeed")
        );
        assert!(
            !has_credentials_in(&_guard.0, "claude", "work-1", &[]).expect("empty list is fine")
        );
        assert!(has_credentials_in(&_guard.0, "claude", "work-1", &files(&["../x"])).is_err());
    }

    #[test]
    fn probe_rejects_clis_without_a_verified_command() {
        for bad in ["codex", "copilot", "../x", "", "claude "] {
            assert!(super::probe(bad, None).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn probe_rejects_untrusted_env() {
        let mut env = std::collections::HashMap::new();
        env.insert("PATH".to_string(), "/tmp".to_string());
        assert!(super::probe("claude", Some(&env)).is_err());
        let mut env = std::collections::HashMap::new();
        env.insert("CLAUDE_CONFIG_DIR".to_string(), "relative/dir".to_string());
        assert!(super::probe("claude", Some(&env)).is_err());
    }

    #[test]
    fn logout_rejects_path_traversal_filenames() {
        let home = Path::new("/tmp/branchwork-cli-test");
        for bad in ["../x", "a/../../x", "/abs", "a//b", "a/", "", ".", ".."] {
            assert!(
                logout_in(home, "codex", "work", &[bad.to_string()]).is_err(),
                "{bad:?} must be rejected"
            );
        }
        // One nesting level inside the profile dir stays allowed.
        assert!(logout_in(home, "codex", "work", &["home/auth.json".to_string()]).is_ok());
    }

    #[test]
    fn has_credentials_supports_nested_declared_paths() {
        let home =
            std::env::temp_dir().join(format!("branchwork-cli-test-nested-{}", std::process::id()));
        let dir = ensure_in(&home, "opencode", "work-1").expect("profile dir must be created");
        struct RemoveOnDrop(std::path::PathBuf);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).ok();
            }
        }
        let _guard = RemoveOnDrop(home);
        let files = vec!["home/.local/share/opencode/auth.json".to_string()];
        assert!(!has_credentials_in(&_guard.0, "opencode", "work-1", &files).expect("check"));
        let nested = dir.join("home/.local/share/opencode");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("auth.json"), "{}").unwrap();
        assert!(has_credentials_in(&_guard.0, "opencode", "work-1", &files).expect("check"));
    }

    #[test]
    fn profile_base_stays_inside_branchwork_profiles() {
        let base = profile_base(Path::new("/home/u"));
        assert_eq!(base, Path::new("/home/u/.branchwork/profiles"));
    }
}
