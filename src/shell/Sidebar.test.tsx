import { act, render, screen, waitFor, within } from "@testing-library/react";
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
  useRepos.setState({ projects: [project], activeProjectId: project.id, openProjectIds: [project.id], status: "ready" });
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

it("nests the active project's worktrees beneath its grouped project row", () => {
  const { container } = render(<Sidebar />);
  const brand = container.querySelector(".side-brand");
  expect(brand).toHaveTextContent("Branchwork");
  expect(brand?.querySelector(".app-mark")).toBeInTheDocument();
  expect(container.querySelector(".project-picker-trigger")).not.toBeInTheDocument();
  const worktrees = container.querySelector(".worktree-section");
  const groups = container.querySelector(".group-inline");
  expect(worktrees).toBeInTheDocument();
  expect(groups).toBeInTheDocument();
  const projectEntry = container.querySelector(".group-project-entry");
  expect(projectEntry?.querySelector(".worktree-section")).toBe(worktrees);
  expect(container.querySelector(".side-scroll > .worktree-section")).not.toBeInTheDocument();
  expect(container.querySelector(".nav")).not.toBeInTheDocument();
  expect(screen.queryByText("For this worktree")).not.toBeInTheDocument();
  expect(screen.queryByText("Worktrees", { exact: true })).not.toBeInTheDocument();
  // Groups heading keeps its icon buttons; group actions sit behind a
  // hamburger in each group title row (tested below).
  expect(screen.getByRole("button", { name: "New group" })).toHaveClass("group-inline-action");
  expect(screen.getByRole("button", { name: "Open project…" })).toHaveClass("group-inline-action");
  expect(screen.getByRole("button", { name: "Clone repository…" })).toHaveClass("group-inline-action");
  expect(container.querySelector(".group-inline-foot")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open repository…" })).not.toBeInTheDocument();
});

it("keeps Settings at the bottom of the sidebar", () => {
  render(<Sidebar />);
  expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
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

it("shows grouped projects inline and nests worktrees under the active project", async () => {
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

  // Expanding another project opens it without replacing the active project.
  await user.click(screen.getByRole("button", { name: "Expand worktrees for scratch" }));
  await waitFor(() => expect(useRepos.getState().openProjectIds).toContain("p2"));
  expect(useRepos.getState().activeProjectId).toBe("p1");
  const activeProjectEntry = screen.getByText("scratch").closest(".group-project-entry");
  expect(activeProjectEntry?.querySelector(".worktree-section")).toBeInTheDocument();
});

it("collapses the active project's worktrees without unmounting their controls", async () => {
  const user = userEvent.setup();
  const { container } = render(<Sidebar />);
  await screen.findByRole("button", { name: "main, Clean" });

  await user.click(screen.getByRole("button", { name: "Collapse worktrees for repo" }));
  const projectEntry = container.querySelector(".group-project-entry");
  const worktrees = projectEntry?.querySelector(".worktree-section");
  expect(worktrees).toBeInTheDocument();
  expect(worktrees?.parentElement).toHaveAttribute("hidden");
  expect(screen.getByRole("button", { name: "Expand worktrees for repo" })).toHaveAttribute("aria-expanded", "false");

  await user.click(screen.getByRole("button", { name: "Expand worktrees for repo" }));
  expect(worktrees?.parentElement).not.toHaveAttribute("hidden");
});

it("switches the active project only after a worktree is clicked", async () => {
  const user = userEvent.setup();
  useRepos.setState({
    groups: [],
    projects: [project, secondProject],
    activeGroupId: null,
    activeProjectId: "p1",
    openProjectIds: ["p1", "p2"],
    collapsedGroupIds: [],
    recentProjectIds: ["p1"],
    status: "ready",
    error: null,
  });
  render(<Sidebar />);

  const scratchEntry = await screen.findByText("other");
  expect(useRepos.getState().activeProjectId).toBe("p1");
  const entry = scratchEntry.closest(".group-project-entry");
  await waitFor(() => expect(entry?.querySelector(".worktree-section")).toBeInTheDocument());
  await user.click(within(entry as HTMLElement).getByRole("button", { name: "main, Clean" }));
  await waitFor(() => expect(useRepos.getState().activeProjectId).toBe("p2"));
});

it("shows the hamburger below worktrees only when no overflow row exists", async () => {
  vi.mocked(listWorktrees).mockResolvedValue([worktrees[0]]);
  vi.mocked(listPins).mockResolvedValue([
    { projectId: "p1", worktreePath: "/repos/main" },
  ]);
  render(<Sidebar />);

  await screen.findByRole("button", { name: "main, Clean" });
  expect(screen.queryByText("1/1")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /more worktrees/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Browse worktrees" })).toBeVisible();
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
  await user.click(screen.getByRole("button", { name: "… 2 more worktrees" }));
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
  await user.click(screen.getByRole("button", { name: "… 2 more worktrees" }));

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

it("keeps screen navigation out of the sidebar", () => {
  render(<Sidebar />);
  expect(screen.queryByRole("button", { name: "Resolve conflicts" })).not.toBeInTheDocument();
});

it("shows the active worktree and pins once, with an overflow count for the rest", async () => {
  render(<Sidebar />);

  expect(await screen.findByRole("button", { name: "main, Clean" })).toHaveAttribute("aria-current", "true");
  expect(screen.getByRole("button", { name: "feature/alpha, Clean" })).toBeVisible();
  expect(screen.getAllByRole("button", { name: "main, Clean" })).toHaveLength(1);
  expect(screen.queryByText("2/4")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Browse worktrees" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "… 2 more worktrees" })).toBeVisible();
  expect(onGitChanged).not.toHaveBeenCalled();
});

it("filters the checkbox picker and pins or unpins through typed operations", async () => {
  const user = userEvent.setup();
  render(<Sidebar />);
  await screen.findByRole("button", { name: "main, Clean" });
  await user.click(screen.getByRole("button", { name: "… 2 more worktrees" }));

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
  expect(screen.getByRole("button", { name: "… 2 more worktrees" })).toHaveAttribute("title", "… 2 more worktrees");
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
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: vi.fn().mockResolvedValue(null) } });
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
  useRepos.setState({ projects: [project, secondProject], activeProjectId: secondProject.id, openProjectIds: [secondProject.id] });
  await waitFor(() => expect(listWorktrees).toHaveBeenLastCalledWith(secondProject.id));
  const afterSwitchCalls = vi.mocked(listWorktrees).mock.calls.length;
  await act(async () => handlers[0]({ worktree: "/repos/main" }));
  expect(listWorktrees).toHaveBeenCalledTimes(afterSwitchCalls);
});

it("unsubscribes on project change and unmount, including delayed listener registration", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: vi.fn().mockResolvedValue(null) } });
  const unlisten = vi.fn(() => {});
  const resolvers: Array<(fn: () => void) => void> = [];
  vi.mocked(onGitChanged).mockImplementation(
    () => new Promise((resolve) => { resolvers.push(resolve); }),
  );
  const rendered = render(<Sidebar />);
  await screen.findByRole("button", { name: "main, Clean" });
  await waitFor(() => expect(resolvers).toHaveLength(1));

  useRepos.setState({ projects: [project, secondProject], activeProjectId: secondProject.id, openProjectIds: [secondProject.id] });
  await waitFor(() => expect(resolvers).toHaveLength(2));
  resolvers[0](unlisten);
  await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));

  const secondUnlisten = vi.fn(() => {});
  resolvers[1](secondUnlisten);
  rendered.unmount();
  await waitFor(() => expect(secondUnlisten).toHaveBeenCalledTimes(1));
});

it("surfaces worktree change listener failures", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: vi.fn().mockResolvedValue(null) } });
  vi.mocked(onGitChanged).mockRejectedValue(new Error("listener failed"));
  render(<Sidebar />);

  await waitFor(() =>
    expect(useToasts.getState().toasts.map((item) => item.title)).toContain(
      "Couldn't watch worktree changes: listener failed",
    ),
  );
});
