import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ghNotifications, markAllGithubNotificationsRead, markGithubNotificationRead } from "../../ipc/inbox";
import { ghRateLimitStatus, openGithubRepoPage } from "../../ipc/repo";
import { loadSetting, saveSetting } from "../../ipc/settings";
import { useGithubAccounts } from "../../github/store";
import { useSessions, type AgentSession } from "../../agents/sessions";
import { useStage } from "../../state/stage";
import { InboxView } from "./InboxScreen";
import { useLaunchpadUi } from "../launchpad/launchpadUi";

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
    conversationId: null,
    savers: { rtk: "unsupported", caveman: "unsupported" },
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
  useLaunchpadUi.setState({ refreshRequest: 0 });
});

describe("InboxView", () => {
  const row = (name: string) => screen.findByRole("article", { name });

  it("keeps loading and empty feedback inside the attention panel", async () => {
    let finishLoad!: (value: { notifications: typeof notification[]; failures: [] }) => void;
    vi.mocked(ghNotifications).mockImplementationOnce(() => new Promise((resolve) => { finishLoad = resolve; }));
    render(<InboxView />);
    expect(await screen.findByText("Loading inbox…")).toBeInTheDocument();
    finishLoad({ notifications: [], failures: [] });
    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Needs your attention" })).toBeInTheDocument();
  });

  it("shows a quota retry state and refreshes when Home's Refresh is requested", async () => {
    vi.mocked(ghRateLimitStatus)
      .mockResolvedValueOnce({ limit: 100, remaining: 1, reset_at: null, retry_after: 60 })
      .mockResolvedValueOnce(null);
    render(<InboxView />);
    expect(await screen.findByText(/GitHub quota is low/)).toBeInTheDocument();
    expect(ghNotifications).not.toHaveBeenCalled();
    act(() => useLaunchpadUi.getState().requestRefresh());
    expect(await row("Please review PR 7")).toBeInTheDocument();
    expect(ghNotifications).toHaveBeenCalledWith(["octocat"]);
  });

  it("maps CI and agent tabs while keeping unknown GitHub reasons in All", async () => {
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
    await row("Please review PR 7");
    fireEvent.click(screen.getByRole("tab", { name: "CI" }));
    expect(await row("Build failed")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Subscribed thread" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    expect(await row("Codex is waiting for input")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Build failed" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(await row("Subscribed thread")).toBeInTheDocument();
  });

  it("opens a safe contextual GitHub route and marks the notification read from the row", async () => {
    render(<InboxView />);
    const item = await row("Please review PR 7");
    fireEvent.click(within(item).getByRole("button", { name: "Review now" }));
    expect(openGithubRepoPage).toHaveBeenCalledWith("octo", "repo", "pull", 7);
    fireEvent.click(within(item).getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(markGithubNotificationRead).toHaveBeenCalledWith("octocat", "123"));
  });

  it("filters by notification category without marking anything read", async () => {
    render(<InboxView />);
    await row("Please review PR 7");
    fireEvent.click(screen.getByRole("tab", { name: "Mention" }));
    expect(screen.getByText("You're all caught up.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    expect(await row("Please review PR 7")).toBeInTheDocument();
    expect(markGithubNotificationRead).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true");
  });

  it("marks all GitHub notifications read", async () => {
    render(<InboxView />);
    await row("Please review PR 7");
    fireEvent.click(screen.getByRole("button", { name: "Read all" }));
    await waitFor(() => expect(markAllGithubNotificationsRead).toHaveBeenCalledWith("octocat"));
  });

  it("snoozes a notification for one day and shows account errors inside the panel", async () => {
    vi.mocked(ghNotifications).mockResolvedValueOnce({
      notifications: [notification],
      failures: [{ account: "other-account", message: "temporary failure" }],
    });
    render(<InboxView />);
    const item = await row("Please review PR 7");
    expect(screen.getByRole("alert")).toHaveTextContent("temporary failure");
    const before = Date.now();
    fireEvent.click(within(item).getByRole("button", { name: "Snooze" }));
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
    const item = await row("Codex is waiting for input");
    fireEvent.click(within(item).getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Codex is waiting for input" })).not.toBeInTheDocument());
    expect(useSessions.getState().sessions).toHaveLength(1);
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
  });

  it("allows dismissing an already-finished agent event", async () => {
    useSessions.setState({ sessions: [agentSession("done")] });
    render(<InboxView />);
    const item = await row("Codex finished");
    fireEvent.click(within(item).getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Codex finished" })).not.toBeInTheDocument());
    expect(useSessions.getState().sessions).toHaveLength(1);
    expect(useSessions.getState().sessions[0].status).toBe("done");
  });
});
