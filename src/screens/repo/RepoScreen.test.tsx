import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoView } from "./RepoScreen";
import { useGithubAccounts } from "../../github/store";
import { useStage } from "../../state/stage";
import { useFiles } from "../../state/files";
import { useWorktrees } from "../../state/worktrees";
import {
  ghRepoContributors,
  ghRepoFork,
  ghRepoIssues,
  ghRepoMeta,
  ghRepoPulls,
  ghRepoRemote,
  ghRepoRerun,
  ghRepoRuns,
  ghRepoSetStarred,
  ghRepoSetWatched,
  openGithubRepoPage,
  gitRepoBranches,
  gitRepoLatestCommit,
  gitRepoReadFile,
  gitRepoTree,
} from "../../ipc/repo";
import { createWorktree } from "../../ipc/worktrees";
import { useRepos } from "../../state/repos";
import { useSessions } from "../../agents/sessions";
import { useDock } from "../../terminal/dock";
import { useToasts } from "../../ui/toast";

const runFixture = {
  id: 99,
  name: "CI",
  branch: "main",
  sha: "abc1234567",
  message: "Fix it",
  actor: "octocat",
  actorAvatar: "https://a/u/1",
  status: "completed",
  conclusion: "failure",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  url: "https://github.com/o/r/actions/runs/99",
};

const runningFixture = {
  id: 100,
  name: "CI",
  branch: "dev",
  sha: "def4567890",
  message: "WIP",
  actor: "hubot",
  actorAvatar: null,
  status: "in_progress",
  conclusion: null,
  createdAt: "2026-01-03T00:00:00Z",
  updatedAt: null,
  url: "https://github.com/o/r/actions/runs/100",
};

vi.mock("../../ipc/repo", () => ({
  ghRepoRemote: vi.fn(),
  ghRepoMeta: vi.fn(),
  ghRepoContributors: vi.fn(),
  ghRepoSetStarred: vi.fn(),
  ghRepoSetWatched: vi.fn(),
  ghRepoFork: vi.fn(),
  ghRepoIssues: vi.fn(),
  ghRepoPulls: vi.fn(),
  ghRepoRuns: vi.fn(),
  ghRepoRerun: vi.fn(),
  openGithubRepoPage: vi.fn(),
  gitRepoBranches: vi.fn(),
  gitRepoLatestCommit: vi.fn(),
  gitRepoReadFile: vi.fn(),
  gitRepoTree: vi.fn(),
}));

vi.mock("../../ipc/worktrees", () => ({
  createWorktree: vi.fn(),
}));

vi.mock("../../ui/dialog", () => ({
  ask: vi.fn(),
}));

import { ask } from "../../ui/dialog";

const meta = {
  id: "R_1",
  isPrivate: false,
  description: "Demo repo",
  homepageUrl: null,
  topics: ["rust"],
  license: "MIT",
  stars: 42,
  forks: 7,
  watchers: 5,
  viewerStarred: false,
  viewerSubscription: "UNSUBSCRIBED",
  defaultBranch: "main",
  releases: [
    {
      name: "v1.0",
      tag: "v1.0.0",
      publishedAt: "2026-01-01T00:00:00Z",
      draft: false,
      isLatest: true,
      url: "https://github.com/o/r/releases/v1.0.0",
    },
  ],
  languages: [{ name: "Rust", color: "#dea584", size: 900 }],
};

const rootTree = [
  { name: "README.md", kind: "file", message: "docs", epoch: 42 },
  { name: "a.txt", kind: "file", message: "hello", epoch: 41 },
  { name: "sub", kind: "dir", message: "add files", epoch: 40 },
];

beforeEach(() => {
  useWorktrees.setState({
    projectId: "p1",
    worktrees: [{ path: "/wt/a" } as never],
    pinnedPaths: [],
    activePath: "/wt/a",
    loading: false,
    error: null,
  });
  useGithubAccounts.setState({
    accounts: ["octocat"],
    defaultAccount: "octocat",
    ownerAccounts: {},
    loaded: true,
  });
  useStage.setState({ panes: ["repo"], focus: 0 } as never);
  useFiles.setState({ open: [], current: null });
  vi.mocked(ghRepoRemote).mockReset().mockResolvedValue({
    owner: "o",
    repo: "r",
    url: "git@github.com:o/r.git",
  });
  vi.mocked(ghRepoMeta).mockReset().mockResolvedValue({ ...meta });
  vi.mocked(ghRepoContributors).mockReset().mockResolvedValue([
    { login: "octocat", contributions: 120, avatarUrl: "https://a/u/1" },
  ]);
  vi.mocked(gitRepoBranches)
    .mockReset()
    .mockResolvedValue({ current: "main", branches: ["dev", "main"], tagCount: 2 });
  vi.mocked(gitRepoLatestCommit)
    .mockReset()
    .mockResolvedValue({ hash: "abc123", message: "tip commit", author: "octocat", epoch: 43 });
  vi.mocked(gitRepoTree).mockReset().mockImplementation(async (_path, _ref, subdir) =>
    subdir === "" ? rootTree : [{ name: "b.txt", kind: "file", message: "nested", epoch: 39 }],
  );
  vi.mocked(gitRepoReadFile)
    .mockReset()
    .mockResolvedValue(Array.from(new TextEncoder().encode("# Hi")));
  vi.mocked(ask).mockReset().mockResolvedValue(true);
  vi.mocked(ghRepoSetStarred).mockReset().mockResolvedValue(true);
  vi.mocked(ghRepoSetWatched).mockReset().mockResolvedValue("SUBSCRIBED");
  vi.mocked(ghRepoFork).mockReset().mockResolvedValue("https://github.com/octocat/r");
  vi.mocked(ghRepoIssues)
    .mockReset()
    .mockResolvedValue({
      total: 2,
      issues: [
        {
          number: 12,
          title: "Fix it",
          author: "octocat",
          url: "https://github.com/o/r/issues/12",
          updatedAt: "2026-01-02T00:00:00Z",
          comments: 3,
          labels: [{ name: "bug", color: "d73a4a" }],
        },
        {
          number: 13,
          title: "Docs",
          author: "hubot",
          url: "https://github.com/o/r/issues/13",
          updatedAt: null,
          comments: 0,
          labels: [],
        },
      ],
    });
  vi.mocked(ghRepoPulls).mockReset().mockImplementation(async (_owner, _repo, _account, state) =>
    state === "open"
      ? {
          total: 4,
          pulls: [
            {
              number: 7,
              title: "Add GitHub login",
              author: "octocat",
              url: "https://github.com/o/r/pull/7",
              updatedAt: "2026-01-02T00:00:00Z",
              comments: 2,
              headBranch: "feat/auth",
              baseBranch: "main",
              merged: false,
              state: "OPEN",
            },
          ],
        }
      : {
          total: 10,
          pulls: [
            {
              number: 6,
              title: "Old change",
              author: "hubot",
              url: "https://github.com/o/r/pull/6",
              updatedAt: null,
              comments: 0,
              headBranch: "old",
              baseBranch: "main",
              merged: true,
              state: "CLOSED",
            },
          ],
        },
  );
  vi.mocked(openGithubRepoPage).mockReset().mockResolvedValue(undefined);
  vi.mocked(createWorktree)
    .mockReset()
    .mockImplementation(async (_projectId, _destination, branch) => ({
      path: `/repos/r/${branch.replaceAll("/", "-")}`,
      branch,
    }) as never);
  useRepos.setState({ projects: [] });
  useSessions.setState({ sessions: [] } as never);
  useDock.setState({ tabs: [], selectedId: null });
  vi.mocked(ghRepoRuns).mockReset().mockResolvedValue([runFixture, runningFixture]);
  vi.mocked(ghRepoRerun).mockReset().mockResolvedValue(undefined);
});

describe("repo screen", () => {
  it("shows loading feedback while the active worktree is being resolved", () => {
    useWorktrees.setState({ projectId: null, activePath: null, loading: false });
    useRepos.setState({ activeProjectId: "p1", status: "ready" });
    render(<RepoView />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading repository…");
    expect(ghRepoRemote).not.toHaveBeenCalled();
  });

  it("shows loading feedback while GitHub account settings are loading", async () => {
    useGithubAccounts.setState({
      loaded: false,
      load: vi.fn(() => new Promise<void>(() => {})),
    });
    render(<RepoView />);
    expect(await screen.findByRole("status")).toHaveTextContent("Loading repository…");
    expect(screen.queryByText("No linked GitHub account for this repo.")).not.toBeInTheDocument();
  });

  it("renders header, code table, and sidebar from fixtures", async () => {
    render(<RepoView />);
    const title = await screen.findByRole("heading", { level: 2 });
    expect(title).toHaveTextContent("o/r");
    // Latest-release pill renders from the new isLatest flag.
    expect(await screen.findByText("Latest")).toBeInTheDocument();
    // Meta, branches, tree, and README all settle.
    expect(await screen.findByText("2 branches · 2 tags")).toBeInTheDocument();
    expect(screen.getByText("Demo repo")).toBeInTheDocument();
    expect(await screen.findByText("hello")).toBeInTheDocument();
    // Commit author, serving-account chip, and contributor each show the login.
    expect(screen.getAllByText("octocat")).toHaveLength(3);
    expect(screen.getByText("Rust")).toBeInTheDocument();
    expect(screen.getByText("v1.0")).toBeInTheDocument();
    // README rendered below the table.
    expect(await screen.findByText("Hi")).toBeInTheDocument();
  });

  it("switches the viewed ref through the branch selector", async () => {
    render(<RepoView />);
    expect(await screen.findByText("hello")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Branch"), { target: { value: "dev" } });
    await waitFor(() => expect(gitRepoTree).toHaveBeenCalledWith("/wt/a", "dev", ""));
    await waitFor(() => expect(gitRepoLatestCommit).toHaveBeenCalledWith("/wt/a", "dev"));
    await waitFor(() => expect(gitRepoReadFile).toHaveBeenCalledWith("/wt/a", "dev", "README.md"));
  });

  it("drills into subdirs and opens files in the Files screen", async () => {
    render(<RepoView />);
    fireEvent.click(await screen.findByRole("button", { name: /sub add files/ }));
    await waitFor(() => expect(gitRepoTree).toHaveBeenCalledWith("/wt/a", "main", "sub"));
    expect(await screen.findByText("nested")).toBeInTheDocument();
    // Root rows are gone while drilled in; go back first.
    fireEvent.click(screen.getByRole("button", { name: "Back to root" }));
    fireEvent.click(await screen.findByRole("button", { name: /a\.txt hello/ }));
    expect(useFiles.getState().current).toBe("a.txt");
    expect(useStage.getState().panes).toContain("files");
  });

  it("lets the user pick the serving account for org repos", async () => {
    useGithubAccounts.setState({
      accounts: ["rozzyy", "rozzyrahmanda"],
      defaultAccount: "rozzyy",
      ownerAccounts: {},
      loaded: true,
    });
    vi.mocked(ghRepoRemote).mockResolvedValue({
      owner: "Shopfoodie",
      repo: "hiiboss-core-api",
      url: "git@github-work:Shopfoodie/hiiboss-core-api.git",
    });
    render(<RepoView />);
    // Remote casing is preserved, never lowercased.
    const title = await screen.findByRole("heading", { level: 2 });
    expect(title).toHaveTextContent("Shopfoodie/hiiboss-core-api");
    // The org matches no username, so the default account serves first.
    await waitFor(() =>
      expect(ghRepoMeta).toHaveBeenCalledWith("Shopfoodie", "hiiboss-core-api", "rozzyy"),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Switch GitHub account (current: rozzyy)",
      }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "rozzyrahmanda" }));
    await waitFor(() =>
      expect(ghRepoMeta).toHaveBeenCalledWith("Shopfoodie", "hiiboss-core-api", "rozzyrahmanda"),
    );
    // The per-owner memory stays case-insensitive even though display keeps casing.
    expect(useGithubAccounts.getState().ownerAccounts).toEqual({
      shopfoodie: "rozzyrahmanda",
    });
  });

  it("toggles star and watch, and forks after confirmation", async () => {
    render(<RepoView />);
    const starButton = await screen.findByRole("button", { name: /Star42/ });
    await waitFor(() => expect(starButton).toBeEnabled());
    fireEvent.click(starButton);
    await waitFor(() =>
      expect(ghRepoSetStarred).toHaveBeenCalledWith("o", "r", "octocat", true),
    );
    expect(await screen.findByRole("button", { name: /Unstar/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Watch5/ }));
    await waitFor(() =>
      expect(ghRepoSetWatched).toHaveBeenCalledWith("o", "r", "octocat", true),
    );
    fireEvent.click(screen.getByRole("button", { name: /Fork7/ }));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    await waitFor(() => expect(ghRepoFork).toHaveBeenCalledWith("o", "r", "octocat"));
  });

  it("ignores an old account's star response after switching accounts", async () => {
    let resolveStarred!: (starred: boolean) => void;
    vi.mocked(ghRepoSetStarred).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStarred = resolve;
      }),
    );
    useGithubAccounts.setState({
      accounts: ["octocat", "other"],
      defaultAccount: "octocat",
      ownerAccounts: {},
      loaded: true,
    });
    render(<RepoView />);

    fireEvent.click(await screen.findByRole("button", { name: /Star42/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Switch GitHub account (current: octocat)" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "other" }));
    await waitFor(() =>
      expect(ghRepoMeta).toHaveBeenLastCalledWith("o", "r", "other"),
    );

    resolveStarred(true);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Star42/ })).toHaveAttribute("aria-pressed", "false"),
    );
  });

  it("shows empty states for missing remotes and accounts", async () => {
    vi.mocked(ghRepoRemote).mockRejectedValueOnce(new Error("no origin"));
    render(<RepoView />);
    expect(await screen.findByText("The active worktree is not on a GitHub repo.")).toBeInTheDocument();
    expect(ghRepoMeta).not.toHaveBeenCalled();
  });

  it("offers account connect when no account is linked", async () => {
    useGithubAccounts.setState({ accounts: [], defaultAccount: null, loaded: true });
    render(<RepoView />);
    expect(await screen.findByText("No linked GitHub account for this repo.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect an account" }));
    expect(useStage.getState().panes).toContain("settings");
  });
});

describe("repo issues tab", () => {
  async function openIssuesTab() {
    render(<RepoView />);
    expect(await screen.findByText("2 branches · 2 tags")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Issues/ }));
    expect(await screen.findByText("Fix it")).toBeInTheDocument();
    // Active filter, header totals, and tab show the server-side total.
    expect(screen.getByRole("button", { name: "2 Open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2 Closed/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Issues 2" })).toBeInTheDocument();
  }

  it("lists issues with labels and counts, and filters by state", async () => {
    await openIssuesTab();
    // Once in the row chip, once in the label filter dropdown.
    expect(screen.getAllByText("bug")).toHaveLength(2);
    expect(ghRepoIssues).toHaveBeenCalledWith("o", "r", "octocat", "open");
    fireEvent.click(screen.getByRole("button", { name: /Closed/ }));
    await waitFor(() => expect(ghRepoIssues).toHaveBeenCalledWith("o", "r", "octocat", "closed"));
  });

  it("filters issues by label", async () => {
    await openIssuesTab();
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "bug" } });
    expect(screen.queryByText("Docs")).not.toBeInTheDocument();
    expect(screen.getByText("Fix it")).toBeInTheDocument();
  });

  it("shows an agent badge for linked worktrees with live sessions", async () => {
    useWorktrees.setState({
      projectId: "p1",
      worktrees: [
        { path: "/repos/r/main", branch: "main" },
        { path: "/repos/r/fix-issue-12", branch: "fix/issue-12" },
      ] as never,
      pinnedPaths: [],
      activePath: "/repos/r/main",
      loading: false,
      error: null,
    });
    useSessions.setState({
      sessions: [{ id: "s1", worktreePath: "/repos/r/fix-issue-12", status: "running" }],
    } as never);
    await openIssuesTab();
    expect(screen.getByLabelText("Agent session linked")).toBeInTheDocument();
  });

  it("starts a worktree with a terminal for the issue branch", async () => {
    useWorktrees.setState({
      projectId: "p1",
      worktrees: [{ path: "/repos/r/main", branch: "main" }] as never,
      pinnedPaths: [],
      activePath: "/repos/r/main",
      loading: false,
      error: null,
    });
    useRepos.setState({
      projects: [{ id: "p1", owner: null, name: "r", localPath: "/repos/r/main", groupId: null }],
    });
    await openIssuesTab();
    fireEvent.click(screen.getAllByRole("button", { name: "Start → worktree" })[0]);
    await waitFor(() =>
      expect(createWorktree).toHaveBeenCalledWith("p1", "/repos/r/fix-issue-12", "fix/issue-12"),
    );
    await waitFor(() =>
      expect(useDock.getState().tabs.some((tab) => tab.worktreePath === "/repos/r/fix-issue-12")).toBe(
        true,
      ),
    );
  });

  it("opens a terminal when the issue worktree already exists", async () => {
    useWorktrees.setState({
      projectId: "p1",
      worktrees: [
        { path: "/repos/r/main", branch: "main" },
        { path: "/repos/r/fix-issue-12", branch: "fix/issue-12" },
      ] as never,
      pinnedPaths: [],
      activePath: "/repos/r/main",
      loading: false,
      error: null,
    });
    useRepos.setState({
      projects: [{ id: "p1", owner: null, name: "r", localPath: "/repos/r/main", groupId: null }],
    });
    await openIssuesTab();
    fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    await waitFor(() =>
      expect(useDock.getState().tabs.some((tab) => tab.worktreePath === "/repos/r/fix-issue-12")).toBe(
        true,
      ),
    );
    expect(createWorktree).not.toHaveBeenCalled();
  });
});

describe("repo pull requests tab", () => {
  it("shows filtered pull requests and opens the selected request on GitHub", async () => {
    render(<RepoView />);
    expect(await screen.findByText("2 branches · 2 tags")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Pull requests/ }));

    expect(await screen.findByText("Add GitHub login")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "4 Open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "10 Closed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pull requests 14" })).toBeInTheDocument();
    expect(screen.getByText("octocat · feat/auth → main · 2 comments")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Open pull request #7 on GitHub" })[0]);
    expect(openGithubRepoPage).toHaveBeenCalledWith("o", "r", "pull", 7);

    fireEvent.click(screen.getByRole("button", { name: "10 Closed" }));
    expect(await screen.findByText("Old change")).toBeInTheDocument();
    expect(screen.getByText("Merged")).toBeInTheDocument();
  });

  it("omits the Projects through Settings sections from repository navigation", async () => {
    render(<RepoView />);
    expect(await screen.findByText("2 branches · 2 tags")).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", { name: "Repository sections" });
    for (const section of ["Projects", "Wiki", "Security", "Insights", "Settings"]) {
      expect(within(navigation).queryByRole("button", { name: new RegExp(section) })).not.toBeInTheDocument();
    }
  });
});

describe("repo actions tab", () => {
  async function openActionsTab() {
    render(<RepoView />);
    expect(await screen.findByText("2 branches · 2 tags")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    // Short SHAs render in their own element; messages share a span.
    expect(await screen.findByText("abc1234")).toBeInTheDocument();
  }

  it("lists runs with status chips", async () => {
    vi.mocked(ghRepoRuns).mockResolvedValue([
      runFixture,
      runningFixture,
      { ...runningFixture, id: 101, status: "waiting_for_review" },
      { ...runFixture, id: 102, sha: "fed9876543", conclusion: "timed_out" },
    ]);
    await openActionsTab();
    expect(ghRepoRuns).toHaveBeenCalledWith("o", "r", "octocat");
    expect(screen.getByText("Failure")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toHaveClass("repo-tone-neutral");
    expect(screen.getByText("timed_out")).toHaveClass("repo-tone-neutral");
    expect(screen.getAllByRole("button", { name: "Re-run" })).toHaveLength(1);
    expect(screen.getByText("abc1234")).toBeInTheDocument();
  });

  it("ignores a refresh result after the active worktree changes", async () => {
    let activePathCalls = 0;
    let resolveRefresh: ((remote: { owner: string; repo: string; url: string }) => void) | undefined;
    vi.mocked(ghRepoRemote).mockImplementation((path) => {
      if (path === "/wt/a") {
        activePathCalls += 1;
        if (activePathCalls === 1) {
          return Promise.resolve({ owner: "o", repo: "r", url: "git@github.com:o/r.git" });
        }
        return new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      }
      return Promise.resolve({
        owner: "new",
        repo: "repo",
        url: "git@github.com:new/repo.git",
      });
    });

    render(<RepoView />);
    expect(await screen.findByRole("heading", { level: 2 })).toHaveTextContent("o/r");
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(ghRepoRemote).toHaveBeenCalledTimes(2));

    act(() => useWorktrees.setState({ activePath: "/wt/b" }));
    expect(await screen.findByRole("heading", { level: 2 })).toHaveTextContent("new/repo");

    await act(async () => {
      resolveRefresh?.({ owner: "stale", repo: "result", url: "git@github.com:stale/result.git" });
    });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("new/repo");
  });

  it("re-runs failed runs after confirmation", async () => {
    await openActionsTab();
    fireEvent.click(screen.getByRole("button", { name: "Re-run" }));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    await waitFor(() => expect(ghRepoRerun).toHaveBeenCalledWith("o", "r", "octocat", 99));
    await waitFor(() =>
      expect(useToasts.getState().toasts.some((toast) => toast.title === "Re-run started")).toBe(
        true,
      ),
    );
  });

  it("shows an empty state when there are no runs", async () => {
    vi.mocked(ghRepoRuns).mockResolvedValueOnce([]);
    render(<RepoView />);
    expect(await screen.findByText("2 branches · 2 tags")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(await screen.findByText("No workflow runs.")).toBeInTheDocument();
  });
});
