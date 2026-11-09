import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { ensureAgentHooks, notifySocketPath } from "./notify";

afterEach(() => clearMocks());

it("rejects notify commands outside Tauri", async () => {
  await expect(notifySocketPath()).rejects.toThrow("desktop app");
  await expect(ensureAgentHooks("claude", "/p")).rejects.toThrow("desktop app");
});

it("routes notify commands through generated IPC bindings", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "cli_ensure_hooks") return true;
    return "/tmp/branchwork-501/notify.sock";
  });

  await expect(notifySocketPath()).resolves.toBe("/tmp/branchwork-501/notify.sock");
  await expect(ensureAgentHooks("claude", "/p/claude-x")).resolves.toBe(true);
  expect(calls).toEqual([
    { command: "notify_socket_path", payload: {} },
    { command: "cli_ensure_hooks", payload: { cliId: "claude", profileDir: "/p/claude-x" } },
  ]);
});
