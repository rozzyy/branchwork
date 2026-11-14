import { expect, test, type Page } from "@playwright/test";

const WORKTREE = "/repos/main";
const COMMIT_PATH = "staged.ts";
const DELETE_PATH = "delete-me.txt";

type InvokeCall = { command: string; args: Record<string, unknown> };

async function seedUndoBackend(page: Page) {
  await page.addInitScript(({ worktree, commitPath, deletePath }) => {
    let staged = [{ path: commitPath, oldPath: null, indexStatus: "M", worktreeStatus: " ", bytes: 24, large: false }];
    let committedStaged: typeof staged = [];
    let deleted = false;
    let lastAction: "commit" | "delete" | null = null;
    const listeners = new Map<string, Set<number>>();
    const callbacks = new Map<number, (event: unknown) => void>();
    let callbackId = 0;
    (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls = [];

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
        (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls.push({ command, args });
        if (command === "plugin:event|listen") {
          const event = args.event as string;
          const handler = args.handler as number;
          const handlers = listeners.get(event) ?? new Set<number>();
          handlers.add(handler);
          listeners.set(event, handlers);
          return handler;
        }
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
            return [{
              path: worktree,
              branch: "main",
              head: "a1",
              ahead: 0,
              behind: 0,
              dirtyCount: staged.length,
              state: staged.length ? "dirty" : "clean",
            }];
          case "status":
            return { staged, unstaged: [] };
          case "stash_list":
            return [];
          case "diff_file":
            return { hunks: [], binary: false, truncated: false, bytes: 0 };
          case "commit":
            committedStaged = staged;
            staged = [];
            lastAction = "commit";
            return true;
          case "undo_last":
            if (lastAction === "commit") staged = committedStaged;
            if (lastAction === "delete") deleted = false;
            lastAction = null;
            emit("git:changed", { worktree });
            emit("op:done", { undoable: false });
            return false;
          case "fs_tree": {
            const options = args.options as { path: string };
            if (options.path !== "" || deleted) return { entries: [] };
            return {
              entries: [{
                name: deletePath,
                isDir: false,
                status: null,
                size: 12,
                mtime: 1_700_000_000,
              }],
            };
          }
          case "fs_delete":
            deleted = true;
            lastAction = "delete";
            emit("git:changed", { worktree });
            return true;
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
  }, { worktree: WORKTREE, commitPath: COMMIT_PATH, deletePath: DELETE_PATH });
}

function invokeCalls(page: Page, command: string): Promise<InvokeCall[]> {
  return page.evaluate(
    (name) => (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls.filter((call) => call.command === name),
    command,
  );
}

test("commit then Undo Last Commit restores the staged changes", async ({ page }) => {
  await seedUndoBackend(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "main, 1 changes" })).toBeVisible();
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await page.locator(".changes-commit-box textarea").fill("undoable commit");
  await page.getByRole("button", { name: "✓ Commit", exact: true }).click();
  await expect(page.locator(".changes-file-row", { hasText: COMMIT_PATH })).toHaveCount(0);

  await page.getByRole("button", { name: "Commit options" }).click();
  await page.getByRole("menuitem", { name: "Undo Last Commit" }).click();

  await expect.poll(() => invokeCalls(page, "undo_last")).toHaveLength(1);
  await expect(page.locator(".changes-file-row", { hasText: COMMIT_PATH })).toBeVisible();
});

test("delete then Undo restores the file", async ({ page }) => {
  await seedUndoBackend(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Files" }).click();
  const fileRow = page.locator(".files-tree-node", { hasText: DELETE_PATH });
  await expect(fileRow).toBeVisible();
  await fileRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(`Deleted ${DELETE_PATH}`)).toBeVisible();
  await expect(fileRow).toHaveCount(0);
  await page.getByRole("status").filter({ hasText: `Deleted ${DELETE_PATH}` })
    .getByRole("button", { name: "Undo", exact: true }).click();

  await expect.poll(() => invokeCalls(page, "undo_last")).toHaveLength(1);
  await expect(fileRow).toBeVisible();
});
