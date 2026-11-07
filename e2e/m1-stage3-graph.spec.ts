import { expect, test } from "@playwright/test";

test("browses graph history and inspects the working copy and a commit", async ({ page }) => {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>();
    let callbackId = 0;
    const mainCommit = {
      sha: "1111111111111111111111111111111111111111",
      shortSha: "1111111",
      parents: [],
      lane: 0,
      nodes: [{ lane: 0 }],
      edges: [],
      parentLanes: [],
      refs: [{ name: "main", kind: "localBranch" }],
      worktreeHeads: [],
      authorName: "Graph Author",
      authorEmail: "graph@example.com",
      message: "Initial graph commit",
      timestamp: 1_700_000_000,
      timezoneOffsetMinutes: -300,
    };
    const worktreeCommit = {
      ...mainCommit,
      sha: "2222222222222222222222222222222222222222",
      shortSha: "2222222",
      parents: [mainCommit.sha],
      message: "Worktree head commit",
      worktreeHeads: [{ path: "/repos/main", branch: "main" }],
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
            return [{ id: "p1", owner: null, name: "repo", localPath: "/repos/main", groupId: null }];
          case "settings_get":
            return null;
          case "settings_set":
            return undefined;
          case "worktree_list":
            return [{
              path: "/repos/main",
              branch: "main",
              head: worktreeCommit.sha,
              ahead: 0,
              behind: 0,
              dirtyCount: 0,
              state: "clean",
            }];
          case "pins_list":
            return [];
          case "log_graph":
            return {
              page: args.page,
              pageSize: 500,
              totalCommits: 2,
              hasMore: false,
              commits: [worktreeCommit, mainCommit],
              wip: {
                worktreePath: "/repos/main",
                head: worktreeCommit.sha,
                branch: "main",
                stagedFiles: ["staged.ts"],
                unstagedFiles: ["edited.ts"],
                untrackedFiles: ["new.ts"],
                conflictedFiles: ["conflict.ts"],
              },
              userEmail: "graph@example.com",
            };
          case "graph_commit_detail":
            return { sha: args.sha, changedPaths: ["src/main.ts"] };
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
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "main, Clean" })).toBeVisible();
  await page.getByRole("button", { name: "Graph" }).click();

  await expect(page.getByRole("heading", { name: "Working copy" })).toBeVisible();
  await expect(page.getByText("staged.ts")).toBeVisible();
  await expect(page.getByText("edited.ts")).toBeVisible();
  const commit = page.getByRole("option", { name: /Initial graph commit/ });
  await expect(commit).toBeVisible();
  await expect(page.getByText("End of history · 2 commits", { exact: true })).toBeVisible();
  await commit.click();
  await expect(page.getByRole("heading", { name: "Initial graph commit" })).toBeVisible();
  await expect(page.getByText("src/main.ts")).toBeVisible();

  await page.getByRole("button", { name: "⌂ Worktrees", exact: true }).click();
  const worktreeCommitOption = page.getByRole("option", { name: /Worktree head commit/ });
  const otherCommitOption = page.getByRole("option", { name: /Initial graph commit/ });
  await expect(worktreeCommitOption).toBeVisible();
  await expect(worktreeCommitOption).not.toHaveClass(/dim/);
  await expect(otherCommitOption).toBeVisible();
  await expect(otherCommitOption).toHaveClass(/dim/);
});
