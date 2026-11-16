import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";
import { GroupSwitcherHost } from "./GroupSwitcher";
import { useRepos } from "../state/repos";
import { useStage, stageSnapshot } from "../state/stage";
import { initialStage } from "../stage/stageModel";
import { useWorktrees } from "../state/worktrees";
import type { Group, Project } from "../ipc/catalog";

vi.mock("../ipc/catalog", () => ({
  saveGroup: vi.fn(),
  deleteGroup: vi.fn(),
  saveProject: vi.fn(),
  deleteProject: vi.fn(),
  isRepository: vi.fn(),
  openRepository: vi.fn(),
  pickFolder: vi.fn(),
  cloneRepository: vi.fn(),
  classifyFolder: vi.fn(async () => ({ kind: "repository" })),
  initRepository: vi.fn(),
}));
vi.mock("../ui/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/dialog")>();
  return { ...actual, ask: vi.fn() };
});
vi.mock("../ipc/settings", () => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(() => Promise.resolve()),
}));
vi.mock("../ipc/worktrees", () => ({
  listWorktrees: vi.fn(async () => []),
  onGitChanged: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));

const groups: Group[] = [{ id: "g1", name: "Team", color: "oklch(.68 .13 250)", clonePathTemplate: "~/clients/{repo}" }];
const projects: Project[] = [
  { id: "p1", owner: "acme", name: "Alpha", localPath: "/a", groupId: "g1" },
  { id: "p2", owner: null, name: "Beta", localPath: "/b", groupId: null },
];

function seed() {
  useRepos.setState({
    groups,
    projects,
    activeGroupId: "g1",
    activeProjectId: "p1",
    openProjectIds: ["p1"],
    collapsedGroupIds: [],
    recentProjectIds: ["p1"],
    status: "ready",
    error: null,
  });
  useWorktrees.setState({
    projectId: "p1",
    worktrees: [],
    pinnedPaths: [],
    activePath: null,
    loading: false,
    error: null,
    selections: {},
    byProject: {},
  });
  useStage.setState(stageSnapshot(initialStage));
}

function popovers() {
  return screen.queryAllByRole("dialog", { name: "Search groups and projects" });
}

it("opens exactly one project popover from the titlebar while the sidebar shows groups inline", async () => {
  seed();
  render(
    <>
      <TitleBar />
      <Sidebar />
      <GroupSwitcherHost />
    </>,
  );

  // Sidebar shows every group/project inline; no sidebar picker trigger or modal.
  expect(screen.queryByRole("button", { name: /1 projects/ })).not.toBeInTheDocument();
  expect(screen.getAllByText("acme/Alpha")).toHaveLength(2); // titlebar crumb + inline row
  expect(screen.getAllByText("Beta")).toHaveLength(1);
  expect(popovers()).toHaveLength(0);

  // The titlebar crumb still opens the single shared popover.
  const crumb = within(screen.getByRole("navigation", { name: "Workspace location" })).getByRole("button", {
    name: "Team",
  });
  await userEvent.click(crumb);
  expect(popovers()).toHaveLength(1);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(popovers()).toHaveLength(0));
});
