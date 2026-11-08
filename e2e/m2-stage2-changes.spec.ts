/**
 * M2 Stage 2 — Changes screen: staging, commit, stashes
 *
 * Covers Tasks 05-08:
 *   - Stage / unstage / discard via file-row hover actions
 *   - Commit variants (commit, amend menu entry, commit-all, split-button menu)
 *   - Stash push / apply / pop / drop + drop -> undo toast
 *   - 50/72 commit message counter color transitions
 *   - List <-> tree view toggle
 *
 * Architecture: a full `__TAURI_INTERNALS__` mock with a real `invoke` dispatcher and a
 * `plugin:event|listen` registry (the same pattern used by m1-stage2-worktrees.spec.ts,
 * m2-stage1-changes.spec.ts and e2e/files.spec.ts) -- NOT the old `window.__bwTest` stub this
 * file used to seed. Nothing in src/ ever read `__bwTest` (every `src/ipc/*.ts` module gates on
 * `"__TAURI_INTERNALS__" in window` instead), so every one of the previous 17 tests here early-
 * returned through an `if (await x.count() === 0) return;` guard without ever reaching the real
 * Changes UI or asserting anything. See `.agent/reviews/m2-stage-3-e2e.md` for the finding.
 *
 * The in-page mock keeps a small mutable staged/unstaged/stash state so that stage/unstage/
 * discard/commit/stash IPC calls actually move entries around and the UI reacts through its
 * normal `refresh()` path, same as it would against a real Rust backend. Every `invoke()` call
 * is recorded to `window.__invokeCalls` so tests assert the exact command + args Branchwork
 * sent, not just "some call happened".
 */

import { expect, test, type Page } from "@playwright/test";

type StatusEntry = {
  path: string;
  oldPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  bytes: number;
  large: boolean;
};

type StashEntry = { index: number; message: string; time: number; branch: string };

type InvokeCall = { command: string; args: Record<string, unknown> };

const WORKTREE = "/repos/main";

function entry(path: string, indexStatus: string, worktreeStatus: string): StatusEntry {
  return { path, oldPath: null, indexStatus, worktreeStatus, bytes: 64, large: false };
}

const DEFAULT_STAGED: StatusEntry[] = [entry("staged.ts", "M", " ")];
const DEFAULT_UNSTAGED: StatusEntry[] = [entry("modified.ts", " ", "M")];
const DEFAULT_STASHES: StashEntry[] = [
  { index: 0, message: "WIP on main: a1b2c3d first commit", time: 1_700_000_100, branch: "main" },
  { index: 1, message: "WIP on feat: d4e5f6a second commit", time: 1_700_000_000, branch: "feat" },
];

async function seedChangesBackend(
  page: Page,
  options: { staged?: StatusEntry[]; unstaged?: StatusEntry[]; stashes?: StashEntry[] } = {},
) {
  await page.addInitScript(
    ({ worktree, staged, unstaged, stashes }) => {
      let stagedEntries = staged;
      let unstagedEntries = unstaged;
      let stashEntries = stashes;

      (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls = [];
      const record = (command: string, args: Record<string, unknown>) => {
        (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls.push({ command, args });
      };

      const callbacks = new Map<number, (event: unknown) => void>();
      let callbackId = 0;

      const internals = {
        transformCallback: (callback: (event: unknown) => void) => {
          const id = ++callbackId;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
          record(command, args);
          if (command === "plugin:event|listen") return args.handler;
          if (command === "plugin:event|unlisten") return undefined;
          switch (command) {
            case "groups_list":
              return [];
            case "projects_list":
              return [{ id: "p1", owner: null, name: "repo", localPath: worktree, groupId: null }];
            case "settings_get":
              return null;
            case "settings_set":
              return undefined;
            case "pins_list":
              return [];
            case "worktree_list":
              return [
                {
                  path: worktree,
                  branch: "main",
                  head: "a1",
                  ahead: 1,
                  behind: 0,
                  dirtyCount: stagedEntries.length + unstagedEntries.length,
                  state: stagedEntries.length + unstagedEntries.length > 0 ? "dirty" : "clean",
                },
              ];
            case "status":
              return { staged: stagedEntries, unstaged: unstagedEntries };
            case "stash_list":
              return stashEntries;
            case "diff_file":
              return { hunks: [], binary: false, truncated: false, bytes: 0 };
            case "commit":
            case "commit_and_push":
            case "commit_and_sync": {
              const opts = args.options as { stageAll: boolean };
              if (opts.stageAll) {
                stagedEntries = [];
                unstagedEntries = [];
              } else {
                stagedEntries = [];
              }
              return null;
            }
            case "undo_last":
              return false;
            case "stage_paths": {
              const paths = args.paths as string[];
              const moving = unstagedEntries.filter((e) => paths.includes(e.path));
              unstagedEntries = unstagedEntries.filter((e) => !paths.includes(e.path));
              stagedEntries = [
                ...stagedEntries.filter((e) => !paths.includes(e.path)),
                ...moving.map((e) => ({ ...e, indexStatus: e.worktreeStatus, worktreeStatus: " " })),
              ];
              return null;
            }
            case "unstage_paths": {
              const paths = args.paths as string[];
              const moving = stagedEntries.filter((e) => paths.includes(e.path));
              stagedEntries = stagedEntries.filter((e) => !paths.includes(e.path));
              unstagedEntries = [
                ...unstagedEntries.filter((e) => !paths.includes(e.path)),
                ...moving.map((e) => ({ ...e, worktreeStatus: e.indexStatus, indexStatus: " " })),
              ];
              return null;
            }
            case "discard_paths": {
              const paths = args.paths as string[];
              unstagedEntries = unstagedEntries.filter((e) => !paths.includes(e.path));
              return null;
            }
            case "stage_hunks":
            case "unstage_hunks":
            case "stage_lines":
            case "revert_hunk":
              return null;
            case "stash_push": {
              const opts = args.options as { message: string | null; includeUntracked: boolean };
              stashEntries = [
                {
                  index: 0,
                  message: opts.message || "WIP on main: a1b2c3d uncommitted changes",
                  time: 1_700_000_200,
                  branch: "main",
                },
                ...stashEntries.map((s) => ({ ...s, index: s.index + 1 })),
              ];
              stagedEntries = [];
              unstagedEntries = [];
              return null;
            }
            case "stash_apply":
              return null;
            case "stash_pop":
            case "stash_drop": {
              const index = args.index as number;
              stashEntries = stashEntries
                .filter((s) => s.index !== index)
                .map((s) => (s.index > index ? { ...s, index: s.index - 1 } : s));
              return null;
            }
            default:
              throw new Error(`Unexpected mocked IPC command: ${command}`);
          }
        },
      };
      Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: internals });
      Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
        configurable: true,
        value: { unregisterListener: (_event: string, id: number) => callbacks.delete(id) },
      });
    },
    {
      worktree: WORKTREE,
      staged: options.staged ?? DEFAULT_STAGED,
      unstaged: options.unstaged ?? DEFAULT_UNSTAGED,
      stashes: options.stashes ?? DEFAULT_STASHES,
    },
  );
}

async function openChangesScreen(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^main,/ })).toBeVisible();
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await expect(page.locator(".changes-commit-box textarea")).toBeVisible();
}

function invokeCalls(page: Page, command: string): Promise<InvokeCall[]> {
  return page.evaluate(
    (cmd) => (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls.filter((c) => c.command === cmd),
    command,
  );
}

// ---------------------------------------------------------------------------
// Changes screen sections
// ---------------------------------------------------------------------------

test.describe("M2 Stage 2 — Changes screen sections", () => {
  test("shows staged and unstaged sections with correct file names and status letters", async ({ page }) => {
    await seedChangesBackend(page);
    await openChangesScreen(page);

    const stagedSection = page.locator(".changes-section-header", { hasText: "Staged Changes" });
    await expect(stagedSection).toBeVisible();
    await expect(stagedSection.locator(".chip")).toHaveText("1");
    const stagedRow = page.locator(".changes-file-row", { hasText: "staged.ts" });
    await expect(stagedRow).toBeVisible();
    await expect(stagedRow.locator(".changes-file-status")).toHaveText("M");

    const unstagedSection = page.locator(".changes-section-header", { hasText: "Changes" }).first();
    await expect(unstagedSection).toBeVisible();
    await expect(unstagedSection.locator(".chip")).toHaveText("1");
    const unstagedRow = page.locator(".changes-file-row", { hasText: "modified.ts" });
    await expect(unstagedRow).toBeVisible();
    await expect(unstagedRow.locator(".changes-file-status")).toHaveText("M");
  });

  test("shows Stashes section with correct count and stash entries", async ({ page }) => {
    await seedChangesBackend(page, { stashes: DEFAULT_STASHES });
    await openChangesScreen(page);

    const stashHeader = page.locator(".changes-section-header", { hasText: "Stashes" });
    await expect(stashHeader).toBeVisible();
    await expect(stashHeader.locator(".chip")).toHaveText("2");
    await expect(page.locator(".changes-stash-row")).toHaveCount(2);
  });

  test("commit message counter turns yellow at 51 chars and red at 73", async ({ page }) => {
    await seedChangesBackend(page);
    await openChangesScreen(page);

    const textarea = page.locator(".changes-commit-box textarea");
    const counter = page.locator(".changes-commit-count span");

    await textarea.fill("a".repeat(50));
    await expect.poll(() => counter.evaluate((el) => (el as HTMLElement).style.color)).toBe("var(--fg3)");

    await textarea.fill("a".repeat(51));
    await expect.poll(() => counter.evaluate((el) => (el as HTMLElement).style.color)).toBe("var(--yel)");

    await textarea.fill("a".repeat(73));
    await expect.poll(() => counter.evaluate((el) => (el as HTMLElement).style.color)).toBe("var(--red)");
  });

  test("commit split-button menu has six entries including Undo Last Commit", async ({ page }) => {
    await seedChangesBackend(page);
    await openChangesScreen(page);

    await page.getByRole("button", { name: "Commit options" }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();

    const items = menu.getByRole("menuitem");
    await expect(items).toHaveCount(6);
    for (const label of ["Commit ⌘↵", "Commit (Amend)", "Commit & Push", "Commit & Sync", "Commit All", "Undo Last Commit ⌘Z"]) {
      await expect(menu.getByRole("menuitem", { name: label, exact: true })).toBeVisible();
    }

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// stage -> commit -> undo flow
// ---------------------------------------------------------------------------

test.describe("M2 Stage 2 — stage → commit → undo flow", () => {
  test("stage file action dispatches stagePaths and shows success toast", async ({ page }) => {
    await seedChangesBackend(page);
    await openChangesScreen(page);

    const row = page.locator(".changes-file-row", { hasText: "modified.ts" });
    await row.hover();
    await row.getByRole("button", { name: "Stage", exact: true }).click();

    await expect(page.locator(".toast", { hasText: "Stage complete" })).toBeVisible();
    // The row is still rendered (now under Staged Changes) but it's now unstage-able, not
    // stage-able -- proof it actually moved sections, not just that a toast fired. The row
    // remounted at a new position (different section) so it needs a fresh hover: the action
    // buttons are CSS `:hover`-only (changes.css:41-42), not conditionally rendered.
    await row.hover();
    await expect(row.getByRole("button", { name: "Unstage" })).toBeVisible();

    const calls = await invokeCalls(page, "stage_paths");
    expect(calls).toEqual([{ command: "stage_paths", args: { worktreePath: WORKTREE, paths: ["modified.ts"] } }]);
  });

  test("commit button dispatches commit with the typed message", async ({ page }) => {
    await seedChangesBackend(page);
    await openChangesScreen(page);

    await page.locator(".changes-commit-box textarea").fill("test: my commit message");
    await page.getByRole("button", { name: "✓ Commit", exact: true }).click();

    await expect(page.locator(".toast", { hasText: "Commit complete" })).toBeVisible();
    await expect(page.locator(".changes-file-row", { hasText: "staged.ts" })).toHaveCount(0);

    const calls = await invokeCalls(page, "commit");
    expect(calls).toEqual([
      {
        command: "commit",
        args: { worktreePath: WORKTREE, options: { message: "test: my commit message", amend: false, stageAll: false } },
      },
    ]);
  });

  test("⌘↵ keyboard shortcut commits when message is non-empty", async ({ page }) => {
    await seedChangesBackend(page);
    await openChangesScreen(page);

    const textarea = page.locator(".changes-commit-box textarea");
    await textarea.fill("keyboard commit");
    await textarea.press("Meta+Enter");

    await expect(page.locator(".toast", { hasText: "Commit complete" })).toBeVisible();
    await expect(textarea).toHaveValue("");

    const calls = await invokeCalls(page, "commit");
    expect(calls).toEqual([
      {
        command: "commit",
        args: { worktreePath: WORKTREE, options: { message: "keyboard commit", amend: false, stageAll: false } },
      },
    ]);
  });

  test("Commit All dispatches commit with stageAll=true", async ({ page }) => {
    await seedChangesBackend(page);
    await openChangesScreen(page);

    await page.locator(".changes-commit-box textarea").fill("commit all");
    await page.getByRole("button", { name: "Commit options" }).click();
    await page.getByRole("menuitem", { name: "Commit All" }).click();

    await expect(page.locator(".toast", { hasText: "Commit complete" })).toBeVisible();
    await expect(page.locator(".changes-empty", { hasText: "Working tree clean" })).toBeVisible();

    const calls = await invokeCalls(page, "commit");
    expect(calls).toEqual([
      {
        command: "commit",
        args: { worktreePath: WORKTREE, options: { message: "commit all", amend: false, stageAll: true } },
      },
    ]);
  });

  test("Undo Last Commit dispatches undo_last for the active worktree", async ({ page }) => {
    await seedChangesBackend(page);
    await openChangesScreen(page);

    await page.getByRole("button", { name: "Commit options" }).click();
    await page.getByRole("menuitem", { name: "Undo Last Commit" }).click();

    await expect.poll(() => invokeCalls(page, "undo_last")).toEqual([
      { command: "undo_last", args: { worktreePath: WORKTREE } },
    ]);
    expect(await invokeCalls(page, "commit")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// discard flow
// ---------------------------------------------------------------------------

test.describe("M2 Stage 2 — discard flow", () => {
  test("discard file action dispatches discardPaths", async ({ page }) => {
    await seedChangesBackend(page);
    await openChangesScreen(page);

    const row = page.locator(".changes-file-row", { hasText: "modified.ts" });
    await row.hover();
    await row.getByRole("button", { name: "Discard changes" }).click();

    await expect(page.locator(".toast", { hasText: "Discard changes complete" })).toBeVisible();
    await expect(row).toHaveCount(0);

    const calls = await invokeCalls(page, "discard_paths");
    expect(calls).toEqual([
      { command: "discard_paths", args: { worktreePath: WORKTREE, paths: ["modified.ts"], discardUntracked: true } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// stash flow
// ---------------------------------------------------------------------------

test.describe("M2 Stage 2 — stash flow", () => {
  test("Stash All menu item dispatches stashPush", async ({ page }) => {
    await seedChangesBackend(page, { stashes: [] });
    await openChangesScreen(page);

    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Stash all changes" }).click();

    await expect(page.locator(".toast", { hasText: "Stash complete" })).toBeVisible();
    await expect(page.locator(".changes-empty", { hasText: "Working tree clean" })).toBeVisible();
    await expect(page.locator(".changes-stash-row")).toHaveCount(1);

    const calls = await invokeCalls(page, "stash_push");
    expect(calls).toEqual([
      { command: "stash_push", args: { worktreePath: WORKTREE, options: { includeUntracked: true } } },
    ]);
  });

  test("Apply stash button dispatches stashApply", async ({ page }) => {
    await seedChangesBackend(page, { stashes: DEFAULT_STASHES });
    await openChangesScreen(page);

    const stashRow = page.locator(".changes-stash-row", { hasText: "stash@{0}" });
    await stashRow.hover();
    await stashRow.getByRole("button", { name: "Apply stash" }).click();

    await expect(page.locator(".toast", { hasText: "Apply stash complete" })).toBeVisible();
    // Apply keeps the stash entry around (unlike pop/drop).
    await expect(page.locator(".changes-stash-row")).toHaveCount(2);

    const calls = await invokeCalls(page, "stash_apply");
    expect(calls).toEqual([{ command: "stash_apply", args: { worktreePath: WORKTREE, index: 0 } }]);
  });

  test("Pop stash button dispatches stashPop", async ({ page }) => {
    await seedChangesBackend(page, { stashes: DEFAULT_STASHES });
    await openChangesScreen(page);

    const stashRow = page.locator(".changes-stash-row", { hasText: "stash@{0}" });
    await stashRow.hover();
    await stashRow.getByRole("button", { name: "Pop stash" }).click();

    await expect(page.locator(".toast", { hasText: "Pop stash complete" })).toBeVisible();
    await expect(page.locator(".changes-stash-row")).toHaveCount(1);
    await expect(page.locator(".changes-stash-row", { hasText: "stash@{0}" })).toBeVisible();

    const calls = await invokeCalls(page, "stash_pop");
    expect(calls).toEqual([{ command: "stash_pop", args: { worktreePath: WORKTREE, index: 0 } }]);
  });

  test("Drop stash button dispatches stashDrop and shows an undo toast", async ({ page }) => {
    await seedChangesBackend(page, { stashes: DEFAULT_STASHES });
    await openChangesScreen(page);

    const stashRow = page.locator(".changes-stash-row", { hasText: "stash@{0}" });
    await stashRow.hover();
    await stashRow.getByRole("button", { name: "Drop stash" }).click();

    const toast = page.locator(".toast", { hasText: "Stash dropped" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("stash@{0}");
    await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(page.locator(".changes-stash-row")).toHaveCount(1);

    const calls = await invokeCalls(page, "stash_drop");
    expect(calls).toEqual([{ command: "stash_drop", args: { worktreePath: WORKTREE, index: 0 } }]);
  });

  test("stash@{N} reference renders correctly (no JSX escape issue)", async ({ page }) => {
    await seedChangesBackend(page, { stashes: DEFAULT_STASHES });
    await openChangesScreen(page);

    await expect(page.locator(".changes-stash-ref", { hasText: "stash@{0}" })).toBeVisible();
    await expect(page.locator(".changes-stash-ref", { hasText: "stash@{1}" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// list / tree toggle
// ---------------------------------------------------------------------------

test.describe("M2 Stage 2 — list / tree toggle", () => {
  test("tree toggle groups unstaged files by directory", async ({ page }) => {
    await seedChangesBackend(page, {
      staged: [],
      unstaged: [entry("src/foo.ts", " ", "M"), entry("src/bar.ts", " ", "A"), entry("readme.md", " ", "M")],
    });
    await openChangesScreen(page);

    // List view (default): no directory group headers, each row shows its own dir suffix.
    await expect(page.locator(".changes-tree-directory")).toHaveCount(0);
    await expect(page.locator(".changes-file-row", { hasText: "foo.ts" }).locator(".changes-file-dir")).toHaveText(
      "src",
    );

    const toggle = page.getByRole("button", { name: "Tree view" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();

    // Tree view: a "src" directory group header appears, and the root file has no group header.
    await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".changes-tree-directory", { hasText: "src" })).toBeVisible();
    await expect(page.locator(".changes-file-row", { hasText: "foo.ts" })).toBeVisible();
    await expect(page.locator(".changes-file-row", { hasText: "bar.ts" })).toBeVisible();
    await expect(page.locator(".changes-file-row", { hasText: "readme.md" })).toBeVisible();
  });
});
