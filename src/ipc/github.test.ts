import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  githubAuthStatus,
  openGithubUrl,
  pollGithubDeviceFlow,
  setGithubToken,
  signOutGithub,
  startGithubDeviceFlow,
  verifyGithubPat,
} from "./github";

afterEach(() => clearMocks());

it("rejects GitHub auth commands outside Tauri", async () => {
  await expect(setGithubToken("ghp_x", "octocat")).rejects.toThrow("desktop app");
  await expect(githubAuthStatus("octocat")).rejects.toThrow("desktop app");
  await expect(githubAuthStatus()).rejects.toThrow("desktop app");
  await expect(signOutGithub("octocat")).rejects.toThrow("desktop app");
  await expect(startGithubDeviceFlow()).rejects.toThrow("desktop app");
  await expect(pollGithubDeviceFlow("gh-1")).rejects.toThrow("desktop app");
  await expect(verifyGithubPat("ghp_x")).rejects.toThrow("desktop app");
  await expect(openGithubUrl("https://github.com/login/device")).rejects.toThrow("desktop app");
});

it("routes GitHub auth commands through generated IPC bindings", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "gh_auth_set_token") return undefined;
    if (command === "gh_auth_status") return { linked: true };
    if (command === "gh_auth_sign_out") return true;
    if (command === "gh_auth_start") {
      return {
        request_id: "gh-1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      };
    }
    if (command === "gh_auth_poll") {
      return { state: "pending", username: null, interval: 5 };
    }
    if (command === "gh_auth_pat") return { username: "octocat" };
    if (command === "gh_open_url") return undefined;
    throw new Error(`unexpected ${command}`);
  });

  await expect(setGithubToken("ghp_x", "octocat")).resolves.toBeUndefined();
  await expect(githubAuthStatus("octocat")).resolves.toEqual({ linked: true });
  await expect(githubAuthStatus()).resolves.toEqual({ linked: true });
  await expect(signOutGithub("octocat")).resolves.toBe(true);
  await expect(startGithubDeviceFlow()).resolves.toEqual({
    requestId: "gh-1",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresIn: 900,
    interval: 5,
  });
  await expect(pollGithubDeviceFlow("gh-1")).resolves.toEqual({
    state: "pending",
    username: null,
    interval: 5,
  });
  await expect(verifyGithubPat("ghp_x")).resolves.toBe("octocat");
  await expect(openGithubUrl("https://github.com/login/device")).resolves.toBeUndefined();
  expect(calls).toEqual([
    { command: "gh_auth_set_token", payload: { token: "ghp_x", account: "octocat" } },
    { command: "gh_auth_status", payload: { account: "octocat" } },
    { command: "gh_auth_status", payload: { account: null } },
    { command: "gh_auth_sign_out", payload: { account: "octocat" } },
    { command: "gh_auth_start", payload: {} },
    { command: "gh_auth_poll", payload: { requestId: "gh-1" } },
    { command: "gh_auth_pat", payload: { token: "ghp_x" } },
    { command: "gh_open_url", payload: { url: "https://github.com/login/device" } },
  ]);
});
