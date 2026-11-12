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
  it("opens a safe contextual GitHub route and marks the notification read", async () => {
    render(<InboxView />);
    expect(await screen.findByText("Please review PR 7")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }));
    expect(openGithubRepoPage).toHaveBeenCalledWith("octo", "repo", "pull", 7);
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(markGithubNotificationRead).toHaveBeenCalledWith("octocat", "123"));
  });

  it("dismisses an agent event without closing or stopping its session", async () => {
    useSessions.setState({ sessions: [agentSession("waiting")] });
    render(<InboxView />);
    expect(await screen.findByText("Codex is waiting for input")).toBeInTheDocument();
    const row = screen.getByText("Codex is waiting for input").closest(".inbox-item") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(screen.queryByText("Codex is waiting for input")).not.toBeInTheDocument());
    expect(useSessions.getState().sessions).toHaveLength(1);
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
  });

  it("allows dismissing an already-finished agent event", async () => {
    useSessions.setState({ sessions: [agentSession("done")] });
    render(<InboxView />);
    expect(await screen.findByText("Codex finished")).toBeInTheDocument();
    const row = screen.getByText("Codex finished").closest(".inbox-item") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(screen.queryByText("Codex finished")).not.toBeInTheDocument());
    expect(useSessions.getState().sessions).toHaveLength(1);
    expect(useSessions.getState().sessions[0].status).toBe("done");
  });
});
