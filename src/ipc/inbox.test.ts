import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { ghNotifications, markAllGithubNotificationsRead, markGithubNotificationRead } from "./inbox";

afterEach(() => clearMocks());

it("routes Inbox reads and mutations through generated IPC bindings", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "gh_notifications") return { notifications: [], failures: [] };
    return null;
  });

  await expect(ghNotifications(["octocat"])).resolves.toEqual({ notifications: [], failures: [] });
  await expect(markGithubNotificationRead("octocat", "123")).resolves.toBeUndefined();
  await expect(markAllGithubNotificationsRead("octocat")).resolves.toBeUndefined();
  expect(calls).toEqual([
    { command: "gh_notifications", payload: { accounts: ["octocat"] } },
    { command: "gh_notification_mark_read", payload: { account: "octocat", threadId: "123" } },
    { command: "gh_notifications_mark_read_all", payload: { account: "octocat" } },
  ]);
});
