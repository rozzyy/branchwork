import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { readDiff, type DiffModel } from "./diff";

const model: DiffModel = {
  hunks: [
    {
      oldStart: 1,
      newStart: 1,
      oldLines: 1,
      newLines: 1,
      lines: [
        { kind: "del", old: 1, new: null, text: "old", intra: null },
        { kind: "add", old: null, new: 1, text: "new", intra: null },
      ],
    },
  ],
  binary: false,
  truncated: false,
  bytes: 6,
};

afterEach(() => clearMocks());

it("rejects diff reads outside Tauri", async () => {
  await expect(readDiff("/repos/repo", "src/main.ts", "unstaged")).rejects.toThrow(
    "desktop app",
  );
});

it("routes diff reads through the generated command binding", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return model;
  });

  await expect(readDiff("/repos/repo", "src/main.ts", "staged")).resolves.toEqual(model);
  expect(calls).toEqual([
    {
      command: "diff_file",
      payload: { worktreePath: "/repos/repo", path: "src/main.ts", area: "staged" },
    },
  ]);
});
