import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  ensureProfileDir,
  logoutProfile,
  probeCli,
  profileHasCredentials,
  removeProfileData,
  resolveCliBinary,
  seedClaudeOnboarding,
} from "./cli";

afterEach(() => clearMocks());

it("rejects CLI commands outside Tauri", async () => {
  await expect(resolveCliBinary("claude")).rejects.toThrow("desktop app");
  await expect(ensureProfileDir("claude", "work")).rejects.toThrow("desktop app");
  await expect(logoutProfile("claude", "work", [".claude.json"])).rejects.toThrow("desktop app");
  await expect(profileHasCredentials("claude", "work", [".claude.json"])).rejects.toThrow(
    "desktop app",
  );
  await expect(removeProfileData("claude", "work")).rejects.toThrow("desktop app");
  await expect(probeCli("claude")).rejects.toThrow("desktop app");
  await expect(seedClaudeOnboarding("claude", "work")).rejects.toThrow("desktop app");
});

it("routes CLI registry commands through generated IPC bindings", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "cli_resolve") return "/opt/homebrew/bin/claude";
    if (command === "cli_logout_profile") return ["auth.json"];
    if (command === "cli_has_credentials") return true;
    if (command === "cli_remove_profile") return true;
    if (command === "cli_seed_onboarding") return true;
    return "/Users/u/.branchwork/profiles/claude-work";
  });

  await expect(resolveCliBinary("claude")).resolves.toBe("/opt/homebrew/bin/claude");
  await expect(ensureProfileDir("claude", "work")).resolves.toBe(
    "/Users/u/.branchwork/profiles/claude-work",
  );
  await expect(logoutProfile("codex", "work", ["auth.json"])).resolves.toEqual(["auth.json"]);
  await expect(profileHasCredentials("claude", "work", [".claude.json"])).resolves.toBe(true);
  await expect(removeProfileData("claude", "work")).resolves.toBe(true);
  await expect(seedClaudeOnboarding("claude", "work")).resolves.toBe(true);
  expect(calls).toEqual([
    { command: "cli_resolve", payload: { binary: "claude" } },
    { command: "cli_profile_dir", payload: { cliId: "claude", slug: "work" } },
    {
      command: "cli_logout_profile",
      payload: { cliId: "codex", slug: "work", credentialFiles: ["auth.json"] },
    },
    {
      command: "cli_has_credentials",
      payload: { cliId: "claude", slug: "work", credentialFiles: [".claude.json"] },
    },
    {
      command: "cli_remove_profile",
      payload: { cliId: "claude", slug: "work" },
    },
    {
      command: "cli_seed_onboarding",
      payload: { cliId: "claude", slug: "work" },
    },
  ]);
});

it("routes the status probe through generated IPC bindings", async () => {
  mockWindows("main");
  mockIPC((command) => {
    if (command === "cli_probe") return JSON.stringify({ loggedIn: true });
    throw new Error(`unexpected ${command}`);
  });
  await expect(probeCli("claude")).resolves.toBe(JSON.stringify({ loggedIn: true }));
});
