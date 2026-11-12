import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ghNotifications, markAllGithubNotificationsRead, markGithubNotificationRead } from "../../ipc/inbox";
import { ghRateLimitStatus, openGithubRepoPage } from "../../ipc/repo";
import { loadSetting, saveSetting } from "../../ipc/settings";
import { useGithubAccounts } from "../../github/store";
import { useSessions, type AgentSession } from "../../agents/sessions";
import { useStage } from "../../state/stage";
import { InboxView } from "./InboxScreen";

vi.mock("../../ipc/inbox", () => ({
  ghNotifications: vi.fn(),
  markAllGithubNotificationsRead: vi.fn(),
  markGithubNotificationRead: vi.fn(),
}));
vi.mock("../../ipc/repo", () => ({
  ghRateLimitStatus: vi.fn(),
  openGithubRepoPage: vi.fn(),
}));
vi.mock("../../ipc/settings", () => ({ loadSetting: vi.fn(), saveSetting: vi.fn() }));
vi.mock("../../ui/toast", () => ({ toast: vi.fn() }));

const notification = {
  id: "123",
  account: "octocat",
  owner: "octo",
  repo: "repo",
  title: "Please review PR 7",
  reason: "review_requested",
  subjectType: "PullRequest",
  unread: true,
  updatedAt: "2026-11-12T12:00:00Z",
  page: "pull" as const,
  number: 7,
};

function agentSession(status: "waiting" | "done"): AgentSession {
  return {
    id: "agent-test-1",
    cliId: "codex",
    profile: { cliId: "codex", slug: "personal" },
    worktreePath: "/repos/app",
    sessionId: "pty-1",
    slot: "auto",
    error: null,
    sharedWithDock: false,
    status,
    limitHit: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSetting).mockResolvedValue(null);
  vi.mocked(saveSetting).mockResolvedValue(undefined);
  vi.mocked(ghRateLimitStatus).mockResolvedValue(null);
  vi.mocked(ghNotifications).mockResolvedValue({ notifications: [notification], failures: [] });
  vi.mocked(markGithubNotificationRead).mockResolvedValue(undefined);
  vi.mocked(markAllGithubNotificationsRead).mockResolvedValue(undefined);
  vi.mocked(openGithubRepoPage).mockResolvedValue(undefined);
  useGithubAccounts.setState({ accounts: ["octocat"], defaultAccount: "octocat", ownerAccounts: {}, loaded: true });
  useSessions.setState({ sessions: [], loaded: true });
  useStage.setState({ go: vi.fn() } as never);
});

describe("InboxView", () => {
  it("keeps loading and empty feedback in the split view", async () => {
    let finishLoad!: (value: { notifications: typeof notification[]; failures: [] }) => void;
    vi.mocked(ghNotifications).mockImplementationOnce(() => new Promise((resolve) => { finishLoad = resolve; }));
    render(<InboxView />);

    const list = document.querySelector(".inbox-list") as HTMLElement;
    expect(await within(list).findByText("Loading inbox…")).toBeInTheDocument();
    finishLoad({ notifications: [], failures: [] });
    expect(await within(list).findByText("You're all caught up.")).toBeInTheDocument();
    expect(within(document.querySelector(".inbox-detail") as HTMLElement).getByText("You're all caught up.")).toBeInTheDocument();
  });

  it("shows a quota retry state and refreshes when requested", async () => {
    vi.mocked(ghRateLimitStatus)
      .mockResolvedValueOnce({ limit: 100, remaining: 1, reset_at: null, retry_after: 60 })
      .mockResolvedValueOnce(null);
    render(<InboxView />);

    const list = document.querySelector(".inbox-list") as HTMLElement;
    expect(await within(list).findByText(/GitHub quota is low/)).toBeInTheDocument();
    expect(ghNotifications).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("button", { name: "Please review PR 7" })).toBeInTheDocument();
    expect(ghNotifications).toHaveBeenCalledWith(["octocat"]);
  });

  it("maps CI and agent filters while keeping unknown GitHub reasons in All", async () => {
    vi.mocked(ghNotifications).mockResolvedValueOnce({
      notifications: [
        notification,
        { ...notification, id: "ci-1", title: "Build failed", reason: "ci_activity" },
        { ...notification, id: "unknown-1", title: "Subscribed thread", reason: "subscribed" },
      ],
      failures: [],
    });
    useSessions.setState({ sessions: [agentSession("waiting")] });
    render(<InboxView />);

    await screen.findByRole("button", { name: "Please review PR 7" });
    fireEvent.click(screen.getByRole("button", { name: "CI" }));
    expect(await screen.findByRole("button", { name: "Build failed" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Subscribed thread" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(await screen.findByRole("button", { name: "Codex is waiting for input" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build failed" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(await screen.findByRole("button", { name: "Subscribed thread" })).toBeInTheDocument();
  });

  it("opens a safe contextual GitHub route and marks the notification read", async () => {
    render(<InboxView />);
    expect(await screen.findByRole("button", { name: "Please review PR 7" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Please review PR 7" })).toBeInTheDocument();
    const detail = document.querySelector(".inbox-detail") as HTMLElement;
    fireEvent.click(within(detail).getByRole("button", { name: "Review now" }));
    expect(openGithubRepoPage).toHaveBeenCalledWith("octo", "repo", "pull", 7);
    fireEvent.click(within(detail).getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(markGithubNotificationRead).toHaveBeenCalledWith("octocat", "123"));
  });

  it("filters by notification category without marking selection read", async () => {
    render(<InboxView />);
    await screen.findByRole("button", { name: "Please review PR 7" });
    fireEvent.click(screen.getByRole("button", { name: "Mention" }));
    expect(within(document.querySelector(".inbox-list") as HTMLElement).getByText("You're all caught up.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("button", { name: "Please review PR 7" })).toBeInTheDocument();
    expect(markGithubNotificationRead).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute("aria-pressed", "true");
  });

  it("marks all GitHub notifications read", async () => {
    render(<InboxView />);
    await screen.findByRole("button", { name: "Please review PR 7" });
    fireEvent.click(screen.getByRole("button", { name: "Read all" }));
    await waitFor(() => expect(markAllGithubNotificationsRead).toHaveBeenCalledWith("octocat"));
  });

  it("snoozes a notification for one day and shows account errors inside the list", async () => {
    vi.mocked(ghNotifications).mockResolvedValueOnce({
      notifications: [notification],
      failures: [{ account: "other-account", message: "temporary failure" }],
    });
    render(<InboxView />);
    await screen.findByRole("button", { name: "Please review PR 7" });
    expect(screen.getByRole("alert")).toHaveTextContent("temporary failure");
    const row = screen.getByRole("button", { name: "Please review PR 7" }).closest(".inbox-item") as HTMLElement;
    const before = Date.now();
    fireEvent.click(within(row).getByRole("button", { name: "Snooze" }));
    await waitFor(() => {
      const saved = vi.mocked(saveSetting).mock.calls
        .filter(([key]) => key === "inboxState")
        .map(([, value]) => value as { snoozedUntil?: Record<string, number> })
        .find((value) => value.snoozedUntil?.["github:octocat:123"]);
      expect(saved?.snoozedUntil?.["github:octocat:123"]).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
    });
  });

  it("dismisses an agent event without closing or stopping its session", async () => {
    useSessions.setState({ sessions: [agentSession("waiting")] });
    render(<InboxView />);
    expect(await screen.findByRole("button", { name: "Codex is waiting for input" })).toBeInTheDocument();
    const row = screen.getByRole("button", { name: "Codex is waiting for input" }).closest(".inbox-item") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Codex is waiting for input" })).not.toBeInTheDocument());
    expect(useSessions.getState().sessions).toHaveLength(1);
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
  });

  it("allows dismissing an already-finished agent event", async () => {
    useSessions.setState({ sessions: [agentSession("done")] });
    render(<InboxView />);
    expect(await screen.findByRole("button", { name: "Codex finished" })).toBeInTheDocument();
    const row = screen.getByRole("button", { name: "Codex finished" }).closest(".inbox-item") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Codex finished" })).not.toBeInTheDocument());
    expect(useSessions.getState().sessions).toHaveLength(1);
    expect(useSessions.getState().sessions[0].status).toBe("done");
  });
});
