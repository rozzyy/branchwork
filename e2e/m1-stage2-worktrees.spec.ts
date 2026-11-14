import { expect, test, type Page } from "@playwright/test";

async function seedWorktreeBackend(page: Page, failWorktreeList = false) {
  await page.addInitScript((shouldFailWorktreeList) => {
    if (shouldFailWorktreeList) localStorage.setItem("bw:e2e:worktree-list-error", "true");
    if (!localStorage.getItem("bw:e2e:worktrees")) {
      localStorage.setItem(
        "bw:e2e:worktrees",
        JSON.stringify([
          {
            path: "/repos/main",
            branch: "main",
            head: "a1",
            ahead: 0,
            behind: 0,
            dirtyCount: 0,
            state: "clean",
          },
        ]),
      );
    }
    if (!localStorage.getItem("bw:e2e:pins")) localStorage.setItem("bw:e2e:pins", JSON.stringify([]));
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
        if (command === "plugin:event|listen") return args.handler;
        if (command === "plugin:event|unlisten") return undefined;
        const settings = JSON.parse(localStorage.getItem("bw:e2e:settings") ?? "{}") as Record<string, string>;
        const worktrees = JSON.parse(localStorage.getItem("bw:e2e:worktrees") ?? "[]") as Array<Record<string, unknown>>;
        const pins = JSON.parse(localStorage.getItem("bw:e2e:pins") ?? "[]") as Array<{
          projectId: string;
          worktreePath: string;
        }>;
        switch (command) {
          case "groups_list":
            return [];
          case "projects_list":
            return [{ id: "p1", owner: null, name: "repo", localPath: "/repos/main", groupId: null }];
          case "settings_get":
            return settings[args.key as string] ?? null;
          case "settings_set":
            settings[args.key as string] = args.value as string;
            localStorage.setItem("bw:e2e:settings", JSON.stringify(settings));
            return undefined;
          case "worktree_list":
            if (localStorage.getItem("bw:e2e:worktree-list-error") === "true") {
              throw {
                kind: "notFound",
                message: "Project not found",
                detail: null,
                recoverable: false,
              };
            }
            return worktrees;
          case "worktree_create": {
            const created = {
              path: args.destination as string,
              branch: args.branch as string,
              head: "a2",
              ahead: 1,
              behind: 0,
              dirtyCount: 2,
              state: "dirty",
            };
            if (!worktrees.some((worktree) => worktree.path === created.path)) {
              worktrees.push(created);
              localStorage.setItem("bw:e2e:worktrees", JSON.stringify(worktrees));
            }
            const pin = { projectId: args.projectId as string, worktreePath: created.path };
            if (!pins.some((item) => item.projectId === pin.projectId && item.worktreePath === pin.worktreePath)) {
              pins.push(pin);
              localStorage.setItem("bw:e2e:pins", JSON.stringify(pins));
            }
            return created;
          }
          case "pins_list":
            return args.projectId ? pins.filter((pin) => pin.projectId === args.projectId) : pins;
          case "pin_worktree": {
            const pin = args.pin as { projectId: string; worktreePath: string };
            if (!pins.some((item) => item.projectId === pin.projectId && item.worktreePath === pin.worktreePath)) {
              pins.push(pin);
              localStorage.setItem("bw:e2e:pins", JSON.stringify(pins));
            }
            return undefined;
          }
          case "unpin_worktree": {
            const remaining = pins.filter(
              (pin) => pin.projectId !== args.projectId || pin.worktreePath !== args.worktreePath,
            );
            localStorage.setItem("bw:e2e:pins", JSON.stringify(remaining));
            return remaining.length !== pins.length;
          }
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
      value: {
        unregisterListener: (_event: string, id: number) => callbacks.delete(id),
      },
    });
    if (!localStorage.getItem("bw:e2e:worktree-created")) {
      // Mirrors createWorktree's typed command payload and seeds its auto-pin before React mounts.
      void internals.invoke("worktree_create", {
        projectId: "p1",
        destination: "/repos/feature",
        branch: "feature/sidebar",
      });
      localStorage.setItem("bw:e2e:worktree-created", "true");
    }
  }, failWorktreeList);
}

async function gotoWorktreeApp(page: Page) {
  await seedWorktreeBackend(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "main, Clean" })).toBeVisible();
}

test.describe("M1 Stage 2 worktree sidebar", () => {
  test("shows the message from a typed backend error", async ({ page }) => {
    await seedWorktreeBackend(page, true);
    await page.goto("/");

    await expect(page.getByRole("status")).toContainText("Project not found");
  });

  test("shows a created, auto-pinned worktree and restores selection and pin after reload", async ({ page }) => {
    await gotoWorktreeApp(page);
    const created = page.getByRole("button", { name: "feature/sidebar, 2 changes" });
    await expect(created).toBeVisible();
    await page.getByRole("button", { name: "Browse worktrees" }).click();

    const picker = page.getByRole("dialog", { name: "Browse worktrees" });
    await expect(picker.getByRole("checkbox", { name: "Unpin feature/sidebar" })).toBeChecked();

    await picker.getByRole("button", { name: "Select worktree feature/sidebar" }).click();
    await expect(created).toHaveAttribute("aria-current", "true");

    await page.reload();
    const selected = page.getByRole("button", { name: "feature/sidebar, 2 changes" });
    await expect(selected).toHaveAttribute("aria-current", "true");
    await page.getByRole("button", { name: "Browse worktrees" }).click();
    await expect(
      page.getByRole("dialog", { name: "Browse worktrees" }).getByRole("checkbox", { name: "Unpin feature/sidebar" }),
    ).toBeChecked();
  });
});
