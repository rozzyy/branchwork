# Branchwork: Design Spec

- **Date:** 2026-11-06
- **Status:** Approved design, ready for implementation planning
- **Product name:** "Branchwork" is a working name; it can be renamed without affecting the design.
- **Default UI language:** English. All user-facing strings are written in English and live in a single string catalog (`src/i18n/en.ts`). Other locales are out of scope for v1.
- **Visual reference:** `docs/design/prototype.html`; Terminal screen: `docs/design/terminal-mockup.html`. This is an interactive, self-contained HTML prototype; open it in a browser. Its copy is in Indonesian because it was written during brainstorming. The product UI is English. When the prototype and this spec disagree, this spec wins.

---

## 1. Summary

Branchwork is a macOS desktop Git client for developers who work across **multiple worktrees and branches at once**, often alongside **CLI coding agents** such as Claude Code, Codex, OpenCode, and Gemini CLI. It combines:

1. Multi-worktree and branch management.
2. A commit graph.
3. Real terminals that open anywhere in the app.
4. GitHub integration.
5. Pull request and GitHub-style repository views.

It adds VS Code–style source control, a code editor and file manager, agent sessions with account profiles and handover, project groups, Arc-style split view, and a command palette.

### Goals

- Make "many worktrees, many agents, one repo" a first-class workflow.
- Keep agents **CLI-native**. Branchwork hosts the real CLI in a PTY and never re-implements an agent UI.
- Be keyboard-first. Every action is reachable from the command palette.
- Make destructive Git operations safe: confirm them, and allow undo where Git allows it.
- Look and feel native on macOS. Liquid Glass styling uses translucent sidebar and toolbar over a solid content surface.

### Non-goals (v1)

- Windows and Linux builds. The architecture must not block them, but they are not shipped.
- GitLab, Bitbucket, and Azure DevOps.
- Graph "Metro" and "Canvas" alternate views. These appeared in the prototype as tabs only.
- GitHub Projects, Wiki, Security, and Insights tabs.
- Real-time collaboration and presence avatars. Presence in the prototype is decorative.
- A custom agent chat UI.

---

## 2. Approaches considered

| Option | Summary | Verdict |
|---|---|---|
| **A. Tauri 2 (Rust) + React/TS web UI** | Small binary, native PTY and Git in Rust, strong IPC, macOS vibrancy via window effects | **Chosen** |
| B. Electron + Node | Most mature ecosystem (node-pty, xterm.js), but heavy memory and binary size, and Git/PTY run in JS | Rejected |
| C. Web UI + local daemon | Browser UI talks to a local agent | Rejected: worse native feel, extra install step, harder auth |

### Frontend framework

React 19 + TypeScript + Vite. React has the largest component and testing ecosystem for the complex pieces (CodeMirror 6 bindings, xterm.js, virtualization) and is what most contributors know. Svelte was considered (GitButler uses it), but it adds no decisive benefit here.

### Git engine

Branchwork uses a hybrid engine:

- **Reads** (status, log, graph, diff, blame, refs, worktree list) go through `git2` (libgit2) for speed and structured data.
- **Writes** go through the user's `git` CLI. This covers commit, push, pull, fetch, merge, rebase, cherry-pick, revert, stash, and `worktree add`/`remove`. Using the CLI respects hooks, credential helpers, signing (GPG/SSH), and `.gitconfig` exactly as the terminal would.

---

## 3. Architecture

```
┌──────────────────────────── Tauri app (single window) ─────────────────────────────┐
│  WebView (React)                                                                   │
│  ┌─────────── Shell ───────────┐  ┌──────────────── Stage (1–2 panes) ───────────┐ │
│  │ Title bar: group switcher,  │  │ Pane = { screen, toolbar, view }             │ │
│  │ project tabs, ⌘K, theme     │  │ Screens: Launchpad, Graph, Files, Changes,   │ │
│  │ Sidebar: nav, pinned        │  │ Agents, PRs, Repository, Inbox, Conflicts,   │ │
│  │ worktrees, tools, stashes   │  │ Rebase, Blame, Compare, Settings             │ │
│  └─────────────────────────────┘  └──────────────────────────────────────────────┘ │
│  Terminal dock (bottom | right | float | max)  ·  Palette  ·  Dialogs  ·  Toasts   │
│        ▲ invoke(cmd)  ▼ events (git:changed, pty:data, session:status, gh:*)       │
├────────────────────────────────────────────────────────────────────────────────────┤
│  Rust core                                                                         │
│  git::{read (git2), write (git CLI), graph, diff, blame, worktree, conflicts}      │
│  pty::{manager (portable-pty), sessions}    agents::{registry, profiles, detect}   │
│  github::{auth (device flow), rest/graphql (octocrab), poller, cache}              │
│  store::{sqlite (rusqlite)}   secrets::{keychain (keyring)}   watch::{notify}      │
│  ai::{claude_cli | anthropic_api}   undo::{oplog}                                  │
└────────────────────────────────────────────────────────────────────────────────────┘
        │ git CLI   │ PTY children: zsh, claude, codex, …   │ HTTPS api.github.com
```

### 3.1 Process model

There is one Tauri process. Child processes are git CLI invocations (short-lived) and PTY sessions (long-lived: shells and agent CLIs). Each PTY session is owned by `pty::manager` and survives switching screens. It is killed only when the user closes it or quits the app; quitting asks for confirmation if any agent is running.

### 3.2 Frontend modules (`src/`)

| Module | Responsibility |
|---|---|
| `shell/` | Window chrome, sidebar, group switcher, project tabs, worktree pin list |
| `stage/` | Router, split view (panes, divider, drop zones), pane toolbar controls |
| `screens/<name>/` | One folder per screen. Each exports `{ Toolbar, View }` and owns its local state |
| `terminal/` | xterm.js wrapper, dock modes, tabs, split, shared `CliPane` component |
| `agents/` | Session list and grid, layout (left/right/full), account chip, handover and race dialogs |
| `diff/` | Shared diff model renderer (side-by-side, inline, intraline, hunks, ruler). Used by Changes, Files, PR, and Compare |
| `editor/` | CodeMirror 6 setup, git gutter, language modes |
| `ui/` | Design system: tokens, Button, Chip, Menu, Dialog (`ask`), Toast, Palette, Kbd |
| `ipc/` | Typed wrappers around Tauri `invoke` and event subscriptions (generated types) |
| `state/` | Zustand stores: `app` (panes, focus, theme), `repo` (active group/project/worktree), `sessions`, `github` (TanStack Query) |
| `i18n/` | `en.ts` string catalog plus a `t()` helper |

Screens never call each other's internals. They communicate through stores and IPC events, which keeps each screen testable alone.

### 3.3 IPC contract (Rust ⇄ UI)

Commands are request/response and return `Result<T, AppError>`. Events are push-based. TypeScript types are generated from Rust using `specta` + `tauri-specta`, so the contract cannot drift.

**Representative commands:**
- **Repo:** `repo_open`, `repo_clone`, `worktree_list`, `worktree_add`, `worktree_remove`, `worktree_prune`
- **Git reads:** `status`, `log_graph(page)`, `commit_detail`, `diff_file(area)`, `blame(path)`, `file_history(path)`
- **Git writes:** `stage_paths`, `stage_hunks`, `stage_lines`, `unstage_*`, `discard_*`, `commit(opts)`, `push`, `pull`, `fetch`, `checkout`, `branch_create`, `cherry_pick`, `revert`, `stash_*`, `merge_abort`, `conflict_resolve(path, choices)`, `rebase_interactive(plan)`, `undo_last`
- **Files:** `fs_tree`, `fs_read`, `fs_write`, `fs_create`, `fs_rename`, `fs_delete` (moves to Trash), `reveal_in_finder`, `open_external(editor)`
- **Terminal:** `pty_spawn(cwd, cmd, env)`, `pty_write`, `pty_resize`, `pty_kill`
- **Agents:** `agent_start(cli, worktree, profile, prompt?)`, `agent_switch_profile(session, profile)`, `agent_handover(session, target, where, note)`, `agent_race(prompt, clis[])`
- **Profiles:** `profile_list`, `profile_create(cli, name)` (opens a login PTY), `profile_logout`
- **GitHub:** `gh_auth_start` (device flow), `gh_auth_status`, `gh_prs`, `gh_pr_detail`, `gh_pr_review`, `gh_pr_merge`, `gh_issues`, `gh_actions`, `gh_rerun`, `gh_notifications`
- **Store:** `groups_*`, `projects_*`, `pins_*`, `settings_get`, `settings_set`

**Events:** `git:changed{worktree}` (debounced file watcher), `pty:data{session}`, `pty:exit`, `session:status{session, status}`, `gh:updated{kind}`, `op:done{undoable}`.

### 3.4 Persistence

- **SQLite** lives at `~/Library/Application Support/Branchwork/app.db`. Tables: `groups`, `projects`, `worktree_pins`, `sessions` (metadata only, used to restore session tabs on relaunch), `settings`, `oplog`.
- **Secrets** go in the macOS Keychain only: the GitHub token and any Anthropic API key. They are never written to SQLite or logs.
- **Agent profiles** live at `~/.branchwork/profiles/<cli>-<slug>/`. See §6.6.

---

## 4. Domain model

```
Group      { id, name, color, defaultProfiles: {claude?, codex?}, clonePathTemplate }
Project    { id, owner, name, localPath, groupId? }            // a repository
Worktree   { path, branch, head, ahead, behind, dirtyCount, state: clean|dirty|conflict|rebasing }
Pin        { projectId, worktreePath }                          // sidebar visibility
Session    { id, worktreePath, cli: shell|claude|codex|opencode|gemini, profileId?, status: idle|running|waiting|done, layout?: left|right|full }
Profile    { id, cli, name, plan?, dir, usage?: {window, percent} }
Commit, Ref, FileChange { path, status: M|A|D|R|U, hunks[], stagedHunks[] }, PullRequest, Issue, WorkflowRun, Notification
```

---

## 5. Design system

- **Material:** a Liquid Glass shell. Window vibrancy comes from the `window-vibrancy` crate (macOS `NSVisualEffectView`). Sidebar, toolbar groups, menus, palette, toasts, and dialogs are translucent glass. The content surface (stage) stays near-opaque for legibility.
- **Color tokens:** OKLCH, generated from three inputs (base hue, accent hue, contrast), following Linear's 2026 theme approach. Both light and dark themes derive from the same inputs. Status colors (green, red, yellow, blue, purple) are fixed hues, adjusted per theme.
- **Type:** SF Pro Text (system) for UI and SF Mono / JetBrains Mono for code. Base size 13px on a 4px grid.
- **Motion:** spring easing (`cubic-bezier(.34,1.56,.64,1)`) for popovers, view transitions, and toasts. All motion respects `prefers-reduced-motion`.
- **Accessibility:**
  - Every control is keyboard reachable.
  - Visible focus rings.
  - Text meets WCAG AA contrast at the default contrast setting.
  - A "Reduce transparency" setting switches glass to solid, and the macOS system setting is also honored.
- **Components:** Button (default, primary, danger, ghost), Chip, Segmented group, Menu/context menu, Dialog (`ask()`, see §6.1.8), Toast with action, Palette, Kbd, Tabs, Tree, Split divider.

---

## 6. Features

### 6.1 App shell

#### 6.1.1 Title bar

- Traffic lights.
- **Group switcher chip**: color square, name, and ▾. Clicking it opens the projects popover.
- **Project tabs** for the active group, plus ＋ (add project).
- A centered search pill that opens the palette.
- Right side: terminal toggle, inbox with unread badge, theme toggle.

#### 6.1.2 Project groups

- A project belongs to zero or one group. The popover lists every group and its projects (`owner/name`, open-PR count, local path), followed by **Ungrouped**.
- Search filters across all groups.
- Drag a project onto a group to move it.
- Group settings: name, color (7 swatches), **default Claude Code profile**, **default Codex profile**, and a clone/worktree path template such as `~/clients/{repo}`.
- Deleting a group moves its projects to Ungrouped. Repositories on disk are never touched. The delete is confirmed and can be undone from a toast.
- Default-profile resolution for a new agent session in a group: the group's default profile if its usage is under 90%, otherwise the first other profile under 90%, otherwise the first profile.

#### 6.1.3 Sidebar

- **Navigation:** Launchpad, Graph, Files & editor, Changes (count), Agents, Terminal, Pull requests, Repository, Inbox.
- **Worktrees** shows only **pinned worktrees plus the active one**, with an `n/total` header.
  - ☰ opens a searchable picker with checkboxes.
  - Hover a row for ❯_ (open terminal) and × (unpin).
  - A "… N more worktrees" row opens the picker.
  - Worktrees the user creates are pinned automatically. Worktrees created by race or handover are not pinned; they appear in Agents.
  - Each row shows a color stripe, branch name (ellipsized), ahead/behind, linked PR, and either a status chip (clean, n changed, conflict) or the agent badge (CLI icon + status).
- **Tools:** Resolve conflicts (count), Interactive rebase, Blame & history, Compare worktrees.
- **Stashes.**
- **Footer:** GitHub account and a Settings button.
- **Collapse / show:**
  - **⌘B**, the ◧ button in the title bar, or the palette command "Toggle sidebar" collapses the sidebar to a 52 px icon rail.
  - In the rail, labels, section headers and worktree names are hidden. Each icon keeps its tooltip and accessible name, and still supports drag-to-split, modifier clicks and the context menu.
  - Pressing it again expands the sidebar.
  - The state is persisted (`settings` key `sidebar`).

#### 6.1.4 Router and split view (Arc-style)

- The stage holds **one or two panes**. Each pane shows one screen with its own toolbar. The two panes cannot show the same screen.
- The focused pane gets an accent outline. Sidebar navigation targets the focused pane. Both screens are highlighted in the sidebar, with a position glyph (◧ ◨ ⬒ ⬓).
- Ways to open a split:
  - Drag a sidebar item onto the stage. Drop zones are the nearest edge (left, right, top, bottom), with a live preview of the target half.
  - ⌘-click opens it on the right. ⌥-click opens it on the bottom.
  - Context menu: open here, or split left, right, top, or bottom.
  - The pane toolbar ⊞ menu lists each screen with direction icons.
  - The palette.
  - ⌘\\ toggles a right split; ⌘⇧\\ toggles a bottom split.
- Controls: drag the divider to resize (20–80%, double-click resets to 50%). ⇄ swaps panes, ⬒/◫ changes orientation, ✕ closes a pane.
- Panes adapt to their own width through CSS container queries. For example, the Agents grid collapses to one column under 780px.
- Split state persists per window in `settings`.

#### 6.1.5 Command palette (⌘K)

- Fuzzy search over navigation, Git actions, worktrees, GitHub items, files (⌘P pre-fills "Open "), groups and projects, split-view actions, and theme.
- Typing a query ending in `?` turns the first result into **Ask Claude** (§6.9).
- Arrow keys and Enter, grouped sections, and shortcut hints.

#### 6.1.6 Keyboard map (defaults, configurable)

| Action | Keys |
|---|---|
| Palette / quick open | ⌘K / ⌘P |
| Collapse / show sidebar | ⌘B |
| Terminal dock | ⌃\` |
| Undo last Git op | ⌘Z (outside text inputs) |
| Commit (Changes) | ⌘↵ |
| Save file | ⌘S |
| New worktree | ⌘⇧N |
| Split right / bottom (toggle) | ⌘\\ / ⌘⇧\\ |
| Go to Changes | ⌃⇧G |
| Screens 1–9 | Launchpad, Graph, Files, Changes, Agents, Terminal, PRs, Repository, Inbox |
| Terminal screen | ⌘D split right · ⌘⇧D split down · ⌘⌥←↑→↓ focus · ⌘⇧↵ maximize · ⌘⌥I broadcast · ⌘W close pane · ⌘T new tab |

#### 6.1.7 Toasts and undo

- Every mutating action ends in a toast with a short description and, where possible, an **Undo** action.
- Git undo uses the reflog through `undo::oplog`. Each Git write records `{op, worktree, before_ref, after_ref, extra}`. Undo applies the inverse: `reset --soft` for commit, restore the backup ref for rebase, `reset --keep` for pull/merge, re-apply for discard (Branchwork stashes or copies discarded content before discarding).
- File deletes go to the macOS Trash.

#### 6.1.8 Dialogs

- **No native `confirm()` or `prompt()` anywhere.** The `ask({title, body, ok, danger, icon, input?, meta?})` dialog returns a promise.
- Glass panel with an icon, a red primary button when `danger` is set, an optional monospace detail block (for example, the list of files to discard), Enter to confirm, and Esc or a backdrop click to cancel.
- Confirmation is required for:
  - stopping a running agent
  - discard all
  - deleting a file, folder, or group
  - abort merge
  - squash/merge PR
  - logging out of a profile
  - disconnecting GitHub
  - force-push after a rebase
  - quitting the app while agents are running

#### 6.1.9 Theme

Dark (default), Light, and System. Settings also offer accent swatches and sliders for accent hue, base tint, and contrast, plus density (compact, default, comfy) and Reduce transparency.

#### 6.1.10 Onboarding (first launch)

1. Welcome, with three value props.
2. **Sign in with GitHub** (device flow), or a Personal Access Token.
3. Pick repositories to clone or open, and choose a group (or create one).

Every step can be skipped.

### 6.2 Graph

- A virtualized commit list across all branches. The lane layout is computed in Rust (`git::graph`) and returned paged (500 rows per page).
- Each row shows lanes with **author avatar nodes**, refs (local, remote, tag, and **worktree heads marked ⌂**), message, PR chip, CI status (✓, ✕, spinner), author, relative time, and short SHA.
- A **WIP row** appears at the top for the active worktree.
- Filters: All branches, Worktrees, Mine, Agent commits.
- Toolbar: Fetch, Pull (count), Push (count), ＋ Worktree.
- **Inspector:**
  - For a commit: SHA, CI, PR, message, author, and a file list. Clicking a changed file opens a read-only diff tab in Graph's main editor area, comparing the selected commit with its first parent (or the empty tree for a root commit). An AI summary is on demand; actions include cherry-pick, revert, rebase from here, and open PR.
  - For WIP: staged, unstaged, untracked, and conflicted files. Clicking a file opens a diff tab in Graph's main editor area, distinct from the Files editor. A persistent Graph tab keeps the commit graph accessible, and the WIP inspector remains alongside the editor tabs; multiple diff tabs can remain open and be closed individually. Each diff retains the selected file's staged or unstaged comparison.
  - The WIP inspector supports quick stage/unstage actions, and the Graph diff tabs use the shared renderer's hunk/line actions. Commit, stash, and bulk source-control operations remain in the full Changes screen, reachable through "Open in Changes".
- **Row context menu:**
  - Checkout
  - Create worktree here
  - Create branch
  - Cherry-pick
  - Revert
  - Interactive rebase from here
  - Blame files
  - Compare with working tree
  - Open terminal here
  - Copy SHA

### 6.3 Changes (VS Code–style source control)

**Left panel:**
- Header with list/tree toggle, refresh, and a ⋯ menu (pull, push, fetch, stash all, pop stash, checkout, rebase, terminal).
- **Commit message box:**
  - The placeholder names the branch.
  - ✦ generates a message from the staged diff.
  - A first-line counter turns yellow above 50 characters and red above 72.
- **Commit split button:**
  - Commit (⌘↵)
  - Amend
  - Commit & Push
  - Commit & Sync
  - Commit All (stage everything)
  - Undo Last Commit
- A branch line showing ahead/behind and Sync.
- **Staged Changes** and **Changes** sections:
  - Section actions: stage all, unstage all, discard all (confirmed).
  - File rows show a status letter (M, A, D, U, R). Deleted files are struck through. The directory is dimmed in list mode.
  - Hover actions on a file: open file, discard, stage/unstage. Double-click opens the file in Files.
  - A partially staged file appears in **both** sections.
- **Stashes** section (apply, pop, drop).

**Right panel (diff editor):**
- Header: file name, `(Index)` or `(Working Tree)`, and the comparison label (`HEAD ↔ Index` for staged, `Index ↔ Working Tree` for unstaged). Buttons for previous/next change, open file, and "Stage selected lines".
- **Side-by-side** or **Inline** mode (per-user setting).
- Intraline (word/character) highlights inside changed line pairs.
- Hunk headers carry a staged/unstaged chip and **Stage hunk**, **Revert hunk**, or **Unstage hunk**.
- Hunks that don't belong to the current comparison are dimmed.
- Click line numbers to select lines, then use **Stage selected lines**. This uses `git apply --cached` with a synthesized patch.
- Unchanged regions collapse to "⋯ N unchanged lines" and expand on click.
- An overview ruler on the right edge marks additions and deletions.
- Binary and large files (over 1 MB) show a summary instead of a diff.
- The Rust side computes diffs with git2's patience diff. The frontend renders a shared `DiffModel { hunks[{oldStart, newStart, lines[{kind, old?, new?, text, intra?}]}] }`.

### 6.4 Files & editor

- **File manager:**
  - Worktree selector and fuzzy file search (⌘P).
  - An "Open editors" list.
  - A tree with Git status letters and dirty dots. It respects `.gitignore`, with a toggle to show ignored files.
  - Context menu: New file, New folder, Rename (F2), Duplicate, Delete (Trash, confirmed), Open terminal here, Reveal in Finder, Copy path, Blame, File history, Discard changes, Ask agent about this.
- **Editor:**
  - CodeMirror 6 with tabs, dirty indicators, breadcrumbs, and a Git gutter (added, modified, deleted).
  - Language modes: TS/JS/JSX/TSX, JSON, Markdown, CSS, HTML, Rust, Go, Python, YAML, and TOML.
  - Bracket matching and auto-close.
  - Status bar: line/column, selection, indentation, encoding, EOL, language, and branch.
  - ⌘S saves. **Diff vs HEAD** toggles to the shared diff renderer.
  - **Open in**: VS Code, Cursor, Zed, or Finder.
  - **Ask agent** sends `@path:Lstart-Lend` to the worktree's agent session, starting one with the group's default profile if none exists.
- External change while editing: if the file is clean, reload it silently. If it is dirty, show a banner offering "Reload / Keep mine / Compare".
- **Blame & history:**
  - The blame gutter shows author, age, and message, plus an **age heat stripe**. Consecutive lines from the same commit collapse.
  - Clicking a line shows that commit's details and the file history timeline, with links to the commit and its PR.

### 6.5 Terminal dock

- Real terminals: xterm.js (WebGL renderer) on top of `portable-pty`. The default shell is the user's login shell.
- **Modes:** dock bottom, dock right, floating (drag and resize), and maximized.
  - Bottom and right docks reserve layout space. Floating and maximized overlay the content.
  - Mode and size persist.
- **Tabs:** each tab is bound to a session and colored by its worktree. ＋ opens a new shell in the active worktree. Tabs can be closed.
- **Split** shows two sessions side by side, with ⇄ to swap sides.
- The same `CliPane` component is used for shells and agents. Its header has a worktree label, a **CLI switcher** (zsh, Claude Code, Codex, OpenCode, Gemini CLI), a profile chip (agents only), a status chip, Handover, pop-out, and close.
- **Open from anywhere:**
  - ⌃\` or the title-bar button
  - sidebar worktree hover
  - Graph context menu
  - Files context menu
  - the Changes ⋯ menu
  - PR header
  - Conflict and Repository toolbars
  - the palette
- Typing an agent command (`claude`, `codex`, …) in a shell tab is detected, and the tab becomes an agent session with the default profile.

### 6.5a Terminal screen (iTerm-style split panes)

A full-screen terminal workspace in the sidebar navigation ("Terminal", icon ❯_). It is separate from the terminal dock (§6.5). The dock is for quick commands next to another screen; the Terminal screen is for long-running work with many panes. Both use the same PTY sessions and the same `CliPane` component.

- **Tabs:** each tab holds one pane layout. ＋ (⌘T) opens a new tab with a shell in the focused pane's worktree. Tabs can be closed (×), and a tab shows its pane count.
- **Recursive split panes (iTerm2 model).** The layout is a tree: a split node has a direction (`h` or `v`), N children, and N sizes.
  - **⌘D** splits the focused pane to the right. **⌘⇧D** splits it down.
  - Splitting in the same direction as the parent adds a sibling and halves the space. Splitting in the other direction nests a new split.
  - Any pane can be split again.
- **Resize:** drag the thin gutters. Each pane keeps at least 8% of its parent. Double-click a gutter to equalize its siblings.
- **Focus:** click a pane, or use ⌘⌥←↑→↓ to move to the nearest pane in that direction.
  - The focused pane has an accent outline. Unfocused panes are dimmed slightly (iTerm "dim inactive panes").
  - The status bar shows the focused pane's worktree, cwd, shell, position ("pane 2/4"), and size in columns × rows.
- **Pane header:** worktree color dot, a **worktree selector** (switching runs `cd` into that worktree's path), title (shell · cwd), and hover actions: split right, split down, maximize, close.
- **Maximize (⌘⇧↵):** temporarily shows only the focused pane. Pressing it again restores the layout.
- **Broadcast input (⌘⌥I):** typed input goes to every pane in the tab. All panes get an orange outline, and the status bar shows "broadcasting to N panes".
- **Close:** ⌘W closes the focused pane; its space goes to its siblings, and a split with one child collapses. Closing the last pane closes the tab. If a process is still running, closing asks for confirmation through `ask()`.
- **Pane context menu:** Split right, Split down, Maximize pane, Broadcast input, Clear, Run Claude Code here (turns the pane into an agent session, §6.6), Move pane to new tab, Close pane.
- **Persistence:** tab names, layout tree, sizes, and each pane's worktree and cwd are saved in `settings` and restored on relaunch. Restore starts fresh shells; scrollback is not restored in v1.
- **Integration:**
  - "Open terminal here" actions (§6.5) offer *Open in Terminal screen* as an alternative to the dock.
  - A pane can be moved to the dock and back.
  - The Terminal screen works inside split view (§6.1.4) like any other screen.
- **Implementation:**
  - Frontend: a pure layout-tree reducer (`split`, `close`, `resize`, `moveFocus`, `maximize`) with unit tests, plus one xterm.js instance per pane.
  - Backend: each pane is a `pty_spawn` session.
  - Resizing a pane sends `pty_resize` with the new cols/rows, debounced to 50 ms.

### 6.6 Agents (CLI-native)

**Principle:** Branchwork launches the vendor's CLI in a PTY inside the chosen worktree and shows its real terminal output. There is **no custom chat UI**. Everything the user types goes to the CLI's stdin.

#### 6.6.1 CLI registry

Each supported CLI is declared in a registry:

```
{ id, name, icon, launch, resume, profileEnv, loginCmd, statusDetect }
```

| CLI | launch | resume (after profile switch) | profile isolation | login |
|---|---|---|---|---|
| Claude Code | `claude` | `claude --continue` | `CLAUDE_CONFIG_DIR=<dir>` | `claude /login` |
| Codex | `codex` | `codex resume --last` | `CODEX_HOME=<dir>` | `codex login` |
| OpenCode | `opencode` | `opencode` | `HOME=<dir>/home` (sandboxed home) | CLI's auth command |
| Gemini CLI | `gemini` | `gemini` | `HOME=<dir>/home` | CLI's auth command |
| Custom | user command | user command | optional env | — |

- Exact flags are verified against each CLI's installed `--help` when building the registry, and can be overridden per CLI in Settings, because vendors change flags.
- The binary path is resolved from the login shell's `PATH`. If it is missing, show "Install X" guidance.

#### 6.6.2 Sessions screen

- A grid of `CliPane`s, one per agent session.
- Per-pane layout: ◧ left, ◨ right, ▭ full width. Toggling a side moves any conflicting pane to the other side. Placement order is pinned sides first, then auto, then full-width.
- Toolbar: ▦ Grid / ▭ Full width (applies to all panes), ⚑ Race, ＋ New agent.
- Pane close (✕) stops the CLI with SIGINT, then SIGTERM after 3 s. It asks for confirmation if the session is running. The worktree is kept. Undo (from the toast) relaunches the CLI in the same worktree and profile with its resume command, so the conversation continues.
- ⤴ moves the session into the terminal dock. A session can be visible in the grid and the dock at the same time.

#### 6.6.3 Status detection

A session has one of four statuses: `idle`, `running`, `waiting` (needs input), or `done`.

- **Primary signal:** agent-provided hooks or notifications where available. Branchwork writes, inside the isolated profile dir only, a hook config that calls `branchwork-notify <session> <event>`. This is a tiny bundled binary that posts to the app over a Unix socket. Examples: Claude Code `Stop`/`Notification` hooks, Codex `notify`.
- **Fallback:** heuristics on PTY output, such as known prompt and choice patterns, plus idle time with no output for 4 s after activity.
- Status drives several UI elements:
  - the sidebar badge
  - the pane outline (yellow for waiting)
  - Launchpad cards
  - a toast plus a macOS notification on `waiting` or `done` while the app is unfocused

#### 6.6.4 Accounts / profiles

- **Multiple profiles per CLI**, each an isolated directory at `~/.branchwork/profiles/<cli>-<slug>/`.
- **Add account:** name the profile, then a login PTY opens with the profile env, and the user completes the vendor login.
- **Logout:** confirmed; deletes the credentials inside the profile dir.
- The pane **profile chip** (◔ name + usage bar) opens a menu of that CLI's profiles (✓ current, plan, usage %), plus "Add account…" and "Manage accounts".
- **Switching profile:** confirm only if the session is running. Then interrupt the CLI and relaunch it with the new profile env and the CLI's **resume** command, so the conversation continues. Branchwork prints a dimmed system line in the pane, such as `↻ Account Personal → Work · acme`. The `/account` typed in an agent pane is intercepted and switches to the next profile.
- **Usage limits:** best effort.
  - When the CLI prints a usage-limit message (pattern per CLI), the session becomes `waiting`, an inline banner and a toast offer **Switch** to the next profile under its limit, and the remaining work resumes after the switch.
  - With **Auto-switch on limit** (Settings, default on), this happens without asking.
  - Usage percentages are shown only when the CLI exposes them (for example, by parsing its status/usage command output). Otherwise the bar is hidden. **Branchwork does not fabricate usage numbers.**
- Profile resolution order for a new session: explicit choice, then group default (§6.1.2), then global default, then first profile.

#### 6.6.5 Handover

Handover moves work from one CLI (or profile) to another, either in the same worktree or in a new one.

The dialog contains:
- From (CLI, worktree, status)
- To (CLI cards; the current CLI is disabled)
- Profile for the target
- Where:
  - **Same worktree**: continue the current state.
  - **New worktree**: branch `handover/<branch>-<cli>` from the current branch, so results can be compared.
- An editable **handover note**, pre-filled with the task (first user prompt), what has been done, what remains, and changed files. A ✦ regenerate option uses AI (§6.9).
- Checkboxes: include `git diff`, include the last 50 lines of output, stop the source CLI.
- A preview of the exact command.

On confirm:
1. Write `.branchwork/handover.md` inside the worktree. `.branchwork/` is added to `.git/info/exclude`, so it is never committed.
2. Optionally stop the source CLI.
3. Launch the target CLI with the profile env and the prompt: "Continue the work from <source>. Read .branchwork/handover.md and the git diff."

#### 6.6.6 Race

- Send one prompt to N selected CLIs. Each runs in its own new worktree (`race/<slug>-<cli>`) with its default profile.
- The race worktrees are not pinned.
- Results are compared with Compare worktrees (§6.8). The user keeps one and discards the others; discarding removes the worktree and branch, with confirmation.

#### 6.6.7 New agent

The dialog asks for a CLI card, a profile, a prompt, and a worktree (existing, or ＋ new `agent/<slug>`). On start, Branchwork launches the CLI with the prompt and creates a session.

### 6.7 GitHub

- **Auth:** OAuth **device flow**, so no client secret ships in the app.
  - Scopes: `repo`, `read:org`, `notifications`, `workflow`.
  - The token is stored in the Keychain.
  - A PAT is accepted as an alternative.
  - Signing out removes the token after confirmation.
- **Data:** GraphQL for PRs, reviews, and issues; REST for Actions and notifications.
  - Conditional requests (ETag) and a poller: 60 s for the active repo, 5 min for others, and an immediate refresh after the user acts.
  - Responses are cached in memory, keyed by repo.
  - Rate-limit headers are respected. When the remaining quota is below 10%, the poller backs off and the UI shows "GitHub rate limit, retrying at hh:mm".
- **Pull requests screen:**
  - Filtered list: Open, Review requested, Mine, Closed.
  - Each item shows CI, status chip, and author.
  - **Detail view:**
    - Header: title, base ← head, stats, and "Terminal in worktree" (checks out the PR into a worktree if needed).
    - Tabs: Conversation, Files (shared diff renderer with review threads), Checks, ✦ AI review.
    - **Suggested changes** have **Apply to worktree**, which writes the change into the local worktree uncommitted, with Commit offered in a toast.
    - Review actions: Approve, Request changes, Comment.
    - **Squash & merge ▾** (squash, merge, rebase) is confirmed. After merging, Branchwork offers to delete the branch and remove its worktree.
- **Repository screen (GitHub-style):**
  - Header: `owner/name`, Public/Private, group chip, and Watch, Fork, Star.
  - Tabs: Code, Issues, Pull requests, Actions. Projects, Wiki, Security, Insights, and Settings open on github.com in v1.
  - **Code tab:**
    - branch selector, branch/tag counts, Go to file, Add file, Code (clone URL copy)
    - a latest-commit bar
    - a file table (name, last commit message, age), where clicking a file opens it in Files
    - rendered README
  - **Sidebar:** About, topics, link, license, stars/watchers/forks, Releases (with ✦ draft release notes), Contributors, Languages bar.
  - **Issues tab:** filters, labels, comment counts, an agent badge when an agent session is linked, and **▶ Start → worktree**. That action creates the branch `fix/issue-<n>` (prefix configurable), a worktree, and a terminal, and links the issue in the eventual PR body (`Closes #n`).
  - **Actions tab:** runs list, with Re-run on failed runs.
- **Inbox:** GitHub notifications (review requested, mention, CI failed) merged with agent events (needs input, done).
  - Filters, mark done, snooze, read all.
  - Each item has a contextual primary action.
- **Launchpad (home):**
  - A greeting with a summary line.
  - KPIs (open PRs, worktrees, CI pass rate over 24h) with sparklines.
  - **Needs your attention** (PRs).
  - **Issues for you** (Start → worktree, Assign to agent).
  - **Agents** (status cards; Open CLI, Handover).
  - CI feed.
  - Scope: this group (default) or all groups.

### 6.8 Advanced Git tools

- **Conflict resolver (3-way):**
  - Ours, Result, and Theirs columns. Click a hunk side, or use ← Ours / Both / Theirs → in Result. Each resolution can be undone.
  - A remaining-conflicts counter.
  - ✦ AI explanation and suggestion; the suggestion is never auto-applied without review.
  - Per-file tabs.
  - **Mark resolved & commit** is enabled when every conflict is resolved.
  - Abort merge is confirmed.
- **Interactive rebase:**
  - Drag to reorder.
  - Per-commit action: pick, reword (inline edit), squash, fixup, drop.
  - ✦ Auto-squash (fixup!/typo/wip).
  - A result preview and count.
  - Before starting, Branchwork creates a backup ref `refs/branchwork/backup/<branch>/<ts>`, so the rebase can be undone.
  - Progress is shown per step. Conflicts open the conflict resolver.
  - A warning appears if the branch is already pushed, and the subsequent push uses `--force-with-lease` after confirmation.
- **Compare worktrees:** pick worktree A and worktree B, with an option to include uncommitted changes. Shows a file list with stats and the diff (shared renderer), plus Copy patch. This is used to judge race results.

### 6.9 AI assists (✦)

Covered features:
- commit message
- PR description and summary
- AI review
- conflict explanation and suggestion
- release notes
- handover note
- commit/repo summaries
- palette "Ask Claude"

Rules:
- **Execution:** the default backend is **Claude Code headless** (`claude -p`) with the active group's Claude profile, so no extra key is needed. An optional Anthropic API key (stored in the Keychain) can be selected in Settings, with model selection (default `claude-opus-5-5`).
- **Privacy:** diffs and code leave the machine **only when the user clicks a ✦ action**. A Settings toggle, "Send code to AI only on explicit action", is on by default and cannot be bypassed by background features.
- AI output is always shown for review and never auto-committed.

### 6.10 Settings

- **Appearance**
- **Accounts:** GitHub, plus agent CLI profiles per CLI (add, logout, usage, default badge), Auto-switch on limit, and default profile per repo or group.
- **Git:** default worktree path template, auto-fetch interval, signing passthrough info.
- **Worktrees:** copy ignored files via `.worktreeinclude` patterns (for example `.env`), and a post-create setup script (for example `pnpm install`).
- **Terminal:** shell, font, size, scrollback.
- **AI & agents:** backend, model, CLI flag overrides, and custom CLIs.
- **Keybindings.**

---

## 7. Error handling

- Every IPC command returns `Result<T, AppError { kind, message, detail?, recoverable }>`. Error kinds: `GitConflict`, `GitAuth`, `GitHook`, `NotARepo`, `Network`, `RateLimited`, `PtySpawn`, `CliMissing`, `ProfileAuth`, `Io`, `Internal`, plus `Validation`, `Conflict` (stale/mtime write) and `NotFound` (unknown id), added in M2 Task 00 for input validation and lookup failures the M2 task files rely on.
- Git CLI failures surface stderr in an expandable toast ("Show details"). Hook failures show the hook name and output.
- Authentication failures:
  - Push/pull auth failure offers "Open terminal to authenticate".
  - GitHub 401 triggers a re-auth prompt.
- A missing CLI binary shows install guidance in the pane. A profile auth failure offers "Log in this profile".
- The file watcher debounces bursts (250 ms) and coalesces events per worktree. When `.git/index.lock` exists, refreshes are skipped and retried.
- Long operations (clone, fetch, rebase) show a progress toast and can be cancelled where Git supports it.
- The app never loses user work. Discard and delete are reversible: content is stashed or copied before discard, and deletes go to the Trash.

---

## 8. Security and privacy

- Secrets are stored only in the Keychain and are redacted from logs.
- Agent profiles are isolated per directory, and credentials are never copied between profiles.
- Tauri capabilities are least-privilege. The WebView has no generic shell access; only typed commands are exposed. The CSP blocks remote scripts.
- PTY env inherits the login shell environment plus the explicit profile vars only.
- `.branchwork/` handover files are excluded via `.git/info/exclude`, never committed.
- Opening a repository never runs repo-defined scripts automatically. The worktree setup script is a user setting, not repo config.

---

## 9. Performance budgets

| Item | Budget |
|---|---|
| Cold start to interactive | < 1.5 s |
| Graph | 100k commits, first page < 300 ms, 60 fps scroll (virtualized) |
| Status refresh | 10k files < 200 ms |
| Diff render | 5k-line file < 100 ms; files > 1 MB summarized |
| Terminal | 8 concurrent PTYs without dropped frames (xterm WebGL) |
| Memory | < 400 MB with 4 agents and 2 repos open |

---

## 10. Testing strategy

- **Rust unit and integration tests** run against temporary repositories built in tests:
  - status
  - hunk and line staging (patch synthesis)
  - graph layout
  - worktree add/remove
  - conflict detection
  - rebase plan execution
  - oplog undo
  - profile env construction
  - status-detection heuristics (fixtures of recorded CLI output)
- **IPC contract:** a check that `specta` type generation leaves the tree unchanged.
- **Frontend:** Vitest + Testing Library for stores, the diff renderer (DiffModel → DOM), the split-view reducer, palette filtering, and `ask()`.
- **End-to-end:** Playwright drives the built app via `tauri-driver` (WebDriver) on macOS CI. Core flows:
  - open repo
  - create worktree
  - stage hunk and commit
  - open terminal
  - start a mock agent (a fake CLI script emitting known patterns)
  - switch profile
  - handover
  - split view
  - resolve conflict
- GitHub calls are mocked with recorded fixtures. One nightly job runs against a real test repo.
- The local gate before merge is `cargo test`, `cargo clippy -D warnings`, `pnpm typecheck`, `pnpm test`, and `pnpm lint`.

---

## 11. Delivery plan (sub-projects)

Each milestone gets its own implementation plan (`writing-plans`) and ships independently.

| # | Sub-project | Scope | Depends on |
|---|---|---|---|
| M0 | **Shell & design system** | Tauri scaffold, window vibrancy, tokens/theme, sidebar (incl. **Terminal** placeholder), router, **split view**, palette, dialogs (`ask`), toasts, i18n catalog (en), settings store | — |
| M1 | **Repos, groups, worktrees, graph** | Open/clone, groups & projects popover, worktree list/create/remove/pin, Graph + inspector + context menu, file watcher | M0 |
| M2 | **Changes, files, editor** | Source control (staging hunks/lines, commit variants, stashes), shared diff renderer, file manager, CodeMirror editor, blame & history, oplog undo | M1 |
| M3 | **Terminal & agents** | PTY manager, **Terminal screen (iTerm-style split panes, §6.5a)**, dock modes/tabs/split, CliPane, CLI registry, sessions grid + layouts + close, profiles/accounts, switch + resume, limit handling, status detection + notify binary, handover, race, new agent | M1 |
| M4 | **GitHub** | Device-flow auth, PRs (list/detail/review/suggestions/merge), Repository view, issues → worktree, Actions, Inbox, Launchpad | M1 (M2 for PR diff, M3 for "Terminal in worktree") |
| M5 | **Advanced Git** | Conflict resolver, interactive rebase (backup refs), Compare worktrees | M2 |
| M6 | **AI assists** | Claude headless/API backend and every ✦ action, with the privacy guard | M2, M3, M4 |

M2 and M3 can run in parallel after M1.

---

## 12. Future (explicitly deferred)

- Windows and Linux builds.
- GitLab and Bitbucket.
- Graph Metro and Canvas views.
- Additional locales (the catalog already exists).
- Multi-window.
- Shared team presence.
- GitHub Projects and Wiki.
- More than two split panes.

---

## 13. Open questions

None blocking. The product name "Branchwork" is provisional.
