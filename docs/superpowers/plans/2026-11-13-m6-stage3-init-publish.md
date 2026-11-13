# M6 Stage 3 — Local Project Init & Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-Git folder be added as a project (with confirmed `git init`), make repos with no commits usable, and publish a project to a new GitHub repository with the selected account.

**Architecture:** Three tasks on the existing worktree model: a folder classifier + `repository_init` IPC; "unborn HEAD" tolerance in the worktree / graph / history read paths plus a Graph empty state; a `gh_repo_publish` flow (GraphQL `createRepository` → `git remote add origin` → first push authenticated with the account token passed only through the git child environment).

**Tech Stack:** Tauri 2, Rust (git2 0.21, git CLI via `commit::run_git`, curl-based `gh.rs`), React/TS + Vitest, specta bindings.

**Spec:** `docs/superpowers/specs/2026-11-13-local-project-init-publish-design.md`

## Global Constraints

- Project rules (`CLAUDE.md`): one feature at a time; no per-task commits (Commit steps are `_(skipped: no-commit rule)_`); one stage commit on `m6-stage-3` after Checkpoint M6.3 is approved; never push unless ordered.
- Task files `.agent/tasks/m6-task-07..09-*.md` are written from this plan when the stage starts; `feature_list.json` gets entries `m6-task-07-init-on-add`, `m6-task-08-unborn-repos`, `m6-task-09-publish-github`.
- All UI strings in `src/i18n/en.ts`. Typed IPC via specta; regenerate `src/ipc/bindings.ts` with `cargo test --lib -- --ignored regenerate_bindings_file`.
- Git writes via the user's git CLI with their config (`commit::run_git` / `worktree::invoke_git_allowing_hooks`), argv only, `--` before paths. `git init` must honor `init.defaultBranch`.
- Every path IPC stays behind `status::validate_catalog_worktree` (the new `repository_init` / `repository_classify` take a folder, not a worktree — they validate absolute/existing/not-home/not-root themselves).
- Publish defaults: **Private**, name = folder name (sanitized), active account preselected. Never push before a first commit; never commit for the user; never delete a created GitHub repo.
- The publish token reaches git **only** via the child environment (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`); never in argv, remote URL, stored config, logs, `AppError.detail`, or UI state. `GIT_TRACE*` / `GIT_CURL_VERBOSE` are removed from that child's environment.
- `./init.sh` green after every task; stage review = code + security (token handling, init path checks) + E2E; manual spec appended to `docs/testing/m6-manual-e2e.md` as Stage 3 (M6-S3-NN).

## Review Focus

- Picking the home directory or `/` as the folder → refused with Validation, never `git init` (test in Task 1).
- A folder name with spaces or non-ASCII (e.g. `My App`, `café`) → the default repo name is sanitized to a valid GitHub name (`My-App`, `caf`), not rejected on open (test in Task 3).
- The repo name already exists on GitHub (API error) → clear error, **no** `origin` added, nothing pushed (test in Task 3).
- Publish on a repo with no commits or a detached HEAD → refused by the backend with Validation even if the UI is bypassed (test in Task 3).
- "Create worktree" on a project with no commits → clear Validation ("Make a first commit before creating worktrees"), not an internal git error (test in Task 2).

---

### Task 1 (M6-07): Initialize on add

**Files:**
- Modify: `src-tauri/src/repository.rs` (add `FolderKind`, `classify_folder`, `init_and_register`)
- Modify: `src-tauri/src/lib.rs` (commands `repository_classify`, `repository_init`; register)
- Modify: `src/ipc/catalog.ts` (`classifyFolder`, `initRepository`), `src/state/repos.ts` (`openRepo` flow), `src/shell/GroupSwitcher.tsx` (both entry points use the store flow unchanged), `src/i18n/en.ts`
- Test: `src-tauri/src/repository.rs` tests module; `src/state/repos.test.ts`

**Interfaces:**
- Produces (Rust): `#[serde(tag = "kind", rename_all = "camelCase")] pub enum FolderKind { Repository, InsideRepository { root: String }, NotRepository, Invalid { message: String } }`; `pub fn classify_folder(path: &Path) -> Result<FolderKind, AppError>`; `pub fn init_and_register(path: &Path, store: &Store) -> Result<Project, AppError>`.
- Produces (IPC/TS): `repository_classify(path: String) -> FolderKind`, `repository_init(path: String) -> Project`; `classifyFolder(path): Promise<FolderKind>`, `initRepository(path): Promise<Project>`.
- Consumes: `repository::open_and_register`, `expand_home`, `commit::run_git`-style CLI invocation (`worktree::invoke_git_allowing_hooks` with empty filters).

- [ ] **Step 1: Write the failing Rust tests** in `repository.rs` tests:
  - `classify_folder_reports_repository_inside_not_repository_and_invalid`: repo root → `Repository`; `root/sub` (existing dir) → `InsideRepository { root }` (canonical root path); plain temp dir → `NotRepository`; dir containing a file named `.git` with garbage → `Invalid { .. }`.
  - `init_and_register_creates_repo_with_default_branch_and_registers_project`: plain dir → after init, `git symbolic-ref HEAD` equals the value a plain `git init` gives in a sibling temp dir under the same environment (proves the user's `init.defaultBranch` path is used, without mutating process-wide env); returned `Project.local_path` canonical; `store.project_by_path` finds it.
  - `init_refuses_home_root_inside_repo_and_existing_repo`: `/` → Validation; `$HOME` → Validation; `root/sub` of a repo → Validation; an existing repo → Validation ("already a Git repository"); none of them gain a `.git`.
- [ ] **Step 2: Run** `cd src-tauri && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 cargo test --lib repository::` — Expected: FAIL (functions not defined).
- [ ] **Step 3: Implement** `classify_folder` (absolute + existing dir required; `Repository::open` → `Repository` (bare → `Invalid`); else `Repository::discover` from the folder finds a workdir → `InsideRepository`; `.git` present but unopenable → `Invalid`; else `NotRepository`) and `init_and_register` (refuse unless `classify_folder == NotRepository`, path ≠ `/`, path ≠ home; run `git init` via the user-config CLI; then `open_and_register`).
- [ ] **Step 4: Run** the Step 2 command — Expected: PASS. Register commands in `lib.rs`, regenerate bindings.
- [ ] **Step 5: Write the failing Vitest** in `src/state/repos.test.ts`:
  - `openRepo initializes a non-Git folder after confirmation`: `classifyFolder` → `{kind:"notRepository"}`, `ask` resolves `true` → `initRepository("/p")` called, project added and active.
  - `openRepo does nothing when initialization is cancelled`: `ask` → `null` → `initRepository` not called, no toast error.
  - `openRepo offers the enclosing repository instead of init`: `{kind:"insideRepository", root:"/r"}`, `ask` → `true` → `openRepository("/r")` called, `initRepository` not called.
- [ ] **Step 6: Implement** in `repos.ts` `openRepo(path)`: classify → `repository` → existing open; `notRepository` → `ask({title: t("repos.initTitle",{folder}), body: t("repos.initBody",{path}), ok: t("repos.initOk")})` → `initRepository`; `insideRepository` → `ask({title: t("repos.insideTitle",{root}), ok: t("repos.insideOk")})` → open root; `invalid` → error toast with `details`. Strings: `repos.initTitle` "Initialize Git in {folder}?", `repos.initBody` "{path} isn't a Git repository yet. Branchwork will run git init here; nothing is committed.", `repos.initOk` "Initialize Git", `repos.insideTitle` "This folder is inside the repository {root}", `repos.insideOk` "Open that repository".
- [ ] **Step 7: Run** `pnpm exec vitest run src/state/repos.test.ts` then `./init.sh` — Expected: PASS / `=== Verification Complete ===`.
- [ ] **Step 8: Commit** _(skipped: no-commit rule)_.

### Task 2 (M6-08): Repositories with no commits

**Files:**
- Modify: `src-tauri/src/worktree.rs` (`read_metadata`, ahead/behind, `create_from` guard), `src-tauri/src/graph.rs` (`read` on unborn), `src-tauri/src/blame.rs` (`file_history` on unborn)
- Modify: `src/screens/graph/GraphScreen.tsx`, `src/i18n/en.ts`
- Test: tests modules of those Rust files; `src/screens/graph/GraphScreen.test.tsx`

**Interfaces:**
- Produces: `Worktree.head == ""` (empty string, type unchanged) means "no commits yet"; `ahead`/`behind` 0. `graph::read` returns `GraphPage { commits: [], has_more: false, .. }` with `wip` populated. `file_history` returns `[]`.
- Consumes: Task 1's `init_and_register` (manual flow only; tests use `git init` directly).

- [ ] **Step 1: Write failing Rust tests:**
  - `worktree::tests::lists_a_repository_with_no_commits`: `git init -b main` + an untracked file → `list`/summary returns one worktree with `branch == Some("main")`, `head == ""`, `ahead == 0`, `behind == 0`, `dirty_count == 1`.
  - `worktree::tests::create_worktree_requires_a_first_commit`: create on that repo → Validation with message containing "first commit".
  - `graph::tests::graph_of_a_repository_with_no_commits_is_empty`: `read(page 0)` → `commits.is_empty()`, `!has_more`, `wip.branch == Some("main")`.
  - `blame::tests::history_of_a_repository_with_no_commits_is_empty`: `file_history` for a staged new file → `Ok([])`.
  - `commit::tests::first_commit_in_an_empty_repository_succeeds`: stage + `commit()` → HEAD exists; latest oplog row not undoable.
- [ ] **Step 2: Run** `cd src-tauri && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 cargo test --lib -- worktree::tests::lists_a_repository graph::tests::graph_of blame::tests::history_of commit::tests::first_commit worktree::tests::create_worktree_requires` — Expected: FAIL.
- [ ] **Step 3: Implement:** in `read_metadata`, treat `ErrorCode::UnbornBranch` as branch = HEAD's symbolic target shorthand, head = `""`, ahead/behind 0; guard `create_from` with Validation "Make a first commit before creating worktrees"; in `graph::read` / `file_history`, return empty on `UnbornBranch` / empty revwalk instead of erroring.
- [ ] **Step 4: Run** Step 2 — Expected: PASS.
- [ ] **Step 5: Write failing Vitest** `GraphScreen.test.tsx` → `shows an empty state for a repository with no commits`: page with `commits: []`, `hasMore: false` → text "No commits yet — make your first commit in Changes." and a button "Open Changes" that calls `useStage.go("changes")`.
- [ ] **Step 6: Implement** the empty state in `GraphView` (strings `graph.noCommitsYet`, `graph.openChanges`); Fetch/Pull/Push stay enabled (they fail with typed errors if no remote).
- [ ] **Step 7: Run** the Vitest file, then `./init.sh` — Expected: PASS / `=== Verification Complete ===`.
- [ ] **Step 8: Commit** _(skipped: no-commit rule)_.

### Task 3 (M6-09): Publish to GitHub

**Files:**
- Create: `src-tauri/src/publish.rs` (validation, owner list, create, attach + first push)
- Modify: `src-tauri/src/worktree.rs` (`invoke_git_with_extra_config`), `src-tauri/src/gh.rs` (expose `account_token`, `graphql`, `validate_name` as `pub(crate)`), `src-tauri/src/lib.rs` (commands `gh_publish_owners`, `gh_repo_publish`)
- Create: `src/screens/repo/PublishDialog.tsx` (+ `PublishDialog.test.tsx`)
- Modify: `src/ipc/repo.ts`, `src/screens/repo/RepoScreen.tsx` (no-remote state entry), `src/screens/changes/ChangesScreen.tsx` (⋯ menu entry), `src/i18n/en.ts`

**Interfaces:**
- Produces (Rust): `pub struct PublishOwner { login: String, id: String, kind: PublishOwnerKind /* user | organization */ }`; `pub struct PublishRequest { account: String, owner: String, name: String, private: bool, description: String }`; `pub struct PublishResult { url: String, pushed: bool, push_error: Option<AppError> }`; `pub(crate) fn sanitize_repo_name(folder: &str) -> String`; `pub(crate) fn validate_clone_url(url: &str, owner: &str, name: &str) -> Result<(), AppError>`; `pub(crate) fn auth_header_config(token: &str) -> [(String, String); 1]` (key `http.https://github.com/.extraheader`, value `Authorization: Basic <base64("x-access-token:" + token)>`); `pub(crate) fn attach_and_push(root: &Path, clone_url: &str, extra: &[(String, String)]) -> Result<(), AppError>`; `pub(crate) fn publish_with(worktree: &Path, req: &PublishRequest, create: impl FnOnce(&PublishRequest) -> Result<String /*clone url*/, AppError>, token: &str) -> Result<PublishResult, AppError>`.
- Produces (worktree.rs): `pub(crate) fn invoke_git_with_extra_config(root: &Path, args: &[&OsStr], filters: &HashSet<String>, extra: &[(String, String)]) -> Result<Output, AppError>` — appends `extra` after the filter entries in `GIT_CONFIG_*`, removes `GIT_TRACE`, `GIT_TRACE_CURL`, `GIT_TRACE_PACKET`, `GIT_CURL_VERBOSE`.
- Produces (IPC/TS): `gh_publish_owners(account) -> PublishOwner[]` (GraphQL `viewer { id login organizations(first: 100) { nodes { id login viewerCanCreateRepositories } } }`, orgs filtered by `viewerCanCreateRepositories`); `gh_repo_publish(worktree_path, request) -> PublishResult` (GraphQL `createRepository(input: { name, ownerId, visibility, description })` → `repository { url sshUrl }`; clone URL = `url + ".git"`).
- Consumes: `commit::open_worktree`, `sync::current_branch`, `worktree::configured_checkout_filters`, `commit::require_success`, `gh::account_token`, `gh::graphql`, `gh::validate_name`; frontend `runGitAction`-style toasts from `src/state/gitActions.ts`.

- [ ] **Step 1: Write failing Rust tests** in `publish.rs`:
  - `sanitize_repo_name_makes_valid_github_names`: `"My App"` → `"My-App"`; `"café"` → `"caf"`; `"..x"` → `"x"`; `""` → `"project"`; result passes `validate_name`.
  - `validate_clone_url_accepts_only_the_created_github_repo`: ok for `https://github.com/o/n.git`; err for other host, other owner/name, `http://`, embedded credentials `https://u:p@github.com/o/n.git`.
  - `auth_header_config_never_contains_the_raw_token_in_the_key`: key == `http.https://github.com/.extraheader`; value starts with `Authorization: Basic ` and base64-decodes to `x-access-token:<token>`.
  - `publish_refuses_existing_origin_no_commits_and_detached_head`: each → Validation, `create` closure never called.
  - `failed_creation_adds_no_remote`: `create` returns `Err(AppError::validation("name already exists"))` → error propagated; `git remote` output empty.
  - `attach_and_push_sets_origin_and_upstream`: local bare repo as clone URL (`file://` path, `validate_clone_url` bypassed by calling `attach_and_push` directly) with a dummy extra header → bare has the branch; `branch@{upstream}` == `origin/<branch>`; `git config --get-regexp extraheader` empty (nothing persisted).
  - `push_failure_after_creation_reports_repo_kept`: `create` returns an unreachable `https://github.com/o/n.git`-shaped URL served by a closed port via `url.<…>.insteadOf` in repo-local config → `PublishResult { pushed: false, push_error: Some(_) }`, `origin` set, no secret in `push_error.detail`.
- [ ] **Step 2: Run** `cd src-tauri && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 cargo test --lib publish::` — Expected: FAIL.
- [ ] **Step 3: Implement** `invoke_git_with_extra_config`, then `publish.rs` per the Interfaces block (`publish_with` order: validate name/owner/description ≤ 350 chars → refuse if `origin` exists → `current_branch` (detached → Validation) → HEAD must have a commit → `create` → `validate_clone_url` → `attach_and_push`; push errors become `push_error`, others propagate), and the two commands (`gh_repo_publish` resolves `account_token`, builds `create` from `graphql`, invalidates repo caches, emits `op:done`).
- [ ] **Step 4: Run** Step 2 — Expected: PASS. Regenerate bindings; `cargo clippy --all-targets -- -D warnings` clean.
- [ ] **Step 5: Write failing Vitest** `PublishDialog.test.tsx`:
  - `defaults to private with the sanitized folder name and the active account`.
  - `is disabled with an explanation when the branch has no commits` (worktree `head: ""`).
  - `publishes and offers Open on GitHub`: submit → `ghRepoPublish(path, {account, owner, name:"My-App", private:true, description:""})`; success toast action "Open on GitHub" calls the existing `gh_open_repo(owner, name)` route.
  - `reports a kept repository when the first push fails`: result `{pushed:false, pushError:{…}}` → toast says the repository was created and to retry Push, with "Show details".
- [ ] **Step 6: Implement** `PublishDialog` (account select from linked accounts, owner select from `ghPublishOwners`, name input, Private/Public segmented control, description), entry points in `RepoScreen` (when `gh_repo_remote` reports no remote) and Changes ⋯ menu ("Publish to GitHub…", shown only without `origin`). Strings: `publish.title` "Publish to GitHub", `publish.private` "Private", `publish.public` "Public", `publish.needsCommit` "Make a first commit before publishing.", `publish.done` "Published to {owner}/{name}", `publish.pushFailed` "Created {owner}/{name} on GitHub, but the first push failed. Retry with Push.".
- [ ] **Step 7: Run** the Vitest file and `./init.sh` — Expected: PASS / `=== Verification Complete ===`.
- [ ] **Step 8: Commit** _(skipped: no-commit rule)_.

### Stage close

- [ ] Code review + security review (token env handling, no persistence, init path checks) + E2E report in `.agent/reviews/m6-stage-3-*.md`.
- [ ] Append "Stage 3 — Local project init & publish (Checkpoint M6.3)" to `docs/testing/m6-manual-e2e.md`: init a new folder; refuse `~`; inside-repo offer; first commit from Changes; Graph empty state; publish private with a second account; publish name collision; push failure retry.
- [ ] 🛑 Stop at Checkpoint M6.3 for the user.
