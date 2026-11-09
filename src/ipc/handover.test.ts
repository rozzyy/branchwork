import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { readHandoverDiff, writeHandoverNote } from "./handover";

afterEach(() => clearMocks());

it("rejects handover commands outside Tauri", async () => {
  await expect(writeHandoverNote("/wt/a", "# Handover")).rejects.toThrow("desktop app");
  await expect(readHandoverDiff("/wt/a")).rejects.toThrow("desktop app");
});

it("routes handover commands through generated IPC bindings", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "agent_handover_diff") return "diff --git a/x b/x";
    return true;
  });

  await expect(writeHandoverNote("/wt/a", "# Handover")).resolves.toBe(true);
  await expect(readHandoverDiff("/wt/a")).resolves.toBe("diff --git a/x b/x");
  expect(calls).toEqual([
    { command: "agent_write_handover", payload: { worktreePath: "/wt/a", note: "# Handover" } },
    { command: "agent_handover_diff", payload: { worktreePath: "/wt/a" } },
  ]);
});
