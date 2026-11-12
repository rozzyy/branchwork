import { commands } from "./bindings";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface GithubNotification {
  id: string;
  account: string;
  owner: string;
  repo: string;
  title: string;
  reason: string;
  subjectType: string;
  unread: boolean;
  updatedAt: string | null;
  page: "issues" | "issue" | "pulls" | "pull" | "actions";
  number: number | null;
}

export interface NotificationFailure {
  account: string;
  message: string;
}

export interface GithubNotificationBatch {
  notifications: GithubNotification[];
  failures: NotificationFailure[];
}

export function ghNotifications(accounts: string[]): Promise<GithubNotificationBatch> {
  if (!inTauri()) return Promise.reject(new Error("Loading GitHub notifications requires the desktop app"));
  return commands.ghNotifications(accounts).then((batch) => ({
    failures: batch.failures,
    notifications: batch.notifications.map((row) => ({
      ...row,
      page: ["issues", "issue", "pulls", "pull", "actions"].includes(row.page)
        ? row.page as GithubNotification["page"]
        : "issues",
    })),
  }));
}

export function markGithubNotificationRead(account: string, threadId: string): Promise<void> {
  if (!inTauri()) return Promise.reject(new Error("Updating GitHub notifications requires the desktop app"));
  return commands.ghNotificationMarkRead(account, threadId).then(() => undefined);
}

export function markAllGithubNotificationsRead(account: string): Promise<void> {
  if (!inTauri()) return Promise.reject(new Error("Updating GitHub notifications requires the desktop app"));
  return commands.ghNotificationsMarkReadAll(account).then(() => undefined);
}
