import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { ensureProfileDir, logoutProfile, resolveCliBinary } from "./cli";

afterEach(() => clearMocks());

it("rejects CLI commands outside Tauri", async () => {
  await expect(resolveCliBinary("claude")).rejects.toThrow("desktop app");
  await expect(ensureProfileDir("claude", "work")).rejects.toThrow("desktop app");
  await expect(logoutProfile("claude", "work", [".claude.json"])).rejects.toThrow("desktop app");
});

it("routes CLI registry commands through generated IPC bindings", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "cli_resolve") return "/opt/homebrew/bin/claude";
    if (command === "cli_logout_profile") return ["auth.json"];
    return "/Users/u/.branchwork/profiles/claude-work";
  });

  await expect(resolveCliBinary("claude")).resolves.toBe("/opt/homebrew/bin/claude");
  await expect(ensureProfileDir("claude", "work")).resolves.toBe(
    "/Users/u/.branchwork/profiles/claude-work",
  );
  await expect(logoutProfile("codex", "work", ["auth.json"])).resolves.toEqual(["auth.json"]);
  expect(calls).toEqual([
    { command: "cli_resolve", payload: { binary: "claude" } },
    { command: "cli_profile_dir", payload: { cliId: "claude", slug: "work" } },
    {
      command: "cli_logout_profile",
      payload: { cliId: "codex", slug: "work", credentialFiles: ["auth.json"] },
    },
  ]);
});
