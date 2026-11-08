import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  fsCreate,
  fsDelete,
  fsRead,
  fsRename,
  fsTree,
  fsWrite,
  revealInFinder,
  type FsReadResult,
  type FsTree,
} from "./fs";

const tree: FsTree = {
  entries: [
    { name: "src", isDir: true, status: null, size: 0, mtime: 1000 },
    { name: "main.ts", isDir: false, status: "M", size: 42, mtime: 1000 },
  ],
};

const readResult: FsReadResult = {
  bytes: [104, 105],
  encoding: "utf-8",
  eol: "LF",
  mtime: 1000,
};

afterEach(() => clearMocks());

it("routes fs_tree and fs_read through their generated command bindings", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return command === "fs_tree" ? tree : readResult;
  });

  await expect(
    fsTree("/repos/repo", { path: "src", showIgnored: false }),
  ).resolves.toEqual(tree);
  await expect(fsRead("/repos/repo", "src/main.ts")).resolves.toEqual(readResult);

  expect(calls).toEqual([
    {
      command: "fs_tree",
      payload: { worktreePath: "/repos/repo", options: { path: "src", showIgnored: false } },
    },
    { command: "fs_read", payload: { worktreePath: "/repos/repo", path: "src/main.ts" } },
  ]);
});

it("routes write-capable fs commands through their generated command bindings", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return command === "fs_write" ? 2000 : undefined;
  });

  await expect(
    fsWrite("/repos/repo", "src/main.ts", [104, 105], 1000),
  ).resolves.toBe(2000);
  await expect(fsCreate("/repos/repo", "src/new.ts", "file")).resolves.toBeUndefined();
  await expect(fsRename("/repos/repo", "src/old.ts", "src/new.ts")).resolves.toBeUndefined();
  await expect(fsDelete("/repos/repo", "src/old.ts")).resolves.toBeUndefined();
  await expect(revealInFinder("/repos/repo", "src/main.ts")).resolves.toBeUndefined();

  expect(calls).toEqual([
    {
      command: "fs_write",
      payload: { worktreePath: "/repos/repo", path: "src/main.ts", bytes: [104, 105], expectedMtime: 1000 },
    },
    {
      command: "fs_create",
      payload: { worktreePath: "/repos/repo", path: "src/new.ts", kind: "file" },
    },
    {
      command: "fs_rename",
      payload: { worktreePath: "/repos/repo", from: "src/old.ts", to: "src/new.ts" },
    },
    { command: "fs_delete", payload: { worktreePath: "/repos/repo", path: "src/old.ts" } },
    {
      command: "reveal_in_finder",
      payload: { worktreePath: "/repos/repo", path: "src/main.ts" },
    },
  ]);
});
