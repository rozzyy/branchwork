# Local Project Init & Publish — Design

**Date:** 2026-11-13 · **Origin:** GitHub issue #5 · **Status:** awaiting user approval (builder check done)

## Intent

Starting a new project is common: a fresh folder that isn't a Git repository yet, which later
becomes a repo and then a GitHub repo. Today Branchwork rejects any folder that isn't already a
Git repository ("Couldn't open repository"), so the user has to leave the app to `git init` and
to create the GitHub repo. The user wants this lifecycle — **new folder → Git repo → GitHub
repo** — handled inside Branchwork as normal behavior.

Findings that shaped the design:

- A local Git repo **without** a remote or GitHub already opens today (`repository_open` only
  checks `Repository::open`). Issue #5's "requires GitHub" applies only to non-Git folders.
- Every screen (terminal, agents, Changes, Files, Blame, Graph) and every path-taking IPC command
  works on a *registered Git worktree* (`status::validate_catalog_worktree`). Supporting non-Git
  folders as projects would mean changing that model and its security checks app-wide.

## Goals

1. Opening / adding a folder that isn't a Git repository offers to initialize Git there, then the
   folder becomes a normal project in the sidebar.
2. A freshly initialized repository with **no commits yet** works in the app: sidebar, Changes
   (stage + first commit), Files, terminal and agents work; Graph / Blame / history show a clear
   empty state instead of an error.
3. A project with no GitHub remote can be **published to GitHub** from the app: create the
   repository on GitHub with a linked account, set it as `origin`, and push the current branch.

## Non-goals

- Projects that stay non-Git inside Branchwork (issue #5's literal "non-Git projects"); the user
  chose to initialize on add (Approach A).
- Publishing to hosts other than GitHub, or into an existing GitHub repository.
- Creating the initial commit automatically, generating `.gitignore` / README / license
  templates.
- Changes to Clone or to repositories that already exist.

## Anti-goals (a failure even if it "works")

- Running `git init` without explicit confirmation, or inside a folder that is already part of
  another repository (e.g. a subfolder of an existing repo) — that silently creates a nested repo.
- Publishing as **public** without the user choosing it.
- Pushing anything before the user has made a commit, or committing files on their behalf.
- Weakening path validation (the catalog/worktree checks stay the gate for every path IPC).

## Constraints

- Tauri 2 + Rust backend, React/TS UI; typed IPC via specta; all UI strings in `src/i18n/en.ts`.
- Git writes go through the user's git CLI with their config (`commit::run_git`, argv only);
  reads via git2. `git init` must respect the user's `init.defaultBranch`.
- GitHub calls use the existing Keychain-backed accounts and REST/GraphQL helpers in `gh.rs`; the
  device-flow scope already includes `repo`, which permits creating repositories.
- Bounded inputs: repo names validated with GitHub's rules (`gh::validate_name`), description
  length capped; no URL from the API is navigated to without the existing allowlist.
- Project rules (`CLAUDE.md`): staged delivery with spec/code/security review and a manual
  checkpoint; no over-engineering; tests only as task files specify.

## Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | **Initialize on add.** Adding a non-Git folder shows "This folder isn't a Git repository. Initialize Git here?" → `git init` → normal project. A separate "Publish to GitHub" action creates the remote later. | Every screen keeps working on the existing worktree model; no path-validation redesign. The folder can't stay non-Git inside the app (not needed for this workflow). Needs empty-repo (no commits) states. |
| B | **True non-Git projects.** Folder enters without Git; terminal/agents work; Git screens show "Initialize Git". | Matches issue #5 literally, but requires redefining the project "working path" and the backend path validation across almost every screen and IPC command — a full stage with security review, for a phase the user's workflow passes through quickly. |

The user picked **A** (2026-11-13): their workflow always ends in Git + GitHub, so deferring
`git init` buys little, while B is much larger and riskier.

## Design

### 1. Initialize on add

- `repository_open` keeps its behavior for repos. Before any dialog, the UI asks the backend to
  classify the picked folder (one read-only IPC, e.g. extending `path_is_repository` to return
  `repository` / `insideRepository { root }` / `notRepository` / `invalid`):
  - `repository` → open as today;
  - `notRepository` → confirm dialog (both "Open" and "Add repository" in the group switcher):
    title "Initialize Git in <folder>?", body naming the folder path, OK "Initialize Git";
  - `insideRepository` → no init offer; message "This folder is inside the repository <root>"
    with **Open that repository** (opens the root) *(builder call, see Decisions)*;
  - `invalid` (e.g. a broken or partial `.git`) → error toast with details; never re-initialized.
- New IPC `repository_init(path)`:
  - path must be absolute, an existing directory, not inside an existing repository (git2
    discover from the folder finds no repo), and not the home directory or filesystem root;
  - runs `git init` via the user's git CLI (so `init.defaultBranch` applies), then registers the
    project exactly like `repository_open` and returns it.
- Cancel leaves nothing behind. Errors show the existing "Show details" toast.

### 2. Repositories with no commits ("unborn" HEAD)

- The worktree list reports the main worktree with its branch name (from HEAD's symbolic
  target) and no head commit.
- Changes: staging and **Commit** create the first commit (already supported by `commit.rs`'s
  unborn handling; verify end to end). Undo of that first commit is not offered (existing rule).
- Graph, Blame, history, compare-style reads return an empty result (not an error); the Graph
  shows an empty state: "No commits yet — make your first commit in Changes."
- Files, terminal, and agents need nothing new beyond the worktree list working.

### 3. Publish to GitHub

- Shown when the active project has **no `origin` remote**: a "Publish to GitHub" action in the
  Repository screen's empty/no-remote state and in the Changes ⋯ menu.
- Dialog fields: account (linked GitHub accounts; default the active one), owner (the account's
  login or one of its organizations), repository name (default: folder name, validated),
  visibility (**Private** default, Public selectable), optional description.
- Disabled with an explanation until the current branch has at least one commit.
- New IPC `gh_repo_publish(worktree, account, owner, name, private, description)`:
  1. validate inputs; refuse if `origin` already exists;
  2. create the repository via GitHub REST (`POST /user/repos` or `/orgs/{org}/repos`);
  3. `git remote add origin <clone URL>` (HTTPS URL from the API response, validated to be a
     `https://github.com/<owner>/<name>.git` URL);
  4. `git push --set-upstream origin HEAD` **authenticated with the selected account's token for
     this one push** (user decision 2026-11-13), so a multi-account user's push matches the
     account that created the repo. The token reaches git only through the child process
     environment (e.g. `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` setting an
     `http.https://github.com/.extraheader`, or a `GIT_ASKPASS` helper reading an env var) —
     never in the remote URL, argv, stored config, logs, error `detail`, or UI state. `origin`
     stays a plain HTTPS URL; later pushes use the user's normal credential helper. Errors still
     map to the typed GitAuth / Network / GitHook kinds. This step requires a security review.
  If step 2 succeeds but 3–4 fail, report it clearly (repo exists on GitHub; retry push from
  Graph/Changes) — never delete the created repository automatically.
- On success: toast with "Open on GitHub", repo caches invalidated so the Repository screen
  picks up the new remote.

## Left to the builder

- Exact IPC/module placement (e.g. `repository.rs` for init, `gh.rs` for publish), type names,
  and how the empty state is detected per screen.
- Whether the init confirm lives in `repos.ts` or the group switcher, as long as both entry
  points share it.
- Org listing for the owner picker (reuse an existing call or add a bounded `GET /user/orgs`).
- Test selection per task file (Rust temp-repo tests for init/unborn/publish-remote wiring with
  the GitHub API mocked; Vitest for dialogs and empty states), and stage split.

## Delivery (user decision 2026-11-13)

Inserted into M6 as **Stage 3 — Local project init & publish**, after Checkpoint M6.2 (the
Conflicts screen). Interactive rebase moves to Stage 4 and Compare worktrees to Stage 5; task
numbering continues the M6 series after M6-06, and the plan file is updated accordingly. It
ships with `v0.6.0` (no separate release). Branch `m6-stage-3`; stage review includes a
security review (token handling for the first push, `git init` path checks).

## Decisions

User:
- Approach A — initialize on add (no non-Git projects).
- First publish push uses the selected account's token via the child environment only.
- Delivered as M6 Stage 3, shipping in `v0.6.0`.

Builder calls (made by the designer; correct if wrong):
- Folder inside an existing repo → offer to open the enclosing repo instead of init; broken
  `.git` → error, never re-init.
- Publish defaults: Private visibility, repo name = folder name, active account preselected.
- No automatic initial commit or templates; Publish stays disabled until a first commit exists.
- If GitHub creation succeeds but remote/push fails, keep the GitHub repo and say how to retry.
