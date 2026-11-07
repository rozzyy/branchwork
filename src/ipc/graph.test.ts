import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { readGraphCommitDetail, readGraphPage, type GraphPage } from "./graph";

const graphPage: GraphPage = {
  page: 1,
  pageSize: 500,
  totalCommits: 501,
  hasMore: false,
  commits: [
    {
      sha: "0123456789abcdef",
      shortSha: "0123456",
      parents: ["fedcba9876543210"],
      lane: 0,
      nodes: [{ lane: 0 }],
      edges: [{ fromLane: 0, toLane: 1, parentIndex: 0 }],
      parentLanes: [1],
      refs: [{ name: "main", kind: "localBranch" }],
      worktreeHeads: [{ path: "/repos/repo", branch: "main" }],
      authorName: "Author",
      authorEmail: "author@example.com",
      message: "commit message",
      timestamp: 1_700_000_000,
      timezoneOffsetMinutes: -300,
    },
  ],
  userEmail: "author@example.com",
  wip: {
    worktreePath: "/repos/repo",
    head: "0123456789abcdef",
    branch: "main",
    stagedFiles: ["staged.txt"],
    unstagedFiles: [],
    untrackedFiles: [],
    conflictedFiles: [],
  },
};

afterEach(() => clearMocks());

it("rejects graph reads outside Tauri", async () => {
  await expect(readGraphPage("project-1", "/repos/repo", 0)).rejects.toThrow("desktop app");
});

it("rejects commit-detail reads outside Tauri", async () => {
  await expect(readGraphCommitDetail("project-1", "/repos/repo", "0123456789abcdef")).rejects.toThrow(
    "desktop app",
  );
});

it("invokes log_graph with its typed paging and active-worktree arguments", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return graphPage;
  });

  await expect(readGraphPage("project-1", "/repos/repo", 1)).resolves.toEqual(graphPage);
  expect(calls).toEqual([
    {
      command: "log_graph",
      payload: { projectId: "project-1", worktreePath: "/repos/repo", page: 1 },
    },
  ]);
});

it("reads changed paths through the typed commit-detail command", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return { sha: "0123456789abcdef", changedPaths: ["src/main.ts"] };
  });

  await expect(readGraphCommitDetail("project-1", "/repos/repo", "0123456789abcdef")).resolves.toEqual({
    sha: "0123456789abcdef",
    changedPaths: ["src/main.ts"],
  });
  expect(calls).toEqual([
    {
      command: "graph_commit_detail",
      payload: { projectId: "project-1", worktreePath: "/repos/repo", sha: "0123456789abcdef" },
    },
  ]);
});
