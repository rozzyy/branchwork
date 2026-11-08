/**
 * M2 Stage 3 — Files & editor screen (Tasks 09–11): open → edit → save round-trip,
 * Diff vs HEAD toggle, Delete-to-Trash confirm dialog, Reveal in Finder.
 *
 * Architecture: unlike m2-stage2-changes.spec.ts's `__bwTest` stub (which nothing in
 * `src/` actually reads — every `ipc/*.ts` module only checks for `__TAURI_INTERNALS__`),
 * this follows m1-stage2-worktrees.spec.ts's pattern instead: a full `__TAURI_INTERNALS__`
 * mock with a real `invoke` dispatcher and a `plugin:event|listen` registry, so `listen()`
 * calls throughout the app (Sidebar's and the editor's own `git:changed` subscriptions)
 * resolve against the same in-page fake backend and the UI behaves exactly as it would
 * against the real Tauri host.
 */

import { expect, test, type Page } from "@playwright/test";

const WORKTREE = "/repos/main";
const FILE_PATH = "notes.ts";
const FILE_CONTENT = "const notes = 1;\n";

async function seedEditorBackend(page: Page) {
  await page.addInitScript(
    ({ worktree, filePath, fileContent }) => {
      const worktrees = [
        { path: worktree, branch: "main", head: "a1", ahead: 0, behind: 0, dirtyCount: 0, state: "clean" },
      ];
      let written = false;
      let deleted = false;
      let savedContent = fileContent;
      // Exposed so tests can assert the exact IPC args reached fs_delete / reveal_in_finder.
      (window as unknown as Record<string, unknown>).__e2eCalls = { deleted: [] as string[], revealed: [] as string[] };

      // event name -> set of registered callback ids ("plugin:event|listen" can be called
      // more than once for the same event — Sidebar and the editor each subscribe).
      const listeners = new Map<string, Set<number>>();
      const callbacks = new Map<number, (event: unknown) => void>();
      let callbackId = 0;

      function emit(eventName: string, payload: unknown) {
        for (const id of listeners.get(eventName) ?? []) {
          callbacks.get(id)?.({ event: eventName, id: 1, payload });
        }
      }

      const internals = {
        transformCallback: (callback: (event: unknown) => void) => {
          const id = ++callbackId;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
          switch (command) {
            case "plugin:event|listen": {
              const handlerId = args.handler as number;
              const set = listeners.get(args.event as string) ?? new Set<number>();
              set.add(handlerId);
              listeners.set(args.event as string, set);
              return handlerId;
            }
            case "plugin:event|unlisten":
              return undefined;
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
              return worktrees;
            case "status":
              return written
                ? {
                    staged: [],
                    unstaged: [
                      { path: filePath, oldPath: null, indexStatus: " ", worktreeStatus: "M", bytes: 32, large: false },
                    ],
                  }
                : { staged: [], unstaged: [] };
            case "fs_tree": {
              const options = args.options as { path: string };
              if (options.path !== "") return { entries: [] };
              if (deleted) return { entries: [] };
              return { entries: [{ name: filePath, isDir: false, status: written ? "M" : null, size: 32, mtime: 1000 }] };
            }
            case "fs_read":
              return {
                bytes: Array.from(new TextEncoder().encode(savedContent)),
                encoding: "utf-8",
                eol: "LF",
                mtime: 1000,
              };
            case "fs_write": {
              savedContent = new TextDecoder().decode(new Uint8Array(args.bytes as number[]));
              written = true;
              worktrees[0] = { ...worktrees[0], dirtyCount: 1, state: "dirty" };
              emit("git:changed", { worktree });
              return 2000;
            }
            case "fs_delete": {
              (window as unknown as Record<string, unknown[]>).__e2eCalls &&
                ((window as unknown as { __e2eCalls: { deleted: string[] } }).__e2eCalls.deleted.push(
                  args.path as string,
                ));
              deleted = true;
              written = false;
              worktrees[0] = { ...worktrees[0], dirtyCount: 0, state: "clean" };
              emit("git:changed", { worktree });
              return null;
            }
            case "reveal_in_finder": {
              (window as unknown as { __e2eCalls: { revealed: string[] } }).__e2eCalls.revealed.push(
                args.path as string,
              );
              return null;
            }
            case "diff_file": {
              if (!written) return { hunks: [], binary: false, truncated: false, bytes: 0 };
              return {
                hunks: [
                  {
                    oldStart: 1,
                    newStart: 1,
                    oldLines: 1,
                    newLines: 1,
                    lines: [
                      { kind: "del", old: 1, new: null, text: fileContent.trimEnd(), intra: null },
                      { kind: "add", old: null, new: 1, text: savedContent.trimEnd(), intra: null },
                    ],
                  },
                ],
                binary: false,
                truncated: false,
                bytes: savedContent.length,
              };
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
    { worktree: WORKTREE, filePath: FILE_PATH, fileContent: FILE_CONTENT },
  );
}

test.describe("M2 Stage 3 — Files & editor", () => {
  test("open → edit → ⌘S save increments the Changes count", async ({ page }) => {
    await seedEditorBackend(page);
    await page.goto("/");

    // Bootstrap: sidebar shows the fixture worktree, clean.
    await expect(page.getByRole("button", { name: "main, Clean" })).toBeVisible();

    // Open the Files & editor screen and the fixture file.
    await page.getByRole("button", { name: "Files & editor" }).click();
    const fileRow = page.locator(".files-tree-node", { hasText: FILE_PATH });
    await expect(fileRow).toBeVisible();
    await fileRow.click();

    // Edit the buffer.
    const cmContent = page.locator(".cm-content");
    await expect(cmContent).toBeVisible();
    await cmContent.click();
    await page.keyboard.press("Meta+End");
    await page.keyboard.type("edited");

    // Save.
    await page.keyboard.press("Meta+s");

    // The sidebar's worktree badge reflects the post-save dirty count (via git:changed).
    await expect(page.getByRole("button", { name: "main, 1 changed" })).toBeVisible();
  });

  test("Diff vs HEAD toggle shows the diff for an edited file", async ({ page }) => {
    await seedEditorBackend(page);
    await page.goto("/");

    await page.getByRole("button", { name: "Files & editor" }).click();
    const fileRow = page.locator(".files-tree-node", { hasText: FILE_PATH });
    await fileRow.click();

    const cmContent = page.locator(".cm-content");
    await expect(cmContent).toBeVisible();
    await cmContent.click();
    await page.keyboard.press("Meta+End");
    await page.keyboard.type("edited");
    await page.keyboard.press("Meta+s");
    await expect(page.getByRole("button", { name: "main, 1 changed" })).toBeVisible();

    // Flip to Diff vs HEAD — the editor pane swaps for the DiffRenderer showing the file's hunk.
    await page.getByRole("radio", { name: "Diff vs HEAD" }).click();
    await expect(page.locator(".diff-file-path")).toHaveText(FILE_PATH);
    await expect(page.locator(".diff-renderer")).toContainText("const notes = 1;");
    await expect(page.locator(".diff-renderer")).toContainText("edited");
  });

  test("Delete moves the file to Trash after confirm", async ({ page }) => {
    await seedEditorBackend(page);
    await page.goto("/");

    await page.getByRole("button", { name: "Files & editor" }).click();
    const fileRow = page.locator(".files-tree-node", { hasText: FILE_PATH });
    await expect(fileRow).toBeVisible();
    await fileRow.click({ button: "right" });

    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();

    // The confirm dialog names the file and warns it moves to the Trash.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Delete “${FILE_PATH}”?`);
    await expect(dialog).toContainText("moves to the Trash");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();

    // fs_delete reached the IPC with the right path, the row disappears, and a toast confirms it.
    await expect(fileRow).toHaveCount(0);
    await expect(page.getByText(`Deleted ${FILE_PATH}`)).toBeVisible();
    const calls = await page.evaluate(
      () => (window as unknown as { __e2eCalls: { deleted: string[] } }).__e2eCalls.deleted,
    );
    expect(calls).toEqual([FILE_PATH]);
  });

  test("Reveal in Finder invokes the IPC with the file's path", async ({ page }) => {
    await seedEditorBackend(page);
    await page.goto("/");

    await page.getByRole("button", { name: "Files & editor" }).click();
    const fileRow = page.locator(".files-tree-node", { hasText: FILE_PATH });
    await expect(fileRow).toBeVisible();
    await fileRow.click({ button: "right" });

    await page.getByRole("menuitem", { name: "Reveal in Finder", exact: true }).click();

    const calls = await page.evaluate(
      () => (window as unknown as { __e2eCalls: { revealed: string[] } }).__e2eCalls.revealed,
    );
    expect(calls).toEqual([FILE_PATH]);
  });
});
