import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  readBlame,
  readFileHistory,
  type BlameResult,
  type FileHistoryEntry,
} from "./blame";

const blameResult: BlameResult = {
  lines: [
    {
      line: 1,
      sha: "abc123",
      author: "Ada",
      time: 1700000000,
      summary: "initial",
      ageBucket: "older",
    },
    {
      line: 2,
      sha: "abc123",
      author: "Ada",
      time: 1700000000,
      summary: "initial",
      ageBucket: "older",
    },
  ],
  groups: [{ sha: "abc123", start: 1, end: 2 }],
};

const history: FileHistoryEntry[] = [
  { sha: "def456", author: "Ada", message: "second", time: 1700000100 },
  { sha: "abc123", author: "Ada", message: "initial", time: 1700000000 },
];

afterEach(() => clearMocks());

it("rejects blame and history reads outside Tauri", async () => {
  await expect(readBlame("/repos/repo", "src/app.ts")).rejects.toThrow("desktop app");
  await expect(
    readFileHistory("/repos/repo", "src/app.ts", { limit: 10 }),
  ).rejects.toThrow("desktop app");
});

it("routes blame through the generated command binding with followRenames off by default", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return blameResult;
  });

  await expect(readBlame("/repos/repo", "src/app.ts")).resolves.toEqual(blameResult);
  expect(calls).toEqual([
    {
      command: "blame",
      payload: {
        worktreePath: "/repos/repo",
        path: "src/app.ts",
        options: { followRenames: false },
      },
    },
  ]);
});

it("routes file_history through the generated command binding and honors options", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return command === "blame" ? blameResult : history;
  });

  await expect(
    readFileHistory("/repos/repo", "src/app.ts", { limit: 2 }),
  ).resolves.toEqual(history);
  await expect(
    readBlame("/repos/repo", "src/app.ts", { followRenames: true }),
  ).resolves.toEqual(blameResult);
  expect(calls).toEqual([
    {
      command: "file_history",
      payload: {
        worktreePath: "/repos/repo",
        path: "src/app.ts",
        options: { limit: 2 },
      },
    },
    {
      command: "blame",
      payload: {
        worktreePath: "/repos/repo",
        path: "src/app.ts",
        options: { followRenames: true },
      },
    },
  ]);
});
