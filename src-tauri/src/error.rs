//! Typed IPC error contract (spec §8). Every Tauri command returns `Result<T, AppError>` so
//! the frontend can branch on `kind` instead of pattern-matching message strings.
use serde::Serialize;

/// Spec §8 kinds, plus `Validation`, `Conflict` and `NotFound` which the M2 task files add
/// for input validation, stale-write detection and unknown-id lookups.
// ponytail: most kinds (GitConflict, GitHook, Network, RateLimited, PtySpawn, CliMissing,
// ProfileAuth, Conflict) aren't produced by this migration's commands; later M2 tasks construct
// them. `allow(dead_code)` keeps the full spec contract in the TS bindings now without
// `-D warnings` failing on variants no current call site builds yet.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    GitConflict,
    GitAuth,
    GitHook,
    NotARepo,
    Network,
    RateLimited,
    PtySpawn,
    CliMissing,
    ProfileAuth,
    Io,
    Internal,
    Validation,
    Conflict,
    NotFound,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    pub detail: Option<String>,
    pub recoverable: bool,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            detail: None,
            recoverable: false,
        }
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Io, message)
    }

    pub fn not_a_repo(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotARepo, message)
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Validation, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }
}

// ponytail: generic string errors (built by the existing `format!("...: {error}")` call
// sites) default to `Internal`; call sites that need `Validation`/`NotARepo`/`NotFound`/`Io`
// construct an `AppError` explicitly instead of relying on this fallback.
impl From<String> for AppError {
    fn from(message: String) -> Self {
        Self::internal(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        Self::internal(message.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::io(error.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        Self::internal(error.to_string())
    }
}

impl From<git2::Error> for AppError {
    fn from(error: git2::Error) -> Self {
        let kind = match error.code() {
            git2::ErrorCode::NotFound => ErrorKind::NotFound,
            git2::ErrorCode::Auth | git2::ErrorCode::Certificate => ErrorKind::GitAuth,
            _ => match error.class() {
                git2::ErrorClass::Net | git2::ErrorClass::Ssh | git2::ErrorClass::Http => {
                    ErrorKind::Network
                }
                _ => ErrorKind::Internal,
            },
        };
        Self::new(kind, error.message().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git2_not_found_error_maps_to_not_found_kind_and_serializes() {
        let git_error = git2::Error::new(
            git2::ErrorCode::NotFound,
            git2::ErrorClass::Reference,
            "missing ref",
        );
        let error: AppError = git_error.into();
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert_eq!(error.message, "missing ref");
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({
                "kind": "notFound",
                "message": "missing ref",
                "detail": null,
                "recoverable": false,
            })
        );
    }

    #[test]
    fn git2_auth_error_maps_to_git_auth_kind() {
        let git_error =
            git2::Error::new(git2::ErrorCode::Auth, git2::ErrorClass::Http, "auth failed");
        let error: AppError = git_error.into();
        assert_eq!(error.kind, ErrorKind::GitAuth);
    }

    #[test]
    fn io_error_maps_to_io_kind_and_serializes() {
        let io_error = std::io::Error::new(std::io::ErrorKind::NotFound, "missing file");
        let error: AppError = io_error.into();
        assert_eq!(error.kind, ErrorKind::Io);
        assert_eq!(error.message, "missing file");
        assert!(!error.recoverable);
        assert_eq!(error.detail, None);
    }
}
