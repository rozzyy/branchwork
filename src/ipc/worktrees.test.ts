import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  createUnpinnedWorktree,
  createWorktree,
  createWorktreeAtCommit,
  listWorktrees,
  summarizeWorktrees,
  pruneWorktrees,
  removeWorktree,
  type Worktree,
} from "./worktrees";
import { errorMessage, type AppError } from "./errors";

const worktree: Worktree = {
  path: "/repos/repo",
  branch: "main",
  head: "abc123",
  ahead: 1,
  behind: 2,
  dirtyCount: 3,
  state: "dirty",
};

afterEach(() => clearMocks());

it("rejects worktree reads outside Tauri", async () => {
  await expect(listWorktrees("project-1")).rejects.toThrow("desktop app");
  await expect(summarizeWorktrees("project-1")).rejects.toThrow("desktop app");
});

it("rejects worktree writes outside Tauri", async () => {
  await expect(createWorktree("project-1", "/repos/feature", "feature")).rejects.toThrow(
    "desktop app",
  );
  await expect(
    createWorktreeAtCommit("project-1", "/repos/feature", "feature", "0123456789abcdef"),
  ).rejects.toThrow("desktop app");
  await expect(removeWorktree("project-1", "/repos/feature")).rejects.toThrow("desktop app");
  await expect(pruneWorktrees("project-1")).rejects.toThrow("desktop app");
});

it("loads an exact worktree count with a bounded metadata sample", async () => {
  mockWindows("main");
  const summary = { total: 240, worktrees: [worktree] };
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => { calls.push({ command, payload }); return summary; });
  await expect(summarizeWorktrees("project-1")).resolves.toEqual(summary);
  expect(calls).toEqual([{ command: "worktree_summary", payload: { projectId: "project-1" } }]);
});

it("invokes the typed worktree list command with its project id", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return [worktree];
  });

  await expect(listWorktrees("project-1")).resolves.toEqual([worktree]);
  expect(calls).toEqual([{ command: "worktree_list", payload: { projectId: "project-1" } }]);
});

it("preserves typed AppError rejections from generated IPC commands", async () => {
  mockWindows("main");
  const appError: AppError = {
    kind: "notFound",
    message: "Project not found",
    detail: null,
    recoverable: false,
  };
  mockIPC(() => {
    throw appError;
  });

  await expect(listWorktrees("missing-project").catch(errorMessage)).resolves.toBe(
    "Project not found",
  );
});

it("routes worktree lifecycle operations through typed Tauri commands", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return command === "worktree_create" || command === "worktree_create_at_commit" ? worktree : undefined;
  });

  await expect(createWorktree("project-1", "/repos/feature", "feature")).resolves.toEqual(worktree);
  await expect(
    createWorktreeAtCommit("project-1", "/repos/selected", "selected", "0123456789abcdef"),
  ).resolves.toEqual(worktree);
  await expect(removeWorktree("project-1", "/repos/feature")).resolves.toBeUndefined();
  await expect(pruneWorktrees("project-1")).resolves.toBeUndefined();
  expect(calls).toEqual([
    {
      command: "worktree_create",
      payload: { projectId: "project-1", destination: "/repos/feature", branch: "feature" },
    },
    {
      command: "worktree_create_at_commit",
      payload: {
        projectId: "project-1",
        destination: "/repos/selected",
        branch: "selected",
        commit: "0123456789abcdef",
      },
    },
    {
      command: "worktree_remove",
      payload: { projectId: "project-1", path: "/repos/feature", deleteBranch: false },
    },
    { command: "worktree_prune", payload: { projectId: "project-1" } },
  ]);
});

it("creates a worktree and unpins it for race/handover use", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "worktree_create") return { ...worktree, path: "/repos/race-x-a" };
    return true;
  });

  await expect(
    createUnpinnedWorktree("project-1", "/repos/race-x-a", "race/x-a"),
  ).resolves.toMatchObject({ path: "/repos/race-x-a" });
  expect(calls).toEqual([
    {
      command: "worktree_create",
      payload: { projectId: "project-1", destination: "/repos/race-x-a", branch: "race/x-a" },
    },
    {
      command: "unpin_worktree",
      payload: { projectId: "project-1", worktreePath: "/repos/race-x-a" },
    },
  ]);
});

it("passes branch deletion through to the backend remove command", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return null;
  });

  await expect(removeWorktree("project-1", "/repos/race-x-a", true)).resolves.toBeUndefined();
  expect(calls).toEqual([
    {
      command: "worktree_remove",
      payload: { projectId: "project-1", path: "/repos/race-x-a", deleteBranch: true },
    },
  ]);
});
