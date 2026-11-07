import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { readStatus, type StatusSummary } from "./status";

const summary: StatusSummary = {
  staged: [
    {
      path: "src/app.ts",
      oldPath: null,
      indexStatus: "M",
      worktreeStatus: "",
      bytes: 42,
      large: false,
    },
  ],
  unstaged: [],
};

afterEach(() => clearMocks());

it("rejects status reads outside Tauri", async () => {
  await expect(readStatus("/repos/repo")).rejects.toThrow("desktop app");
});

it("routes status reads through the generated command binding", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return summary;
  });

  await expect(readStatus("/repos/repo")).resolves.toEqual(summary);
  expect(calls).toEqual([{ command: "status", payload: { worktreePath: "/repos/repo" } }]);
});
