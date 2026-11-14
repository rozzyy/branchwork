import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  readCompareFileDiff,
  readComparePatch,
  readCompareWorktrees,
  type CompareSummary,
} from "./compare";

const summary: CompareSummary = {
  files: [
    {
      path: "src/app.ts",
      oldPath: null,
      status: "modified",
      additions: 2,
      deletions: 1,
      binary: false,
      truncated: false,
    },
  ],
  truncated: false,
  untrackedExcluded: true,
};

afterEach(() => clearMocks());

it("rejects Compare IPC outside Tauri", async () => {
  await expect(readCompareWorktrees("/a", "/b", false)).rejects.toThrow("desktop app");
  await expect(readCompareFileDiff("/a", "/b", "src/app.ts", false)).rejects.toThrow("desktop app");
  await expect(readComparePatch("/a", "/b", false)).rejects.toThrow("desktop app");
});

it("sends worktree paths and include-uncommitted to the typed summary command", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return summary;
  });

  await expect(readCompareWorktrees("/repo/main", "/repo/side", true)).resolves.toEqual(summary);
  expect(calls).toEqual([
    {
      command: "compare_worktrees",
      payload: { a: "/repo/main", b: "/repo/side", includeUncommitted: true },
    },
  ]);
});

it("reads a selected compare diff and a bounded copy patch", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "compare_file_diff") {
      return { hunks: [], binary: false, truncated: false, bytes: 0 };
    }
    return "diff --git a/src/app.ts b/src/app.ts\n";
  });

  await expect(readCompareFileDiff("/repo/main", "/repo/side", "src/app.ts", false)).resolves.toEqual({
    hunks: [],
    binary: false,
    truncated: false,
    bytes: 0,
  });
  await expect(readComparePatch("/repo/main", "/repo/side", false)).resolves.toContain("diff --git");
  expect(calls).toEqual([
    {
      command: "compare_file_diff",
      payload: { a: "/repo/main", b: "/repo/side", path: "src/app.ts", includeUncommitted: false },
    },
    {
      command: "compare_patch",
      payload: { a: "/repo/main", b: "/repo/side", includeUncommitted: false },
    },
  ]);
});
