//! Publish to GitHub (M6-09, GitHub issue #5): create a GitHub repository with a linked account,
//! set it as `origin`, and push the current branch. The first push is authenticated with the
//! selected account's token passed only through the git child's environment.
use crate::commit::{open_worktree, require_success, run_git};
use crate::error::AppError;
use crate::sync::current_branch;
use crate::worktree;
use serde::{Deserialize, Serialize};
use std::{ffi::OsStr, path::Path};

const MAX_DESCRIPTION_CHARS: usize = 350;
const EXTRAHEADER_KEY: &str = "http.https://github.com/.extraheader";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PublishOwnerKind {
    User,
    Organization,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PublishOwner {
    pub login: String,
    pub id: String,
    pub kind: PublishOwnerKind,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    pub account: String,
    pub owner: String,
    pub name: String,
    pub private: bool,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    /// `https://github.com/<owner>/<name>`.
    pub url: String,
    pub pushed: bool,
    /// Set when the repository was created but the first push failed (the repo is kept).
    pub push_error: Option<AppError>,
}

/// The clone URL GitHub returned must be exactly the repository we created, over HTTPS, with no
/// credentials, other host, or path.
pub(crate) fn validate_clone_url(url: &str, owner: &str, name: &str) -> Result<(), AppError> {
    let expected = format!("https://github.com/{owner}/{name}.git");
    if url.eq_ignore_ascii_case(&expected) {
        Ok(())
    } else {
        Err(AppError::validation(format!(
            "GitHub returned an unexpected repository URL: {url}"
        )))
    }
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(TABLE[((n >> shift) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The git config entry that authenticates HTTPS requests to github.com with `token`.
pub(crate) fn auth_header_config(token: &str) -> [(String, String); 1] {
    let credentials = base64(format!("x-access-token:{token}").as_bytes());
    [(
        EXTRAHEADER_KEY.to_owned(),
        format!("Authorization: Basic {credentials}"),
    )]
}

/// Config for the one authenticated push: the auth header and no credential helper (so a
/// rejected token can't make git erase the user's stored github.com credential). Trace output is
/// disabled by `worktree::invoke_git_with_extra_config`.
pub(crate) fn push_config(token: &str) -> Vec<(String, String)> {
    let mut config = auth_header_config(token).to_vec();
    config.push(("credential.helper".into(), String::new()));
    config
}

/// Whether the worktree has an `origin` remote (Publish is offered only without one).
pub(crate) fn has_origin(worktree_path: &Path) -> Result<bool, AppError> {
    let (_, repository) = open_worktree(worktree_path)?;
    Ok(repository.find_remote("origin").is_ok())
}

fn add_origin(root: &Path, repository: &git2::Repository, clone_url: &str) -> Result<(), AppError> {
    let output = run_git(
        root,
        &[
            OsStr::new("remote"),
            OsStr::new("add"),
            OsStr::new("origin"),
            OsStr::new(clone_url),
        ],
    )?;
    require_success(root, repository, "remote", output)
}

fn push_upstream(
    root: &Path,
    repository: &git2::Repository,
    extra: &[(String, String)],
) -> Result<(), AppError> {
    let filters = worktree::configured_checkout_filters(root)?;
    let args = ["push", "--set-upstream", "origin", "HEAD"].map(OsStr::new);
    let output = worktree::invoke_git_with_extra_config(root, &args, &filters, extra)?;
    require_success(root, repository, "push", output)
}

/// `git remote add origin <url>` then the first push with `extra` auth config (test seam for the
/// attach step of `publish_with`).
#[cfg(test)]
fn attach_and_push(
    root: &Path,
    clone_url: &str,
    extra: &[(String, String)],
) -> Result<(), AppError> {
    let (root, repository) = open_worktree(root)?;
    add_origin(&root, &repository, clone_url)?;
    push_upstream(&root, &repository, extra)
}

/// Validates the request and the worktree, creates the repository with `create` (returns the
/// clone URL), then attaches and pushes. A push failure after creation is reported in the result.
pub(crate) fn publish_with(
    worktree_path: &Path,
    request: &PublishRequest,
    create: impl FnOnce(&PublishRequest) -> Result<String, AppError>,
    token: &str,
) -> Result<PublishResult, AppError> {
    let owner = crate::gh::validate_name(&request.owner, "owner")?;
    let name = crate::gh::validate_name(&request.name, "repository name")?;
    if request.description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(AppError::validation(format!(
            "Description must be at most {MAX_DESCRIPTION_CHARS} characters"
        )));
    }
    let (root, repository) = open_worktree(worktree_path)?;
    if repository.find_remote("origin").is_ok() {
        return Err(AppError::validation(
            "This repository already has an origin remote",
        ));
    }
    crate::sync::require_first_commit(&repository, "publishing")?;
    current_branch(&repository, "publish")?;
    // GitHub receives exactly the validated values (it would turn "my-app " into `my-app-`).
    let cleaned = PublishRequest {
        account: request.account.clone(),
        owner: owner.clone(),
        name: name.clone(),
        private: request.private,
        description: request.description.trim().to_owned(),
    };
    let clone_url = create(&cleaned)?;
    // From here on the repository exists on GitHub: say so, or a retry hits "name already exists".
    let created = |mut error: AppError| {
        error.message = format!(
            "Created {owner}/{name} on GitHub, but it couldn't be connected: {}",
            error.message
        );
        error
    };
    validate_clone_url(&clone_url, &owner, &name).map_err(created)?;
    add_origin(&root, &repository, &clone_url).map_err(created)?;
    let push_error = push_upstream(&root, &repository, &push_config(token)).err();
    Ok(PublishResult {
        url: clone_url
            .strip_suffix(".git")
            .unwrap_or(&clone_url)
            .to_owned(),
        pushed: push_error.is_none(),
        push_error,
    })
}

const OWNERS_QUERY: &str = "query { viewer { id login organizations(first: 100) { nodes { id login viewerCanCreateRepositories } } } }";

const CREATE_MUTATION: &str = "mutation($name:String!,$ownerId:ID!,$visibility:RepositoryVisibility!,$description:String){ createRepository(input:{name:$name,ownerId:$ownerId,visibility:$visibility,description:$description}){ repository{ url } } }";

fn graphql_errors(value: &serde_json::Value) -> Option<AppError> {
    let message = value
        .get("errors")?
        .as_array()?
        .first()?
        .get("message")?
        .as_str()?;
    Some(AppError::validation(format!("GitHub: {message}")))
}

fn owners_for_token(token: &str) -> Result<Vec<PublishOwner>, AppError> {
    let value = crate::gh::graphql(token, OWNERS_QUERY, serde_json::json!({}))?;
    if let Some(error) = graphql_errors(&value) {
        return Err(error);
    }
    let viewer = &value["data"]["viewer"];
    let text = |node: &serde_json::Value, key: &str| node[key].as_str().map(str::to_owned);
    let mut owners = vec![PublishOwner {
        login: text(viewer, "login")
            .ok_or_else(|| AppError::internal("GitHub returned no login"))?,
        id: text(viewer, "id").ok_or_else(|| AppError::internal("GitHub returned no user id"))?,
        kind: PublishOwnerKind::User,
    }];
    for node in viewer["organizations"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if node["viewerCanCreateRepositories"] != true {
            continue;
        }
        if let (Some(login), Some(id)) = (text(node, "login"), text(node, "id")) {
            owners.push(PublishOwner {
                login,
                id,
                kind: PublishOwnerKind::Organization,
            });
        }
    }
    Ok(owners)
}

pub(crate) fn publish_owners(account: &str) -> Result<Vec<PublishOwner>, AppError> {
    owners_for_token(&crate::gh::account_token(account)?)
}

pub(crate) fn publish(
    worktree_path: &Path,
    request: &PublishRequest,
) -> Result<PublishResult, AppError> {
    let token = crate::gh::account_token(&request.account)?;
    let create = |request: &PublishRequest| -> Result<String, AppError> {
        let owner_id = owners_for_token(&token)?
            .into_iter()
            .find(|owner| owner.login.eq_ignore_ascii_case(&request.owner))
            .map(|owner| owner.id)
            .ok_or_else(|| {
                AppError::validation(format!(
                    "{} can't create repositories for {}",
                    request.account, request.owner
                ))
            })?;
        let value = crate::gh::graphql(
            &token,
            CREATE_MUTATION,
            serde_json::json!({
                "name": request.name,
                "ownerId": owner_id,
                "visibility": if request.private { "PRIVATE" } else { "PUBLIC" },
                "description": if request.description.is_empty() { None } else { Some(&request.description) },
            }),
        )?;
        if let Some(error) = graphql_errors(&value) {
            return Err(error);
        }
        value["data"]["createRepository"]["repository"]["url"]
            .as_str()
            .map(|url| format!("{url}.git"))
            .ok_or_else(|| AppError::internal("GitHub did not return the new repository URL"))
    };
    publish_with(worktree_path, request, create, &token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use std::{
        cell::Cell,
        fs,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "branchwork-m6-publish-{label}-{}-{id}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn repo_with_commit(label: &str) -> TestDir {
        let dir = TestDir::new(label);
        git(&dir.0, &["init", "-q", "-b", "main"]);
        git(&dir.0, &["config", "user.name", "Branchwork Test"]);
        git(&dir.0, &["config", "user.email", "test@example.com"]);
        fs::write(dir.0.join("a.txt"), "a\n").unwrap();
        git(&dir.0, &["add", "a.txt"]);
        git(&dir.0, &["commit", "-q", "-m", "first"]);
        dir
    }

    fn request() -> PublishRequest {
        PublishRequest {
            account: "octo".into(),
            owner: "octo".into(),
            name: "n".into(),
            private: true,
            description: String::new(),
        }
    }

    #[test]
    fn validate_clone_url_accepts_only_the_created_github_repo() {
        assert!(validate_clone_url("https://github.com/o/n.git", "o", "n").is_ok());
        for url in [
            "https://gitlab.com/o/n.git",
            "https://github.com/other/n.git",
            "https://github.com/o/other.git",
            "http://github.com/o/n.git",
            "https://u:p@github.com/o/n.git",
        ] {
            assert!(validate_clone_url(url, "o", "n").is_err(), "{url}");
        }
    }

    #[test]
    fn auth_header_config_never_contains_the_raw_token_in_the_key() {
        let [(key, value)] = auth_header_config("ghp_secret");
        assert_eq!(key, "http.https://github.com/.extraheader");
        assert!(!key.contains("ghp_secret"));
        assert_eq!(
            value,
            format!(
                "Authorization: Basic {}",
                base64(b"x-access-token:ghp_secret")
            )
        );
        assert_eq!(
            base64(b"x-access-token:ghp_secret"),
            "eC1hY2Nlc3MtdG9rZW46Z2hwX3NlY3JldA=="
        );
    }

    #[test]
    fn publish_refuses_existing_origin_no_commits_and_detached_head() {
        let called = Cell::new(false);
        let create = |_: &PublishRequest| -> Result<String, AppError> {
            called.set(true);
            Ok("https://github.com/octo/n.git".into())
        };

        let with_origin = repo_with_commit("origin");
        git(
            &with_origin.0,
            &["remote", "add", "origin", "https://github.com/x/y.git"],
        );
        let unborn = TestDir::new("unborn");
        git(&unborn.0, &["init", "-q", "-b", "main"]);
        let detached = repo_with_commit("detached");
        git(&detached.0, &["switch", "-q", "--detach", "HEAD"]);

        for dir in [&with_origin, &unborn, &detached] {
            let error = publish_with(&dir.0, &request(), create, "t").unwrap_err();
            assert_eq!(error.kind, ErrorKind::Validation, "{}", error.message);
        }
        assert!(!called.get());
    }

    #[test]
    fn failed_creation_adds_no_remote() {
        let dir = repo_with_commit("create-fails");

        let error = publish_with(
            &dir.0,
            &request(),
            |_| Err(AppError::validation("GitHub: name already exists")),
            "t",
        )
        .unwrap_err();

        assert!(error.message.contains("already exists"));
        assert_eq!(git(&dir.0, &["remote"]), "");
    }

    #[test]
    fn attach_and_push_sets_origin_and_upstream_without_persisting_the_header() {
        let dir = repo_with_commit("attach");
        let bare = TestDir::new("attach-bare");
        git(&bare.0, &["init", "-q", "--bare", "-b", "main"]);

        attach_and_push(
            &dir.0,
            bare.0.to_str().unwrap(),
            &auth_header_config("ghp_secret"),
        )
        .unwrap();

        assert_eq!(
            git(&bare.0, &["rev-parse", "main"]),
            git(&dir.0, &["rev-parse", "HEAD"])
        );
        assert_eq!(
            git(&dir.0, &["rev-parse", "--abbrev-ref", "main@{upstream}"]),
            "origin/main"
        );
        let config = fs::read_to_string(dir.0.join(".git/config")).unwrap();
        assert!(!config.contains("extraheader") && !config.contains("ghp_secret"));
    }

    #[test]
    fn push_failure_after_creation_reports_the_repo_kept_without_secrets() {
        let dir = repo_with_commit("push-fails");
        // Send github.com to a closed local port so the push fails without network access.
        git(
            &dir.0,
            &[
                "config",
                "url.https://127.0.0.1:1/.insteadOf",
                "https://github.com/",
            ],
        );

        let result = publish_with(
            &dir.0,
            &request(),
            |_| Ok("https://github.com/octo/n.git".into()),
            "ghp_secret",
        )
        .unwrap();

        assert!(!result.pushed);
        assert_eq!(result.url, "https://github.com/octo/n");
        let error = result.push_error.unwrap();
        let detail = format!("{} {}", error.message, error.detail.unwrap_or_default());
        assert!(
            !detail.contains("ghp_secret")
                && !detail.contains(&base64(b"x-access-token:ghp_secret"))
        );
        // The stored URL (get-url would apply the test's insteadOf rewrite).
        assert_eq!(
            git(&dir.0, &["config", "--get", "remote.origin.url"]),
            "https://github.com/octo/n.git"
        );
    }

    // Regression: the untrimmed name reached createRepository ("my-app " → GitHub's `my-app-`).
    #[test]
    fn create_receives_the_validated_trimmed_request() {
        let dir = repo_with_commit("trimmed");
        let mut raw = request();
        raw.name = " my-app ".into();
        raw.description = "  hello  ".into();
        let seen = std::cell::RefCell::new(None);

        let _ = publish_with(
            &dir.0,
            &raw,
            |cleaned| {
                *seen.borrow_mut() = Some((cleaned.name.clone(), cleaned.description.clone()));
                Err(AppError::validation("stop"))
            },
            "t",
        );

        assert_eq!(seen.into_inner(), Some(("my-app".into(), "hello".into())));
    }

    #[test]
    fn push_config_disables_the_credential_helper() {
        let config = push_config("t");
        assert!(config.contains(&("credential.helper".into(), String::new())));
        assert_eq!(config.len(), 2);
        assert_eq!(config[0].0, "http.https://github.com/.extraheader");
    }

    #[test]
    fn has_origin_reports_any_origin_including_non_github() {
        let dir = repo_with_commit("has-origin");
        assert!(!has_origin(&dir.0).unwrap());
        git(
            &dir.0,
            &["remote", "add", "origin", "https://gitlab.com/o/n.git"],
        );
        assert!(has_origin(&dir.0).unwrap());
    }

    // Regression (stage review): a failure after creation didn't say the repository exists.
    #[test]
    fn a_failure_after_creation_says_the_repository_was_created() {
        let dir = repo_with_commit("after-create");

        let error = publish_with(
            &dir.0,
            &request(),
            |_| Ok("https://github.com/someone-else/n.git".into()),
            "t",
        )
        .unwrap_err();

        assert!(
            error.message.starts_with("Created octo/n on GitHub"),
            "{}",
            error.message
        );
        assert_eq!(git(&dir.0, &["remote"]), "");
    }
}
