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
        if !valid_credential_file(name) {
            return Err(AppError::validation(
                "credential files must be plain filenames",
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
        let home = std::env::temp_dir().join(format!(
            "branchwork-cli-test-ensure-{}",
            std::process::id()
        ));
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
    fn logout_removes_only_declared_credential_files() {
        let home = std::env::temp_dir().join(format!(
            "branchwork-cli-test-logout-{}",
            std::process::id()
        ));
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
    fn logout_rejects_path_traversal_filenames() {
        let home = Path::new("/tmp/branchwork-cli-test");
        for bad in ["../x", "a/b", "", ".", ".."] {
            assert!(
                logout_in(home, "codex", "work", &[bad.to_string()]).is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn profile_base_stays_inside_branchwork_profiles() {
        let base = profile_base(Path::new("/home/u"));
        assert_eq!(base, Path::new("/home/u/.branchwork/profiles"));
    }
}
