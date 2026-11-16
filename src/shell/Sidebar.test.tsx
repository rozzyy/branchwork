import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import { useStage, stageSnapshot } from "../state/stage";
import { initialStage, layoutOf, leafIds } from "../stage/stageModel";
import { useRepos } from "../state/repos";
import { useWorktrees } from "../state/worktrees";
import { listPins, pinWorktree, unpinWorktree } from "../ipc/catalog";
import { listWorktrees, onGitChanged, type GitChanged, type Worktree } from "../ipc/worktrees";
import { createWorktree, removeWorktree } from "../ipc/worktrees";
import { useToasts } from "../ui/toast";
import { useSessions } from "../agents/sessions";
import { DialogHost } from "../ui/dialog";

vi.mock("../ipc/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/catalog")>();
  return { ...actual, listPins: vi.fn(), pinWorktree: vi.fn(), unpinWorktree: vi.fn() };
});

vi.mock("../ipc/worktrees", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/worktrees")>();
  return { ...actual, listWorktrees: vi.fn(), onGitChanged: vi.fn(), createWorktree: vi.fn(), removeWorktree: vi.fn() };
});

const project = { id: "p1", owner: null, name: "repo", localPath: "/repos/main", groupId: null };
const secondProject = { id: "p2", owner: null, name: "other", localPath: "/other/main", groupId: null };
const worktrees: Worktree[] = [
  { path: "/repos/main", branch: "main", head: "a1", ahead: 0, behind: 0, dirtyCount: 0, state: "clean" },
  { path: "/repos/alpha", branch: "feature/alpha", head: "a2", ahead: 1, behind: 0, dirtyCount: 0, state: "clean" },
  { path: "/repos/beta", branch: "feature/beta", head: "a3", ahead: 0, behind: 0, dirtyCount: 2, state: "dirty" },
  { path: "/repos/gamma", branch: "feature/gamma", head: "a4", ahead: 0, behind: 0, dirtyCount: 0, state: "conflict" },
];

beforeEach(() => useStage.setState(stageSnapshot(initialStage)));

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
  expect(useStage.getState().panes).toEqual(["home", "changes"]);
  useStage.setState(stageSnapshot(initialStage));
  fireEvent.click(screen.getByRole("button", { name: /History/ }), { altKey: true });
  expect(useStage.getState()).toMatchObject({ panes: ["home", "history"], dir: "v" });
});

it("context menu offers split directions", async () => {
  render(<Sidebar />);
  fireEvent.contextMenu(screen.getByRole("button", { name: /Agents/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Split left/ }));
  expect(useStage.getState().panes).toEqual(["agents", "home"]);
});

it("opens a sidebar screen in a separate stage tab from its context menu", async () => {
  render(<Sidebar />);
  useStage.getState().go("agents");
  useStage.getState().openSplit("changes", "right");
  const active = useStage.getState().activeTabId;
  fireEvent.contextMenu(screen.getByRole("button", { name: /History/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Open in new tab" }));
  expect(useStage.getState().panes).toEqual(["history"]);
  useStage.getState().activateTab(active);
  expect(useStage.getState().panes).toEqual(["agents", "changes"]);
});

it("shows the app logo above the worktree navigation and inline groups below For this worktree", () => {
  const { container } = render(<Sidebar />);
  const brand = container.querySelector(".side-brand");
  expect(brand).toHaveTextContent("Branchwork");
  expect(brand?.querySelector(".app-mark")).toBeInTheDocument();
  expect(container.querySelector(".project-picker-trigger")).not.toBeInTheDocument();
  const worktrees = container.querySelector(".worktree-section");
  const groups = container.querySelector(".group-inline");
  expect(worktrees).toBeInTheDocument();
  expect(groups).toBeInTheDocument();
  // Groups sit below the "For this worktree" navigation (below Browser).
  const navHeading = [...container.querySelectorAll(".side-h")].find((h) => h.textContent === "For this worktree");
  expect(navHeading).toBeTruthy();
  expect(navHeading?.compareDocumentPosition(groups as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  const browser = container.querySelector(".nav[aria-label='Browser']");
  expect(browser).toBeTruthy();
  expect(browser?.compareDocumentPosition(groups as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  // Groups heading keeps its icon buttons; group actions sit behind a
  // hamburger in each group title row (tested below).
  expect(screen.getByRole("button", { name: "New group" })).toHaveClass("group-inline-action");
  expect(screen.getByRole("button", { name: "Open project…" })).toHaveClass("group-inline-action");
  expect(screen.getByRole("button", { name: "Clone repository…" })).toHaveClass("group-inline-action");
  expect(container.querySelector(".group-inline-foot")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open repository…" })).not.toBeInTheDocument();
});

it("shows a hamburger dropdown on each group title with its group actions", async () => {
  const user = userEvent.setup();
  useRepos.setState({
    groups: [{ id: "g1", name: "Personal", color: "oklch(.68 .19 250)", clonePathTemplate: "~/clients/{repo}" }],
    projects: [{ id: "p1", owner: null, name: "api", localPath: "/repos/api", groupId: "g1" }],
    activeGroupId: "g1",
    activeProjectId: "p1",
    collapsedGroupIds: [],
    status: "ready",
    error: null,
  });
  render(<Sidebar />);

  const burger = screen.getByRole("button", { name: "Manage Personal" });
  // No direct Edit/Delete buttons on the row anymore.
  expect(screen.queryByRole("button", { name: "Add repository to Personal" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit group" })).not.toBeInTheDocument();

  await user.click(burger);
  expect(screen.getByRole("menuitem", { name: "Add repository to Personal" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Edit group" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Delete group" })).toBeInTheDocument();

  // Edit group opens the inline form for that group.
  await user.click(screen.getByRole("menuitem", { name: "Edit group" }));
  expect(screen.getByRole("textbox", { name: "Folder for new clones" })).toBeInTheDocument();
});

it("shows every group and project inline below worktrees without a modal", async () => {
  const user = userEvent.setup();
  useRepos.setState({
    groups: [{ id: "g1", name: "Acme", color: "oklch(.68 .19 250)", clonePathTemplate: "~/clients/{repo}" }],
    projects: [
      { id: "p1", owner: "acme", name: "api", localPath: "/repos/api", groupId: "g1" },
      { id: "p2", owner: null, name: "scratch", localPath: "/repos/scratch", groupId: null },
    ],
    activeGroupId: "g1",
    activeProjectId: "p1",
    collapsedGroupIds: [],
    status: "ready",
    error: null,
  });
  render(<Sidebar />);

  // Visible without any click, no dialog/popover involved.
  expect(screen.getByText("Acme")).toBeInTheDocument();
  expect(screen.getByText("Ungrouped")).toBeInTheDocument();
  expect(screen.getByText("acme/api")).toBeInTheDocument();
  expect(screen.getByText("scratch")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  // Selecting another project switches it directly from the inline list.
  await user.click(screen.getByText("scratch"));
  await waitFor(() => expect(useRepos.getState().activeProjectId).toBe("p2"));
});

it("creates a worktree from the worktree picker and selects it", async () => {
  const user = userEvent.setup();
  const all = [...worktrees];
  vi.mocked(listWorktrees).mockImplementation(async () => all);
  vi.mocked(createWorktree).mockImplementation(async (_id: string, destination: string, branch: string) => {
    const created = { path: destination, branch, head: "a5", ahead: 0, behind: 0, dirtyCount: 0, state: "clean" as const };
    all.push(created);
    return created;
  });
  render(
    <>
      <Sidebar />
      <DialogHost />
    </>,
  );
  await screen.findByRole("button", { name: "main, Clean" });
  await user.click(screen.getByRole("button", { name: "Browse worktrees" }));
  await user.click(screen.getByRole("button", { name: /New worktree/ }));

  const prompt = await screen.findByRole("dialog", { name: "Create a worktree" });
  await user.type(within(prompt).getByRole("textbox"), "feature/new{Enter}");

  await waitFor(() => expect(createWorktree).toHaveBeenCalledWith("p1", "/repos/feature-new", "feature/new"));
  await waitFor(() =>
    expect(useWorktrees.getState().activePath).toBe("/repos/feature-new"),
  );
  expect(screen.queryByRole("dialog", { name: "Browse worktrees" })).not.toBeInTheDocument();
});

it("removes a worktree from the picker after confirmation", async () => {
  const user = userEvent.setup();
  vi.mocked(removeWorktree).mockResolvedValue(undefined);
  render(
    <>
      <Sidebar />
      <DialogHost />
    </>,
  );
  await screen.findByRole("button", { name: "main, Clean" });
  await user.click(screen.getByRole("button", { name: "Browse worktrees" }));

  await user.click(screen.getByRole("button", { name: "Remove feature/beta" }));
  const confirm = await screen.findByRole("dialog", { name: /Remove/ });
  await user.click(within(confirm).getByRole("button", { name: "Remove" }));

  await waitFor(() => expect(removeWorktree).toHaveBeenCalledWith("p1", "/repos/beta"));
});

it("marks the active project with active UI in the inline list", () => {
  useRepos.setState({
    groups: [{ id: "g1", name: "Acme", color: "oklch(.68 .19 250)", clonePathTemplate: "~/clients/{repo}" }],
    projects: [
      { id: "p1", owner: "acme", name: "api", localPath: "/repos/api", groupId: "g1" },
      { id: "p2", owner: null, name: "scratch", localPath: "/repos/scratch", groupId: null },
    ],
    activeGroupId: "g1",
    activeProjectId: "p1",
    collapsedGroupIds: [],
    status: "ready",
    error: null,
  });
  render(<Sidebar />);

  const activeRow = screen.getByText("acme/api").closest("button");
  expect(activeRow).toHaveAttribute("aria-current", "true");
  expect(activeRow).toHaveClass("is-active");
  const inactiveRow = screen.getByText("scratch").closest("button");
  expect(inactiveRow).not.toHaveAttribute("aria-current");
  expect(inactiveRow).not.toHaveClass("is-active");
});

it("marks only the global project active in split view (pane pin removed)", () => {
  useRepos.setState({
    groups: [{ id: "g1", name: "Acme", color: "oklch(.68 .19 250)", clonePathTemplate: "~/clients/{repo}" }],
    projects: [
      { id: "p1", owner: "acme", name: "api", localPath: "/repos/api", groupId: "g1" },
      { id: "p2", owner: null, name: "scratch", localPath: "/repos/scratch", groupId: null },
    ],
    activeGroupId: "g1",
    activeProjectId: "p1",
    collapsedGroupIds: [],
    status: "ready",
    error: null,
  });
  useStage.setState(stageSnapshot(layoutOf(["home", "changes"])));
  expect(leafIds(useStage.getState())).toHaveLength(2);
  render(<Sidebar />);

  // Pane pins were removed: only the global project shows active UI, even split.
  expect(screen.getByText("acme/api").closest("button")).toHaveAttribute("aria-current", "true");
  expect(screen.getByText("scratch").closest("button")).not.toHaveAttribute("aria-current");
  expect(screen.getByText("scratch").closest("button")).not.toHaveClass("is-active");
});

it("keeps Conflicts out of the screen navigation", async () => {
  render(<Sidebar />);
  expect(screen.queryByRole("button", { name: "Conflicts" })).not.toBeInTheDocument();
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
        conversationId: null,
        savers: { rtk: "unsupported", caveman: "unsupported" },
      },
    ],
  });
  render(<Sidebar />);
  expect(screen.getByRole("status", { name: "1 agents waiting for input" })).toHaveTextContent("1");
  useSessions.setState({ sessions: [] });
});

it("shows position glyphs for both split screens", () => {
  useStage.setState(stageSnapshot(layoutOf(["agents", "changes"])));
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
