import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  createWorktree,
  createWorktreeAtCommit,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  type Worktree,
} from "./worktrees";

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
    { command: "worktree_remove", payload: { projectId: "project-1", path: "/repos/feature" } },
    { command: "worktree_prune", payload: { projectId: "project-1" } },
  ]);
});
