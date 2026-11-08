import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  attachTerminal,
  closeTerminal,
  detachTerminal,
  resizeTerminal,
  spawnTerminal,
  writeTerminal,
  type PtySession,
} from "./pty";

const session: PtySession = { sessionId: "pty-1" };

afterEach(() => clearMocks());

it("rejects terminal commands outside Tauri", async () => {
  await expect(spawnTerminal("/repos/repo", 100, 30)).rejects.toThrow("desktop app");
  await expect(writeTerminal("pty-1", new Uint8Array([0x0a]))).rejects.toThrow("desktop app");
  await expect(resizeTerminal("pty-1", 100, 30)).rejects.toThrow("desktop app");
  await expect(attachTerminal("pty-1", 1)).rejects.toThrow("desktop app");
  await expect(detachTerminal("pty-1", 1)).rejects.toThrow("desktop app");
  await expect(closeTerminal("pty-1")).rejects.toThrow("desktop app");
});

it("routes PTY commands through generated IPC bindings", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return command === "pty_spawn" ? session : undefined;
  });

  await expect(spawnTerminal("/repos/repo", 100, 30)).resolves.toEqual(session);
  await expect(writeTerminal("pty-1", new Uint8Array([0x68, 0x69, 0x0a]))).resolves.toBeUndefined();
  await expect(resizeTerminal("pty-1", 120, 40)).resolves.toBeUndefined();
  await expect(attachTerminal("pty-1", 3)).resolves.toBeUndefined();
  await expect(detachTerminal("pty-1", 3)).resolves.toBeUndefined();
  await expect(closeTerminal("pty-1")).resolves.toBeUndefined();
  expect(calls).toEqual([
    {
      command: "pty_spawn",
      payload: { worktreePath: "/repos/repo", columns: 100, rows: 30 },
    },
    { command: "pty_write", payload: { sessionId: "pty-1", data: [0x68, 0x69, 0x0a] } },
    { command: "pty_resize", payload: { sessionId: "pty-1", columns: 120, rows: 40 } },
    { command: "pty_attach", payload: { sessionId: "pty-1", attachmentId: 3 } },
    { command: "pty_detach", payload: { sessionId: "pty-1", attachmentId: 3 } },
    { command: "pty_close", payload: { sessionId: "pty-1" } },
  ]);
});
