import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ghRateLimitStatus, ghRepoAssignedIssues, ghRepoPulls, ghRepoRemote, ghRepoRuns, openGithubRepoPage } from "../../ipc/repo";
import { summarizeWorktrees, createWorktree } from "../../ipc/worktrees";
import { useRepos } from "../../state/repos";
import { useGithubAccounts } from "../../github/store";
import { useSessions } from "../../agents/sessions";
import { useWorktrees } from "../../state/worktrees";
import { useStage } from "../../state/stage";
import { LaunchpadView } from "./LaunchpadScreen";

const { openHere } = vi.hoisted(() => ({ openHere: vi.fn() }));

vi.mock("../../ipc/repo", () => ({
  ghRateLimitStatus: vi.fn(), ghRepoAssignedIssues: vi.fn(), ghRepoPulls: vi.fn(), ghRepoRemote: vi.fn(),
  ghRepoRuns: vi.fn(), openGithubRepoPage: vi.fn(),
}));
vi.mock("../../ipc/worktrees", () => ({ summarizeWorktrees: vi.fn(), createWorktree: vi.fn() }));
vi.mock("../../terminal/dock", () => ({ useDock: { getState: () => ({ openHere }) } }));
vi.mock("../../ui/toast", () => ({ toast: vi.fn() }));

const projects = [
  { id: "p1", owner: "octo", name: "one", localPath: "/repos/one", groupId: "g1" },
  { id: "p2", owner: "octo", name: "two", localPath: "/repos/two", groupId: "g2" },
];
const pull = { number: 3, title: "Review this", author: "dev", url: "ignored", updatedAt: null, comments: 0, headBranch: "feature", baseBranch: "main", merged: false, state: "OPEN" };
const issue = { number: 7, title: "Fix assigned issue", author: "dev", url: "ignored", updatedAt: null, comments: 0, labels: [] };
const run = { id: 1, name: "Build", branch: "main", sha: "abc", message: "commit", actor: "dev", actorAvatar: null, status: "completed", conclusion: "success", createdAt: new Date().toISOString(), updatedAt: null, url: "ignored" };

beforeEach(() => {
  vi.clearAllMocks();
  useRepos.setState({ projects: projects as never, groups: [{ id: "g1", name: "One group", color: "blue", clonePathTemplate: "" }, { id: "g2", name: "Two group", color: "green", clonePathTemplate: "" }] as never, activeGroupId: "g1", activeProjectId: "p1", status: "ready" });
  useGithubAccounts.setState({ accounts: ["octo"], defaultAccount: "octo", ownerAccounts: {}, loaded: true });
  useSessions.setState({ sessions: [], loaded: true, newAgentPrompt: null, newAgentOpen: false });
  useWorktrees.setState({ projectId: null, worktrees: [], pinnedPaths: [], activePath: null, selections: {}, loading: false, error: null });
  useWorktrees.setState({ load: vi.fn(async (project) => {
    useWorktrees.setState({ projectId: project?.id ?? null, worktrees: [{ path: project?.localPath ?? "", branch: "main" } as never], activePath: project?.localPath ?? null });
  }) } as never);
  useStage.setState({ go: vi.fn() } as never);
  vi.mocked(ghRateLimitStatus).mockResolvedValue(null);
  vi.mocked(ghRepoRemote).mockImplementation(async (path) => ({ owner: "octo", repo: path.endsWith("two") ? "two" : "one", url: "unused" }));
  vi.mocked(ghRepoPulls).mockResolvedValue({ total: 1, pulls: [pull] });
  vi.mocked(ghRepoAssignedIssues).mockResolvedValue({ total: 1, issues: [issue] });
  vi.mocked(ghRepoRuns).mockResolvedValue([run]);
  vi.mocked(summarizeWorktrees).mockImplementation(async (projectId) => ({ total: 1, worktrees: [{ path: projectId === "p2" ? "/repos/two" : "/repos/one", branch: "main" } as never] }));
  vi.mocked(createWorktree).mockResolvedValue({ path: "/repos/fix-issue-7", branch: "fix/issue-7" } as never);
  vi.mocked(openGithubRepoPage).mockResolvedValue(undefined);
});

describe("LaunchpadView", () => {
  it("loads the selected group and shows its pull, worktree, and CI summary", async () => {
    render(<LaunchpadView />);
    expect(await screen.findByText("Review this")).toBeInTheDocument();
    expect(screen.getByText("100%" )).toBeInTheDocument();
    expect(ghRepoPulls).toHaveBeenCalledWith("octo", "one", "octo", "open");
    expect(ghRepoPulls).not.toHaveBeenCalledWith("octo", "two", "octo", "open");
    expect(ghRepoAssignedIssues).toHaveBeenCalledWith("octo", "one", "octo");
  });

  it("updates the project data when scope changes to all groups", async () => {
    render(<LaunchpadView />);
    await screen.findByText("Review this");
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "all" } });
    await waitFor(() => expect(ghRepoPulls).toHaveBeenCalledWith("octo", "two", "octo", "open"));
    expect(await screen.findAllByText("Fix assigned issue")).toHaveLength(2);
  });

  it("opens a safe pull route and sends issue context to the agent flow", async () => {
    render(<LaunchpadView />);
    await screen.findByText("Review this");
    const pullRow = screen.getByText("Review this").closest("article") as HTMLElement;
    fireEvent.click(within(pullRow).getByRole("button", { name: "Open" }));
    expect(openGithubRepoPage).toHaveBeenCalledWith("octo", "one", "pull", 3);
    const issueRow = screen.getByText("Fix assigned issue").closest("article") as HTMLElement;
    fireEvent.click(within(issueRow).getByRole("button", { name: "Assign to agent" }));
    await waitFor(() => expect(useSessions.getState().newAgentOpen).toBe(true));
    expect(useSessions.getState().newAgentPrompt).toContain("issue #7");
    expect(useStage.getState().go).toHaveBeenCalledWith("agents");
  });

  it("starts assigned work in a new worktree and opens its terminal", async () => {
    render(<LaunchpadView />);
    await screen.findByText("Review this");
    const issueRow = screen.getByText("Fix assigned issue").closest("article") as HTMLElement;
    fireEvent.click(within(issueRow).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(createWorktree).toHaveBeenCalledWith("p1", "/repos/fix-issue-7", "fix/issue-7"));
    await waitFor(() => expect(openHere).toHaveBeenCalledWith("/repos/fix-issue-7"));
  });
});
