import { expect, test, type Page } from "@playwright/test";

const WORKTREE = "/repos/main";

type InvokeCall = { command: string; args: Record<string, unknown> };

async function seedRebaseBackend(page: Page) {
  await page.addInitScript((worktree) => {
    const callbacks = new Map<number, (event: unknown) => void>();
    let callbackId = 0;
    let rebaseRunning = false;
    (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls = [];
    const commit = (n: number, message: string, parents: string[]) => ({
      sha: String(n).repeat(40),
      shortSha: String(n).repeat(7),
      parents,
      lane: 0,
      nodes: [{ lane: 0 }],
      edges: [],
      parentLanes: [],
      refs: n === 4 ? [{ name: "main", kind: "localBranch" }] : [],
      worktreeHeads: n === 4 ? [{ path: worktree, branch: "main" }] : [],
      authorName: "Rebase Author",
      authorEmail: "rebase@example.com",
      message,
      timestamp: 1_700_000_000 + n,
      timezoneOffsetMinutes: 0,
    });
    const base = commit(1, "Base commit", []);
    const first = commit(2, "Add parser", [base.sha]);
    const second = commit(3, "Add lexer", [first.sha]);
    const third = commit(4, "Fix typo", [second.sha]);
    const planCommit = (c: typeof base) => ({
      sha: c.sha,
      shortSha: c.shortSha,
      subject: c.message,
      authorName: c.authorName,
      authorEmail: c.authorEmail,
      timestamp: c.timestamp,
      isMerge: false,
    });
    const internals = {
      transformCallback: (callback: (event: unknown) => void) => {
        const id = ++callbackId;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
        (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls.push({ command, args });
        if (command === "plugin:event|listen") return args.handler;
        if (command === "plugin:event|unlisten") return undefined;
        switch (command) {
          case "groups_list":
          case "pins_list":
            return [];
          case "projects_list":
            return [{ id: "p1", owner: null, name: "repo", localPath: worktree, groupId: null }];
          case "settings_get":
            return null;
          case "settings_set":
            return undefined;
          case "worktree_list":
            return [{ path: worktree, branch: "main", head: third.sha, ahead: 0, behind: 0, dirtyCount: 0, state: "clean" }];
          case "log_graph":
            return {
              page: args.page,
              pageSize: 500,
              totalCommits: 4,
              hasMore: false,
              commits: [third, second, first, base],
              wip: null,
              userEmail: "rebase@example.com",
            };
          case "graph_commit_detail":
            return { sha: args.sha, changedPaths: [] };
          case "rebase_plan":
            return {
              branch: "main",
              base: args.base,
              commits: [planCommit(first), planCommit(second), planCommit(third)],
              truncated: false,
              pushed: false,
            };
          case "rebase_interactive":
            rebaseRunning = true;
            return { status: "conflict", backupRef: "refs/branchwork/backup/main/1", undoable: false };
          case "conflict_list":
            return { operation: rebaseRunning ? "rebase" : "none", files: [], truncated: false };
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
  }, WORKTREE);
}

function invokeCalls(page: Page, command: string): Promise<InvokeCall[]> {
  return page.evaluate(
    (name) => (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls.filter((call) => call.command === name),
    command,
  );
}

test("rebases from a Graph commit: reorder, change an action, start, then the in-progress panel offers Continue and Abort", async ({ page }) => {
  await seedRebaseBackend(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "main, Clean" })).toBeVisible();
  await page.getByRole("button", { name: "History" }).click();

  await page.getByRole("option", { name: /Base commit/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Rebase from here/ }).click();

  // The plan's commits, oldest first.
  const rows = page.locator(".rebase-list > li");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAccessibleName("Add parser");
  await expect(rows.nth(1)).toHaveAccessibleName("Add lexer");
  await expect(rows.nth(2)).toHaveAccessibleName("Fix typo");
  await expect(page.getByText("3 of 3 commits")).toBeVisible();

  // Reorder with the keyboard-accessible Move up button, then fix up the moved commit.
  await page.getByRole("button", { name: "Move 4444444 up" }).click();
  await expect(rows.nth(1)).toHaveAccessibleName("Fix typo");
  await page.getByRole("combobox", { name: "Action for 4444444" }).selectOption("fixup");
  await page.getByRole("combobox", { name: "Action for 2222222" }).selectOption("reword");
  await page.getByRole("textbox", { name: "New message for 2222222" }).fill("Add the parser");
  await expect(page.getByText("2 of 3 commits")).toBeVisible();
  await expect(page.getByText("↳ melded into the commit above")).toBeVisible();

  await page.getByRole("button", { name: "Start rebase" }).click();

  // Conflict outcome: the in-progress panel replaces the list.
  await expect(page.getByRole("heading", { name: "Rebase in progress" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue rebase" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Abort rebase" })).toBeEnabled();

  const [start] = await invokeCalls(page, "rebase_interactive");
  expect(start.args).toEqual({
    worktreePath: WORKTREE,
    request: {
      base: "1".repeat(40),
      steps: [
        { sha: "2".repeat(40), action: { kind: "reword", message: "Add the parser" } },
        { sha: "4".repeat(40), action: { kind: "fixup" } },
        { sha: "3".repeat(40), action: { kind: "pick" } },
      ],
    },
  });
});
