import { projectsForGroup, useRepos } from "./repos";
import {
  cloneRepository,
  deleteGroup as deleteGroupIpc,
  deleteProject as deleteProjectIpc,
  listGroups,
  listProjects,
  openRepository,
  classifyFolder,
  initRepository,
  saveGroup as saveGroupIpc,
  saveProject as saveProjectIpc,
  type Group,
  type Project,
} from "../ipc/catalog";
import { loadSetting, saveSetting } from "../ipc/settings";
import { useStage } from "./stage";
import { useFiles } from "./files";
import { initialStage } from "../stage/stageModel";
import { useToasts } from "../ui/toast";
import { ask } from "../ui/dialog";

vi.mock("../ipc/catalog", () => ({
  listGroups: vi.fn(),
  listProjects: vi.fn(),
  saveGroup: vi.fn(),
  deleteGroup: vi.fn(),
  saveProject: vi.fn(),
  deleteProject: vi.fn(),
  openRepository: vi.fn(),
  cloneRepository: vi.fn(),
  classifyFolder: vi.fn(),
  initRepository: vi.fn(),
}));
vi.mock("../ui/dialog", () => ({ ask: vi.fn() }));
vi.mock("../ipc/settings", () => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(),
}));

const groups: Group[] = [{ id: "g1", name: "Acme", color: "#fff", clonePathTemplate: "" }];
const projects: Project[] = [
  { id: "p1", owner: null, name: "Zeta", localPath: "/z", groupId: "g1" },
  { id: "p2", owner: null, name: "Alpha", localPath: "/a", groupId: "g1" },
  { id: "p3", owner: null, name: "Beta", localPath: "/b", groupId: null },
];

beforeEach(() => {
  vi.mocked(listGroups).mockResolvedValue(groups);
  vi.mocked(listProjects).mockResolvedValue(projects);
  vi.mocked(loadSetting).mockResolvedValue(null);
  vi.mocked(saveSetting).mockResolvedValue(undefined);
  vi.mocked(saveGroupIpc).mockResolvedValue(undefined);
  vi.mocked(deleteGroupIpc).mockResolvedValue(true);
  vi.mocked(saveProjectIpc).mockResolvedValue(undefined);
  vi.mocked(deleteProjectIpc).mockResolvedValue(true);
  vi.mocked(openRepository).mockReset();
  vi.mocked(initRepository).mockReset();
  vi.mocked(ask).mockReset();
  vi.mocked(classifyFolder).mockResolvedValue({ kind: "repository" });
  vi.mocked(cloneRepository).mockReset();
  useRepos.setState({ groups: [], projects: [], activeGroupId: null, activeProjectId: null, openProjectIds: [], collapsedGroupIds: [], status: "idle", error: null });
  useStage.setState({ ...initialStage });
  useToasts.setState({ toasts: [] });
});

it("restores a persisted selection", async () => {
  vi.mocked(loadSetting).mockResolvedValue({ activeGroupId: "g1", activeProjectId: "p1" });
  await useRepos.getState().load();
  expect(useRepos.getState()).toMatchObject({ activeGroupId: "g1", activeProjectId: "p1", status: "ready" });
});

it("falls back to the restored group's first project when the persisted project is gone", async () => {
  vi.mocked(loadSetting).mockResolvedValue({ activeGroupId: "g1", activeProjectId: "missing" });
  await useRepos.getState().load();
  // Alpha sorts before Zeta within g1.
  expect(useRepos.getState()).toMatchObject({ activeGroupId: "g1", activeProjectId: "p2" });
});

it("selectProject sets the active project and group, and persists", () => {
  useRepos.setState({ groups, projects, status: "ready" });
  useRepos.getState().selectProject("p3");
  expect(useRepos.getState()).toMatchObject({ activeProjectId: "p3", activeGroupId: null });
  expect(saveSetting).toHaveBeenCalledWith("repos", { activeGroupId: null, activeProjectId: "p3", openProjectIds: ["p3"], collapsedGroupIds: [] });
});

it("selecting an orphaned project activates Ungrouped and keeps its tab visible", () => {
  const orphan: Project = { id: "p4", owner: null, name: "Orphan", localPath: "/o", groupId: "ghost" };
  useRepos.setState({ groups, projects: [...projects, orphan], status: "ready", openProjectIds: [] });
  useRepos.getState().selectProject("p4");
  const state = useRepos.getState();
  expect(state).toMatchObject({ activeGroupId: null, activeProjectId: "p4" });
  expect(projectsForGroup(state.projects, state.activeGroupId, state.groups).map((p) => p.id)).toContain("p4");
});

it("selectProject ignores unknown ids", () => {
  useRepos.setState({ groups, projects, status: "ready", activeProjectId: "p1", activeGroupId: "g1" });
  useRepos.getState().selectProject("nope");
  expect(useRepos.getState()).toMatchObject({ activeProjectId: "p1", activeGroupId: "g1" });
});

it("selectGroup selects the group's first project, and persists", () => {
  useRepos.setState({ groups, projects, status: "ready" });
  useRepos.getState().selectGroup("g1");
  expect(useRepos.getState()).toMatchObject({ activeGroupId: "g1", activeProjectId: "p2" });
  expect(saveSetting).toHaveBeenCalledWith("repos", { activeGroupId: "g1", activeProjectId: "p2", openProjectIds: ["p2"], collapsedGroupIds: [] });
});

it("load() in flight: a selectProject bump still lets the freshly loaded groups/projects through, keeping the newer selection", async () => {
  useRepos.setState({ groups, projects, status: "ready", activeGroupId: "g1", activeProjectId: "p1" });
  const freshGroups: Group[] = [...groups, { id: "g2", name: "Widgets", color: "#000", clonePathTemplate: "" }];
  const freshProjects: Project[] = [...projects, { id: "p4", owner: null, name: "Gamma", localPath: "/g", groupId: "g2" }];
  let resolveGroups: (g: Group[]) => void = () => {};
  vi.mocked(listGroups).mockReturnValue(new Promise((resolve) => { resolveGroups = resolve; }));
  vi.mocked(listProjects).mockResolvedValue(freshProjects);
  const loadPromise = useRepos.getState().load();
  useRepos.getState().selectProject("p3"); // bumps revision while load() is pending
  resolveGroups(freshGroups);
  await loadPromise;
  expect(useRepos.getState()).toMatchObject({ groups: freshGroups, projects: freshProjects, activeProjectId: "p3" });
});

it("load failure sets an error and keeps prior data", async () => {
  useRepos.setState({ groups, projects, status: "ready", activeProjectId: "p1", activeGroupId: "g1" });
  vi.mocked(listGroups).mockRejectedValue(new Error("boom"));
  await useRepos.getState().load();
  expect(useRepos.getState()).toMatchObject({
    status: "error",
    error: "boom",
    groups,
    projects,
    activeProjectId: "p1",
    activeGroupId: "g1",
  });
  expect(useToasts.getState().toasts).toHaveLength(1);
});

it("switching project leaves the stage state unchanged", () => {
  useRepos.setState({ groups, projects, status: "ready" });
  const before = useStage.getState();
  useRepos.getState().selectProject("p3");
  expect(useStage.getState()).toBe(before);
});

it("deleteGroup ungroups its projects and returns an undo snapshot", async () => {
  useRepos.setState({ groups, projects, status: "ready", activeGroupId: "g1", activeProjectId: "p1" });
  const snapshot = await useRepos.getState().deleteGroup("g1");
  expect(deleteGroupIpc).toHaveBeenCalledWith("g1");
  expect(snapshot).toEqual({ group: groups[0], projectIds: ["p2", "p1"] });
  expect(useRepos.getState().groups).toEqual([]);
  expect(useRepos.getState().projects.every((p) => p.groupId === null)).toBe(true);
  expect(useRepos.getState().activeGroupId).toBeNull();
});

it("restoreGroup re-saves the group and reassigns its former projects", async () => {
  useRepos.setState({ groups, projects, status: "ready" });
  const snapshot = await useRepos.getState().deleteGroup("g1");
  await useRepos.getState().restoreGroup(snapshot!);
  expect(saveGroupIpc).toHaveBeenCalledWith(groups[0]);
  expect(useRepos.getState().groups).toEqual([groups[0]]);
  expect(useRepos.getState().projects.filter((p) => p.groupId === "g1").map((p) => p.id).sort()).toEqual(["p1", "p2"]);
});

it("restoreGroup restores activeGroupId when the active project is among the restored projects", async () => {
  useRepos.setState({ groups, projects, status: "ready", activeGroupId: "g1", activeProjectId: "p1" });
  const snapshot = await useRepos.getState().deleteGroup("g1");
  expect(useRepos.getState().activeGroupId).toBeNull();
  await useRepos.getState().restoreGroup(snapshot!);
  expect(useRepos.getState().activeGroupId).toBe("g1");
  expect(saveSetting).toHaveBeenCalledWith("repos", { activeGroupId: "g1", activeProjectId: "p1", openProjectIds: [], collapsedGroupIds: [] });
});

it("load() with legacy persisted data (no openProjectIds) opens every project", async () => {
  vi.mocked(loadSetting).mockResolvedValue({ activeGroupId: "g1", activeProjectId: "p1" });
  await useRepos.getState().load();
  expect(useRepos.getState().openProjectIds.slice().sort()).toEqual(["p1", "p2", "p3"]);
});

it("load() with a persisted close-all (non-legacy openProjectIds, no active project) keeps no active project and no open tabs", async () => {
  vi.mocked(loadSetting).mockResolvedValue({ activeGroupId: "g1", activeProjectId: null, openProjectIds: [] });
  await useRepos.getState().load();
  expect(useRepos.getState()).toMatchObject({ activeGroupId: "g1", activeProjectId: null });
  expect(useRepos.getState().openProjectIds).toEqual([]);
});

it("load() drops persisted open ids for projects that no longer exist", async () => {
  vi.mocked(loadSetting).mockResolvedValue({ activeGroupId: "g1", activeProjectId: "p1", openProjectIds: ["p1", "missing"] });
  await useRepos.getState().load();
  expect(useRepos.getState().openProjectIds).toEqual(["p1"]);
});

it("selectProject reopens a closed tab", () => {
  useRepos.setState({ groups, projects, status: "ready", openProjectIds: [] });
  useRepos.getState().selectProject("p1");
  expect(useRepos.getState().openProjectIds).toContain("p1");
});

it("closeTab on the active tab selects the neighbor to its right", () => {
  useRepos.setState({ groups, projects, status: "ready", activeGroupId: "g1", activeProjectId: "p2", openProjectIds: ["p1", "p2"] });
  useRepos.getState().closeTab("p2");
  expect(useRepos.getState()).toMatchObject({ activeProjectId: "p1", openProjectIds: ["p1"] });
  expect(saveSetting).toHaveBeenCalledWith("repos", { activeGroupId: "g1", activeProjectId: "p1", openProjectIds: ["p1"], collapsedGroupIds: [] });
});

it("closeTab falls back to the left neighbor when there is none to the right", () => {
  useRepos.setState({ groups, projects, status: "ready", activeGroupId: "g1", activeProjectId: "p1", openProjectIds: ["p1", "p2"] });
  useRepos.getState().closeTab("p1");
  expect(useRepos.getState()).toMatchObject({ activeProjectId: "p2", openProjectIds: ["p2"] });
});

it("closing the last open tab leaves no active project", () => {
  useRepos.setState({ groups, projects, status: "ready", activeGroupId: "g1", activeProjectId: "p1", openProjectIds: ["p1"] });
  useRepos.getState().closeTab("p1");
  expect(useRepos.getState()).toMatchObject({ activeProjectId: null, activeGroupId: "g1", openProjectIds: [] });
});

it("closeTab picks an Ungrouped neighbor across orphaned and null-group projects", () => {
  const orphan: Project = { id: "p4", owner: null, name: "Orphan", localPath: "/o", groupId: "ghost" };
  useRepos.setState({
    groups,
    projects: [...projects, orphan],
    status: "ready",
    activeGroupId: null,
    activeProjectId: "p3",
    openProjectIds: ["p3", "p4"],
  });
  useRepos.getState().closeTab("p3");
  expect(useRepos.getState().activeProjectId).toBe("p4");
});

it("closeTab ignores unknown ids", () => {
  useRepos.setState({ groups, projects, status: "ready", activeGroupId: "g1", activeProjectId: "p1", openProjectIds: ["p1"] });
  useRepos.getState().closeTab("nope");
  expect(useRepos.getState()).toMatchObject({ activeProjectId: "p1", openProjectIds: ["p1"] });
});

it("removeProject on the active project calls deleteProject, drops it from open tabs, and selects the neighbor", async () => {
  useRepos.setState({ groups, projects, status: "ready", activeGroupId: "g1", activeProjectId: "p2", openProjectIds: ["p1", "p2"] });
  const snapshot = await useRepos.getState().removeProject("p2");
  expect(deleteProjectIpc).toHaveBeenCalledWith("p2");
  expect(snapshot).toEqual({ project: projects[1], wasOpen: true, wasActive: true });
  expect(useRepos.getState()).toMatchObject({ activeProjectId: "p1", openProjectIds: ["p1"] });
  expect(useRepos.getState().projects.find((p) => p.id === "p2")).toBeUndefined();
});

it("removeProject → restoreProject round trip reopens and re-selects the project", async () => {
  useRepos.setState({ groups, projects, status: "ready", activeGroupId: "g1", activeProjectId: "p2", openProjectIds: ["p1", "p2"] });
  const snapshot = await useRepos.getState().removeProject("p2");
  await useRepos.getState().restoreProject(snapshot!);
  expect(saveProjectIpc).toHaveBeenCalledWith(projects[1]);
  expect(useRepos.getState().projects.find((p) => p.id === "p2")).toEqual(projects[1]);
  expect(useRepos.getState().openProjectIds).toContain("p2");
  expect(useRepos.getState()).toMatchObject({ activeProjectId: "p2", activeGroupId: "g1" });
});

it("removeProject re-reads state after the delete so a project added meanwhile survives", async () => {
  useRepos.setState({ groups, projects, status: "ready", activeGroupId: "g1", activeProjectId: "p1", openProjectIds: ["p1"] });
  let resolveDelete: (v: boolean) => void = () => {};
  vi.mocked(deleteProjectIpc).mockReturnValue(new Promise((resolve) => { resolveDelete = resolve; }));
  const removePromise = useRepos.getState().removeProject("p1");
  const added: Project = { id: "p5", owner: null, name: "Added", localPath: "/added", groupId: null };
  useRepos.setState({ projects: [...useRepos.getState().projects, added] }); // e.g. an openRepo that resolved while the delete was pending
  resolveDelete(true);
  await removePromise;
  expect(useRepos.getState().projects.find((p) => p.id === "p5")).toEqual(added);
});

it("removeProject leaves state untouched and toasts on failure", async () => {
  useRepos.setState({ groups, projects, status: "ready", activeGroupId: "g1", activeProjectId: "p1", openProjectIds: ["p1"] });
  vi.mocked(deleteProjectIpc).mockRejectedValue(new Error("boom"));
  const snapshot = await useRepos.getState().removeProject("p1");
  expect(snapshot).toBeUndefined();
  expect(useRepos.getState().projects).toEqual(projects);
  expect(useRepos.getState().openProjectIds).toEqual(["p1"]);
  expect(useToasts.getState().toasts).toHaveLength(1);
});

it("toggleGroupCollapsed toggles and persists", () => {
  useRepos.setState({ groups, projects, status: "ready", activeGroupId: "g1", activeProjectId: "p1", openProjectIds: ["p1"] });
  useRepos.getState().toggleGroupCollapsed("g1");
  expect(useRepos.getState().collapsedGroupIds).toEqual(["g1"]);
  expect(saveSetting).toHaveBeenCalledWith("repos", { activeGroupId: "g1", activeProjectId: "p1", openProjectIds: ["p1"], collapsedGroupIds: ["g1"] });

  useRepos.getState().toggleGroupCollapsed("g1");
  expect(useRepos.getState().collapsedGroupIds).toEqual([]);
  expect(saveSetting).toHaveBeenCalledWith("repos", { activeGroupId: "g1", activeProjectId: "p1", openProjectIds: ["p1"], collapsedGroupIds: [] });
});

it("load() with legacy persisted data (no collapsedGroupIds) defaults to all expanded", async () => {
  vi.mocked(loadSetting).mockResolvedValue({ activeGroupId: "g1", activeProjectId: "p1" });
  await useRepos.getState().load();
  expect(useRepos.getState().collapsedGroupIds).toEqual([]);
});

it("load() drops collapsed ids for groups that no longer exist", async () => {
  vi.mocked(loadSetting).mockResolvedValue({
    activeGroupId: "g1",
    activeProjectId: "p1",
    collapsedGroupIds: ["g1", "ungrouped", "ghost"],
  });
  await useRepos.getState().load();
  expect(useRepos.getState().collapsedGroupIds.slice().sort()).toEqual(["g1", "ungrouped"]);
});

it("deleteGroup leaves state untouched and toasts on failure", async () => {
  useRepos.setState({ groups, projects, status: "ready" });
  vi.mocked(deleteGroupIpc).mockRejectedValue(new Error("boom"));
  const snapshot = await useRepos.getState().deleteGroup("g1");
  expect(snapshot).toBeNull();
  expect(useRepos.getState().groups).toEqual(groups);
  expect(useRepos.getState().projects).toEqual(projects);
  expect(useToasts.getState().toasts).toHaveLength(1);
});

it("refuses to change the active project while an editor buffer is dirty (R7)", () => {
  useRepos.setState({ groups, projects, status: "ready", activeProjectId: "p1", openProjectIds: ["p1", "p3"] });
  useFiles.setState({ dirty: { "a.ts": true } });

  useRepos.getState().selectProject("p3");
  useRepos.getState().closeTab("p1");
  expect(useRepos.getState().activeProjectId).toBe("p1");
  expect(useRepos.getState().openProjectIds).toEqual(["p1", "p3"]);

  useFiles.setState({ dirty: {} });
  useRepos.getState().selectProject("p3");
  expect(useRepos.getState().activeProjectId).toBe("p3");
});

const fresh = { id: "/p", owner: null, name: "p", localPath: "/p", groupId: null };

it("openRepo initializes a non-Git folder after confirmation", async () => {
  vi.mocked(classifyFolder).mockResolvedValue({ kind: "notRepository" });
  vi.mocked(ask).mockResolvedValue(true);
  vi.mocked(initRepository).mockResolvedValue(fresh);

  const project = await useRepos.getState().openRepo("/p");

  expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: "Initialize Git in p?", ok: "Initialize Git" }));
  expect(initRepository).toHaveBeenCalledWith("/p");
  expect(openRepository).not.toHaveBeenCalled();
  expect(project).toEqual(fresh);
  expect(useRepos.getState().activeProjectId).toBe("/p");
});

it("openRepo does nothing when initialization is cancelled", async () => {
  vi.mocked(classifyFolder).mockResolvedValue({ kind: "notRepository" });
  vi.mocked(ask).mockResolvedValue(null);

  expect(await useRepos.getState().openRepo("/p")).toBeUndefined();

  expect(initRepository).not.toHaveBeenCalled();
  expect(useToasts.getState().toasts).toHaveLength(0);
  expect(useRepos.getState().projects).toHaveLength(0);
});

it("openRepo offers the enclosing repository instead of init", async () => {
  vi.mocked(classifyFolder).mockResolvedValue({ kind: "insideRepository", root: "/r" });
  vi.mocked(ask).mockResolvedValue(true);
  vi.mocked(openRepository).mockResolvedValue({ ...fresh, id: "/r", localPath: "/r", name: "r" });

  await useRepos.getState().openRepo("/r/sub");

  expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: "This folder is inside the repository /r", ok: "Open that repository" }));
  expect(openRepository).toHaveBeenCalledWith("/r");
  expect(initRepository).not.toHaveBeenCalled();
});
