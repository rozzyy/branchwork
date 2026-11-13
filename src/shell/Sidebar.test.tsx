import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useConflicts } from "../screens/conflicts/conflictsState";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import { useStage } from "../state/stage";
import { initialStage } from "../stage/stageModel";
import { useRepos } from "../state/repos";
import { useWorktrees } from "../state/worktrees";
import { listPins, pinWorktree, unpinWorktree } from "../ipc/catalog";
import { listWorktrees, onGitChanged, type GitChanged, type Worktree } from "../ipc/worktrees";
import { useToasts } from "../ui/toast";
import { useSessions } from "../agents/sessions";

vi.mock("../ipc/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/catalog")>();
  return { ...actual, listPins: vi.fn(), pinWorktree: vi.fn(), unpinWorktree: vi.fn() };
});

vi.mock("../ipc/worktrees", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/worktrees")>();
  return { ...actual, listWorktrees: vi.fn(), onGitChanged: vi.fn() };
});

const project = { id: "p1", owner: null, name: "repo", localPath: "/repos/main", groupId: null };
const secondProject = { id: "p2", owner: null, name: "other", localPath: "/other/main", groupId: null };
const worktrees: Worktree[] = [
  { path: "/repos/main", branch: "main", head: "a1", ahead: 0, behind: 0, dirtyCount: 0, state: "clean" },
  { path: "/repos/alpha", branch: "feature/alpha", head: "a2", ahead: 1, behind: 0, dirtyCount: 0, state: "clean" },
  { path: "/repos/beta", branch: "feature/beta", head: "a3", ahead: 0, behind: 0, dirtyCount: 2, state: "dirty" },
  { path: "/repos/gamma", branch: "feature/gamma", head: "a4", ahead: 0, behind: 0, dirtyCount: 0, state: "conflict" },
];

beforeEach(() => useStage.setState({ ...initialStage }));

beforeEach(() => {
  useToasts.setState({ toasts: [] });
  vi.mocked(listWorktrees).mockResolvedValue(worktrees);
  vi.mocked(onGitChanged).mockResolvedValue(vi.fn());
  vi.mocked(listPins).mockResolvedValue([
    { projectId: "p1", worktreePath: "/repos/main" },
    { projectId: "p1", worktreePath: "/repos/alpha" },
  ]);
  vi.mocked(pinWorktree).mockResolvedValue(undefined);
  vi.mocked(unpinWorktree).mockResolvedValue(true);
  useRepos.setState({ projects: [project], activeProjectId: project.id, status: "ready" });
  useWorktrees.setState({
    projectId: null,
    worktrees: [],
    pinnedPaths: [],
    activePath: null,
    selections: {},
    loading: false,
    error: null,
  });
  localStorage.removeItem("bw:activeWorktrees");
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("⌘-click opens a right split, ⌥-click a bottom split", async () => {
  render(<Sidebar />);
  fireEvent.click(screen.getByRole("button", { name: /Changes/ }), { metaKey: true });
  expect(useStage.getState().panes).toEqual(["launchpad", "changes"]);
  useStage.setState({ ...initialStage });
  fireEvent.click(screen.getByRole("button", { name: /Graph/ }), { altKey: true });
  expect(useStage.getState()).toMatchObject({ panes: ["launchpad", "graph"], dir: "v" });
});

it("context menu offers split directions", async () => {
  render(<Sidebar />);
  fireEvent.contextMenu(screen.getByRole("button", { name: /Agents/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Split left/ }));
  expect(useStage.getState().panes).toEqual(["agents", "launchpad"]);
});

it("badges the Conflicts nav with the conflicted-file count", async () => {
  useConflicts.setState({
    worktree: useWorktrees.getState().activePath,
    list: {
      operation: "merge",
      truncated: false,
      files: [{ path: "a.ts", kind: "bothModified" }, { path: "b.ts", kind: "bothAdded" }],
    },
  });
  render(<Sidebar />);

  expect(await screen.findByRole("status", { name: "2 conflicted files" })).toHaveTextContent("2");
});

it("badges the Agents nav while a session waits", () => {
  useSessions.setState({
    sessions: [
      {
        id: "a1",
        cliId: "codex",
        profile: { cliId: "codex", slug: "work" },
        worktreePath: "/wt/a",
        sessionId: "pty-1",
        slot: "auto",
        error: null,
        sharedWithDock: false,
        status: "waiting",
        limitHit: false,
      },
    ],
  });
  render(<Sidebar />);
  expect(screen.getByRole("status", { name: "1 agents waiting for input" })).toHaveTextContent("1");
  useSessions.setState({ sessions: [] });
});

it("shows position glyphs for both split screens", () => {
  useStage.setState({ ...initialStage, panes: ["agents", "changes"] });
  render(<Sidebar />);
  expect(screen.getByRole("button", { name: /Agents/ })).toHaveTextContent("◧");
  expect(screen.getByRole("button", { name: /Changes/ })).toHaveTextContent("◨");
});

it("shows the active worktree and pins once, with an overflow count for the rest", async () => {
  render(<Sidebar />);

  expect(await screen.findByRole("button", { name: "main, Clean" })).toHaveAttribute("aria-current", "true");
  expect(screen.getByRole("button", { name: "feature/alpha, Clean" })).toBeVisible();
  expect(screen.getAllByRole("button", { name: "main, Clean" })).toHaveLength(1);
  expect(screen.getByLabelText("Worktrees: 2 of 4")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "… 2 more worktrees" })).toBeVisible();
  expect(onGitChanged).not.toHaveBeenCalled();
});

it("filters the checkbox picker and pins or unpins through typed operations", async () => {
  const user = userEvent.setup();
  render(<Sidebar />);
  await screen.findByRole("button", { name: "main, Clean" });
  await user.click(screen.getByRole("button", { name: "Browse worktrees" }));

  const search = screen.getByRole("textbox", { name: "Search worktrees" });
  await user.type(search, "beta");
  const picker = within(screen.getByRole("dialog", { name: "Browse worktrees" }));
  expect(picker.getByRole("button", { name: "Select worktree feature/beta" })).toBeVisible();
  expect(picker.queryByRole("button", { name: "Select worktree feature/alpha" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("checkbox", { name: "Pin feature/beta" }));
  await waitFor(() => expect(pinWorktree).toHaveBeenCalledWith({ projectId: "p1", worktreePath: "/repos/beta" }));
  await user.clear(search);
  await user.click(screen.getByRole("checkbox", { name: "Unpin feature/alpha" }));
  await waitFor(() => expect(unpinWorktree).toHaveBeenCalledWith("p1", "/repos/alpha"));
});

it("opens the picker from the overflow row and unpins a visible worktree", async () => {
  const user = userEvent.setup();
  render(<Sidebar />);
  await screen.findByRole("button", { name: "feature/alpha, Clean" });
  await user.click(screen.getByRole("button", { name: "Unpin feature/alpha" }));

  await waitFor(() => expect(unpinWorktree).toHaveBeenCalledWith("p1", "/repos/alpha"));
  expect(screen.queryByRole("button", { name: "feature/alpha, Clean" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "… 3 more worktrees" }));
  expect(screen.getByRole("dialog", { name: "Browse worktrees" })).toBeVisible();
});

it("preserves row names and tooltips in collapsed mode", async () => {
  render(
    <div className="app" data-sidebar="collapsed">
      <Sidebar />
    </div>,
  );
  const main = await screen.findByRole("button", { name: "main, Clean" });
  expect(main).toHaveAttribute("title", expect.stringContaining("/repos/main"));
  expect(screen.getByRole("button", { name: "Browse worktrees" })).toHaveAttribute("title", "Browse worktrees");
});

it("selects a pinned worktree without replacing the active project", async () => {
  const user = userEvent.setup();
  render(<Sidebar />);
  await screen.findByRole("button", { name: "feature/alpha, Clean" });

  await user.click(screen.getByRole("button", { name: "feature/alpha, Clean" }));
  expect(screen.getByRole("button", { name: "feature/alpha, Clean" })).toHaveAttribute("aria-current", "true");
  expect(useRepos.getState().activeProjectId).toBe("p1");
});

it("refreshes only for a matching git change and ignores events from another project", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  const handlers: Array<(event: GitChanged) => void> = [];
  vi.mocked(onGitChanged).mockImplementation(async (callback) => {
    handlers.push(callback);
    return () => {};
  });
  render(<Sidebar />);
  await screen.findByRole("button", { name: "main, Clean" });
  await waitFor(() => expect(handlers).toHaveLength(1));

  const initialCalls = vi.mocked(listWorktrees).mock.calls.length;
  await act(async () => handlers[0]({ worktree: "/not/this/repository" }));
  expect(listWorktrees).toHaveBeenCalledTimes(initialCalls);

  const refreshed = worktrees.map((worktree) =>
    worktree.path === "/repos/beta" ? { ...worktree, dirtyCount: 7 } : worktree,
  );
  vi.mocked(listWorktrees).mockResolvedValue(refreshed);
  await act(async () => handlers[0]({ worktree: "/repos/beta" }));
  await waitFor(() => expect(useWorktrees.getState().worktrees.find((item) => item.path === "/repos/beta")?.dirtyCount).toBe(7));

  vi.mocked(listWorktrees).mockImplementation(async (projectId) =>
    projectId === secondProject.id
      ? [{ ...worktrees[0], path: secondProject.localPath }]
      : worktrees,
  );
  useRepos.setState({ projects: [project, secondProject], activeProjectId: secondProject.id });
  await waitFor(() => expect(listWorktrees).toHaveBeenLastCalledWith(secondProject.id));
  const afterSwitchCalls = vi.mocked(listWorktrees).mock.calls.length;
  await act(async () => handlers[0]({ worktree: "/repos/main" }));
  expect(listWorktrees).toHaveBeenCalledTimes(afterSwitchCalls);
});

it("unsubscribes on project change and unmount, including delayed listener registration", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  const unlisten = vi.fn(() => {});
  const resolvers: Array<(fn: () => void) => void> = [];
  vi.mocked(onGitChanged).mockImplementation(
    () => new Promise((resolve) => { resolvers.push(resolve); }),
  );
  const rendered = render(<Sidebar />);
  await screen.findByRole("button", { name: "main, Clean" });
  await waitFor(() => expect(resolvers).toHaveLength(1));

  useRepos.setState({ projects: [project, secondProject], activeProjectId: secondProject.id });
  await waitFor(() => expect(resolvers).toHaveLength(2));
  resolvers[0](unlisten);
  await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));

  const secondUnlisten = vi.fn(() => {});
  resolvers[1](secondUnlisten);
  rendered.unmount();
  await waitFor(() => expect(secondUnlisten).toHaveBeenCalledTimes(1));
});

it("surfaces worktree change listener failures", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  vi.mocked(onGitChanged).mockRejectedValue(new Error("listener failed"));
  render(<Sidebar />);

  await waitFor(() =>
    expect(useToasts.getState().toasts.map((item) => item.title)).toContain(
      "Couldn't watch worktree changes: listener failed",
    ),
  );
});
