import { expect, test } from "@playwright/test";

const WORKTREE = "/repos/main";
const SHA = "1111111111111111111111111111111111111111";

test("opens Blame and views its attributed commit in Graph", async ({ page }) => {
  await page.addInitScript(({ worktree, sha }) => {
    const callbacks = new Map<number, (event: unknown) => void>();
    let callbackId = 0;
    const commit = {
      sha,
      shortSha: sha.slice(0, 7),
      parents: [],
      lane: 0,
      nodes: [{ lane: 0 }],
      edges: [],
      parentLanes: [],
      refs: [{ name: "main", kind: "localBranch" }],
      worktreeHeads: [{ path: worktree, branch: "main" }],
      authorName: "Ada Lovelace",
      authorEmail: "ada@example.com",
      message: "Add attributed source",
      timestamp: 1_700_000_000,
      timezoneOffsetMinutes: 0,
    };
    const internals = {
      transformCallback: (callback: (event: unknown) => void) => {
        const id = ++callbackId;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
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
            return [{
              path: worktree,
              branch: "main",
              head: sha,
              ahead: 0,
              behind: 0,
              dirtyCount: 0,
              state: "clean",
            }];
          case "status":
            return { staged: [], unstaged: [] };
          case "stash_list":
            return [];
          case "fs_tree":
            return {
              entries: args.options && (args.options as { path: string }).path === ""
                ? [{ name: "main.ts", isDir: false, status: null, size: 18, mtime: 1_700_000_000 }]
                : [],
            };
          case "blame":
            return {
              lines: [{
                line: 1,
                sha,
                author: "Ada Lovelace",
                time: 1_700_000_000,
                summary: "Add attributed source",
                ageBucket: "older",
              }],
              groups: [{ sha, start: 1, end: 1 }],
            };
          case "file_history":
            return [{
              sha,
              author: "Ada Lovelace",
              message: "Add attributed source",
              time: 1_700_000_000,
            }];
          case "fs_read":
            return {
              bytes: Array.from(new TextEncoder().encode("const value = 1;\n")),
              encoding: "utf-8",
              eol: "LF",
              mtime: 1_700_000_000,
            };
          case "log_graph":
            return {
              page: args.page,
              pageSize: 500,
              totalCommits: 1,
              hasMore: false,
              commits: [commit],
              wip: {
                worktreePath: worktree,
                head: sha,
                branch: "main",
                stagedFiles: [],
                unstagedFiles: [],
                untrackedFiles: [],
                conflictedFiles: [],
              },
              userEmail: "ada@example.com",
            };
          case "graph_commit_detail":
            return { sha: args.sha, changedPaths: ["main.ts"] };
          default:
            throw new Error(`Unexpected mocked IPC command: ${command}`);
        }
      },
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: internals,
    });
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      configurable: true,
      value: { unregisterListener: (_event: string, id: number) => callbacks.delete(id) },
    });
  }, { worktree: WORKTREE, sha: SHA });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "main, Clean" })).toBeVisible();
  await page.getByRole("button", { name: "Files & editor" }).click();
  await page.locator(".files-tree-node", { hasText: "main.ts" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Blame", exact: true }).click();
  await expect(page.getByText("const value = 1;")).toBeVisible();
  await expect(page.getByText("Ada Lovelace").first()).toBeVisible();

  await page.getByRole("button", { name: "View commit", exact: true }).click();

  await expect(page.getByRole("option", { name: /Add attributed source/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Add attributed source" })).toBeVisible();
});
