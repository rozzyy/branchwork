import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { GraphCommit, GraphPage } from "../../ipc/graph";
import { useRepos } from "../../state/repos";
import { useStage } from "../../state/stage";
import { useWorktrees } from "../../state/worktrees";
import { GraphToolbar, GraphView, filterGraphCommits, graphLaneRows } from "./GraphScreen";
import { useGraphUi } from "./graphState";
import { readGraphCommitDetail, readGraphPage } from "../../ipc/graph";
import { createWorktreeAtCommit, onGitChanged } from "../../ipc/worktrees";
import { ask } from "../../ui/dialog";

vi.mock("../../ipc/graph", () => ({
  readGraphCommitDetail: vi.fn(),
  readGraphPage: vi.fn(),
}));
vi.mock("../../ipc/worktrees", () => ({ createWorktreeAtCommit: vi.fn(), onGitChanged: vi.fn() }));
vi.mock("../../ui/dialog", () => ({ ask: vi.fn() }));

const page0Commits = Array.from({ length: 500 }, (_, index) => makeCommit(index));
const initialPage: GraphPage = {
  page: 0,
  pageSize: 500,
  totalCommits: null,
  hasMore: true,
  commits: page0Commits,
  wip: {
    worktreePath: "/repos/main",
    head: "head-sha",
    branch: "main",
    stagedFiles: ["staged.ts"],
    unstagedFiles: ["edited.ts"],
    untrackedFiles: ["new.ts"],
    conflictedFiles: ["conflict.ts"],
  },
  userEmail: "me@example.com",
};

function makeCommit(index: number, overrides: Partial<GraphCommit> = {}): GraphCommit {
  return {
    sha: `${String(index).padStart(40, "0")}`,
    shortSha: String(index).padStart(7, "0"),
    parents: index === 499 ? ["parent-sha"] : [],
    lane: 0,
    nodes: [{ lane: 0 }],
    edges: [],
    parentLanes: [],
    refs: index === 0 ? [{ name: "main", kind: "localBranch" }] : [],
    worktreeHeads: index === 2 ? [{ path: "/repos/main", branch: "main" }] : [],
    authorName: index % 2 === 0 ? "Me" : "Other",
    authorEmail: index % 2 === 0 ? "me@example.com" : "other@example.com",
    message: index === 0 ? "Initial commit" : `Commit ${index}`,
    timestamp: Math.floor(Date.now() / 1000) - index * 60,
    timezoneOffsetMinutes: -300,
    ...overrides,
  };
}

function setupGraph(pageReader: typeof readGraphPage = async () => initialPage) {
  const loadWorktrees = vi.fn().mockResolvedValue(undefined);
  const selectWorktree = vi.fn();
  useRepos.setState({
    activeProjectId: "project-1",
    projects: [{ id: "project-1", owner: null, name: "repo", localPath: "/repos/main", groupId: null }],
  });
  useWorktrees.setState({
    projectId: "project-1",
    activePath: "/repos/main",
    load: loadWorktrees,
    select: selectWorktree,
  });
  useGraphUi.setState({ filter: "all", selection: { kind: "wip" }, selectedCommit: null });
  vi.mocked(readGraphPage).mockImplementation(pageReader);
  vi.mocked(readGraphCommitDetail).mockResolvedValue({
    sha: page0Commits[0].sha,
    changedPaths: ["src/main.ts"],
  });
  return render(<><GraphToolbar /><GraphView /></>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useStage.setState({ go: vi.fn() });
  vi.mocked(onGitChanged).mockResolvedValue(vi.fn());
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("filters by worktree head and configured Git email, and reports a missing email as no matches", () => {
  const commits = [
    makeCommit(1, { worktreeHeads: [{ path: "/repos/feature", branch: "feature" }] }),
    makeCommit(2, { authorEmail: "ME@example.com", worktreeHeads: [] }),
    makeCommit(3, { authorEmail: "else@example.com", worktreeHeads: [] }),
  ];

  expect(filterGraphCommits(commits, "worktrees", "me@example.com")).toEqual([commits[0]]);
  expect(filterGraphCommits(commits, "mine", " ME@example.com ")).toEqual([commits[1]]);
  expect(filterGraphCommits(commits, "mine", null)).toEqual([]);
});

it("keeps lane continuations connected through branch and merge rows", () => {
  const commits = [
    makeCommit(1, {
      sha: "merge",
      message: "Merge",
      parents: ["feature", "main"],
      edges: [
        { fromLane: 0, toLane: 0, parentIndex: 0 },
        { fromLane: 0, toLane: 1, parentIndex: 1 },
      ],
    }),
    makeCommit(2, {
      sha: "feature",
      message: "Feature",
      parents: ["base"],
      edges: [{ fromLane: 0, toLane: 0, parentIndex: 0 }],
    }),
    makeCommit(3, {
      sha: "main",
      message: "Main",
      lane: 1,
      parents: ["base"],
      edges: [{ fromLane: 1, toLane: 0, parentIndex: 0 }],
    }),
    makeCommit(4, { sha: "base", message: "Base" }),
  ];

  expect(graphLaneRows(commits).get("merge")).toEqual({ incoming: false, continuingLanes: [] });
  expect(graphLaneRows(commits).get("feature")).toEqual({ incoming: true, continuingLanes: [1] });
  expect(graphLaneRows(commits).get("main")).toEqual({ incoming: true, continuingLanes: [0] });
  expect(graphLaneRows(commits).get("base")).toEqual({ incoming: true, continuingLanes: [] });
});

it("renders incoming and continuing lane segments between commits", async () => {
  const commits = [
    makeCommit(1, {
      sha: "merge",
      message: "Merge",
      parents: ["feature", "main"],
      edges: [
        { fromLane: 0, toLane: 0, parentIndex: 0 },
        { fromLane: 0, toLane: 1, parentIndex: 1 },
      ],
    }),
    makeCommit(2, {
      sha: "feature",
      message: "Feature",
      parents: ["base"],
      edges: [{ fromLane: 0, toLane: 0, parentIndex: 0 }],
    }),
    makeCommit(3, {
      sha: "main",
      message: "Main",
      lane: 1,
      parents: ["base"],
      edges: [{ fromLane: 1, toLane: 0, parentIndex: 0 }],
    }),
    makeCommit(4, { sha: "base", message: "Base" }),
  ];
  setupGraph(async () => ({ ...initialPage, commits, totalCommits: commits.length, hasMore: false }));

  const featureRow = await screen.findByRole("option", { name: /Feature/ });
  const segments = featureRow.querySelectorAll(".graph-continuation");
  expect(segments).toHaveLength(2);
  expect(segments[0].getAttribute("y2")).toBe("19");
  expect(segments[1].getAttribute("y2")).toBe("38");
});

it("renders a fixed-row virtual window and requests the next 500-row page near the end", async () => {
  setupGraph(async (_projectId, _worktreePath, page) =>
    page === 0
      ? initialPage
      : { ...initialPage, page: 1, totalCommits: 501, commits: [makeCommit(500)], hasMore: false },
  );
  const list = await screen.findByRole("listbox", { name: "Commit history" });
  await screen.findByRole("option", { name: /Initial commit/ });

  expect(within(list).getAllByRole("option").length).toBeLessThan(80);
  expect(within(list).getByRole("option", { name: "Working copy, main, 4 changed files, head-sh" })).toBeVisible();

  Object.defineProperty(list, "clientHeight", { configurable: true, value: 500 });
  list.scrollTop = 500 * 38 + 38 - 500 - 30 * 38;
  fireEvent.scroll(list);
  await waitFor(() => expect(readGraphPage).toHaveBeenCalledWith("project-1", "/repos/main", 1));
  list.scrollTop = 502 * 38 - 500;
  fireEvent.scroll(list);
  await screen.findByRole("option", { name: /Commit 500/ });
});

it("retries a failed next page without restarting the loaded graph", async () => {
  let pageOneAttempts = 0;
  setupGraph(async (_projectId, _worktreePath, page) => {
    if (page === 0) return initialPage;
    pageOneAttempts++;
    if (pageOneAttempts === 1) throw new Error("temporary Git read failure");
    return { ...initialPage, page: 1, totalCommits: 501, commits: [makeCommit(500)], hasMore: false };
  });
  const list = await screen.findByRole("listbox", { name: "Commit history" });
  Object.defineProperty(list, "clientHeight", { configurable: true, value: 500 });
  list.scrollTop = 500 * 38 + 38 - 500 - 30 * 38;
  fireEvent.scroll(list);
  await screen.findByText(/Couldn't load the next page/);
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(readGraphPage).toHaveBeenCalledTimes(3));
  list.scrollTop = 502 * 38 - 500;
  fireEvent.scroll(list);
  await screen.findByRole("option", { name: /Commit 500/ });
});

it("shows all worktree file groups, opens Changes, and inspects commit details", async () => {
  setupGraph();
  await screen.findByRole("option", { name: /Initial commit/ });
  expect(screen.getByText("staged.ts")).toBeVisible();
  expect(screen.getByText("edited.ts")).toBeVisible();
  expect(screen.getByText("new.ts")).toBeVisible();
  expect(screen.getByText("conflict.ts")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "± Open in Changes" }));
  expect(useStage.getState().go).toHaveBeenCalledWith("changes");

  await userEvent.click(screen.getByRole("option", { name: /Initial commit/ }));
  expect(await screen.findByText("src/main.ts")).toBeVisible();
  const shaChip = screen.getByRole("button", { name: page0Commits[0].shortSha });
  expect(shaChip).toHaveAttribute("title", page0Commits[0].sha);
  expect(screen.getByText("Initial commit", { selector: ".graph-commit-heading" })).toBeVisible();
  expect(screen.getByText("Me", { selector: ".graph-commit-author b" })).toBeVisible();
  expect(screen.getByText("main", { selector: ".graph-commit-meta .graph-ref" })).toBeVisible();
});

it("filters rows and visibly disables deferred graph actions", async () => {
  setupGraph();
  await screen.findByRole("option", { name: /Initial commit/ });

  await userEvent.click(screen.getByRole("button", { name: "⌂ Worktrees" }));
  expect(screen.getByRole("option", { name: /Working copy/ })).not.toHaveClass("dim");
  expect(screen.getByRole("option", { name: /Initial commit/ })).toHaveClass("dim");
  expect(screen.getByRole("option", { name: /Commit 2,/ })).not.toHaveClass("dim");

  await userEvent.click(screen.getByRole("button", { name: "Mine" }));
  expect(screen.getByRole("option", { name: /Initial commit/ })).not.toHaveClass("dim");
  expect(screen.getByRole("option", { name: /Commit 1,/ })).toHaveClass("dim");

  await userEvent.click(screen.getByRole("button", { name: "All branches" }));
  expect(screen.getByRole("option", { name: /Initial commit/ })).not.toHaveClass("dim");
  expect(screen.getByRole("button", { name: /Fetch · Later/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /Pull · Later/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /Push · Later/ })).toBeDisabled();
  const commit = screen.getByRole("option", { name: /Initial commit/ });
  expect(screen.getByRole("button", { name: "＋ Worktree" })).toBeDisabled();
  await userEvent.click(commit);
  expect(screen.getByRole("button", { name: "＋ Worktree" })).toBeEnabled();
  fireEvent.contextMenu(commit, { clientX: 120, clientY: 120 });
  expect(screen.getByRole("menuitem", { name: "Copy SHA" })).toBeEnabled();
  expect(screen.getByRole("menuitem", { name: "Create worktree here" })).toBeEnabled();
  expect(screen.getByRole("menuitem", { name: /Checkout · Later/ })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: /Start agent here · Later/ })).toBeDisabled();
});

it("does not show stale changed paths when a detail retry resolves after selection changes", async () => {
  let resolveRetry: (value: { sha: string; changedPaths: string[] }) => void = () => {};
  setupGraph();
  vi.mocked(readGraphCommitDetail)
    .mockRejectedValueOnce(new Error("detail read failed"))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }))
    .mockResolvedValueOnce({ sha: page0Commits[2].sha, changedPaths: ["src/second.ts"] });
  const firstCommit = await screen.findByRole("option", { name: /Initial commit/ });
  await userEvent.click(firstCommit);
  expect(await screen.findByText(/detail read failed/)).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await userEvent.click(screen.getByRole("option", { name: /^Commit 2,/ }));
  expect(await screen.findByText("src/second.ts")).toBeVisible();
  resolveRetry({ sha: page0Commits[0].sha, changedPaths: ["src/stale.ts"] });

  await waitFor(() => expect(screen.queryByText("src/stale.ts")).not.toBeInTheDocument());
  expect(screen.getByText("src/second.ts")).toBeVisible();
});

it("creates a worktree from the selected commit and refreshes/selects it", async () => {
  vi.mocked(ask).mockResolvedValue("commit/0000000");
  vi.mocked(createWorktreeAtCommit).mockResolvedValue({
    path: "/repos/commit-0000000",
    branch: "commit/0000000",
    head: page0Commits[0].sha,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    state: "clean",
  });
  setupGraph();
  const row = await screen.findByRole("option", { name: /Initial commit/ });
  fireEvent.contextMenu(row, { clientX: 120, clientY: 120 });
  await userEvent.click(screen.getByRole("menuitem", { name: "Create worktree here" }));

  await waitFor(() => expect(createWorktreeAtCommit).toHaveBeenCalledWith(
    "project-1",
    "/repos/commit-0000000",
    "commit/0000000",
    page0Commits[0].sha,
  ));
  expect(useWorktrees.getState().load).toHaveBeenCalledWith(useRepos.getState().projects[0]);
  expect(useWorktrees.getState().select).toHaveBeenCalledWith("/repos/commit-0000000");
});

it("reloads page 0 on a matching git:changed event and keeps the selection", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  const handlers: Array<(event: { worktree: string }) => void> = [];
  vi.mocked(onGitChanged).mockImplementation(async (callback) => {
    handlers.push(callback);
    return () => {};
  });
  let reads = 0;
  setupGraph(async () => {
    reads++;
    if (reads === 1) return initialPage;
    return { ...initialPage, commits: [page0Commits[0], makeCommit(600, { message: "New commit" })] };
  });
  const firstCommit = await screen.findByRole("option", { name: /Initial commit/ });
  await userEvent.click(firstCommit);
  expect(screen.getByRole("option", { name: /Initial commit/ })).toHaveAttribute("aria-selected", "true");
  await waitFor(() => expect(handlers).toHaveLength(1));

  await act(async () => handlers[0]({ worktree: "/not/this/worktree" }));
  expect(readGraphPage).toHaveBeenCalledTimes(1);

  await act(async () => handlers[0]({ worktree: "/repos/main" }));
  await waitFor(() => expect(readGraphPage).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("option", { name: /New commit/ })).toBeVisible();
  expect(screen.getByRole("option", { name: /Initial commit/ })).toHaveAttribute("aria-selected", "true");
});

it("fades commits off the active worktree's branch and flips the highlight when the active worktree changes", async () => {
  const branchCommits = [
    makeCommit(1, { sha: "feat-tip", message: "Feature tip", parents: ["base"] }),
    makeCommit(2, { sha: "main-tip", message: "Main tip", parents: ["base"] }),
    makeCommit(3, { sha: "base", message: "Base commit", parents: [] }),
  ];
  setupGraph(async (_projectId, worktreePath) => ({
    ...initialPage,
    commits: branchCommits,
    totalCommits: branchCommits.length,
    hasMore: false,
    wip: {
      ...initialPage.wip,
      worktreePath,
      head: worktreePath === "/repos/feature" ? "feat-tip" : "main-tip",
      branch: worktreePath === "/repos/feature" ? "feature" : "main",
    },
  }));

  await screen.findByRole("option", { name: /Main tip/ });
  expect(screen.getByRole("option", { name: /Main tip/ })).not.toHaveClass("off-branch");
  expect(screen.getByRole("option", { name: /Base commit/ })).not.toHaveClass("off-branch");
  expect(screen.getByRole("option", { name: /Feature tip/ })).toHaveClass("off-branch");

  act(() => useWorktrees.setState({ activePath: "/repos/feature" }));
  await waitFor(() => expect(screen.getByRole("option", { name: /Feature tip/ })).not.toHaveClass("off-branch"));
  expect(screen.getByRole("option", { name: /Main tip/ })).toHaveClass("off-branch");
  expect(screen.getByRole("option", { name: /Base commit/ })).not.toHaveClass("off-branch");
});

it("shows Mine's configured-email guidance and leaves Agent unavailable", async () => {
  setupGraph(async () => ({ ...initialPage, userEmail: null }));
  await screen.findByRole("option", { name: /Initial commit/ });
  await userEvent.click(screen.getByRole("button", { name: "Mine" }));

  expect(screen.getByText("Mine needs a Git user.email configured for this repository. No email is configured.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Agent commits are unavailable until agent metadata is available" })).toBeDisabled();
});
