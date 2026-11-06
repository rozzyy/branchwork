import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  cloneRepository,
  deleteGroup,
  deleteProject,
  isRepository,
  listGroups,
  listPins,
  listProjects,
  openRepository,
  pickFolder,
  pinWorktree,
  saveGroup,
  saveProject,
  unpinWorktree,
  type Group,
  type Project,
  type WorktreePin,
} from "./catalog";

const group: Group = { id: "g1", name: "Group", color: "blue", clonePathTemplate: "~/clients/{repo}" };
const project: Project = { id: "p1", owner: "owner", name: "Repo", localPath: "/repos/repo", groupId: "g1" };
const pin: WorktreePin = { projectId: "p1", worktreePath: "/repos/repo-feature" };

beforeEach(() => localStorage.clear());
afterEach(() => clearMocks());

it("uses the browser catalog fallback and preserves relationships", async () => {
  await saveGroup(group);
  await saveProject(project);
  await pinWorktree(pin);
  await pinWorktree(pin);
  expect(await listGroups()).toEqual([group]);
  expect(await listProjects()).toEqual([project]);
  expect(await listPins("p1")).toEqual([pin]);

  expect(await deleteGroup("g1")).toBe(true);
  expect(await listProjects()).toEqual([{ ...project, groupId: null }]);
  expect(await deleteProject("p1")).toBe(true);
  expect(await listPins()).toEqual([]);
  expect(await unpinWorktree("p1", pin.worktreePath)).toBe(false);
});

it("routes catalog operations through typed Tauri commands", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "groups_list") return [group];
    if (command === "projects_list") return [project];
    if (command === "pins_list") return [pin];
    return command === "group_delete" || command === "project_delete" || command === "unpin_worktree";
  });

  expect(await listGroups()).toEqual([group]);
  expect(await listProjects()).toEqual([project]);
  expect(await listPins("p1")).toEqual([pin]);
  await saveGroup(group);
  await saveProject(project);
  await pinWorktree(pin);
  await deleteGroup("g1");
  await deleteProject("p1");
  await unpinWorktree("p1", pin.worktreePath);

  expect(calls).toContainEqual({ command: "group_save", payload: { group } });
  expect(calls).toContainEqual({ command: "project_save", payload: { project } });
  expect(calls).toContainEqual({ command: "pins_list", payload: { projectId: "p1" } });
  expect(calls).toContainEqual({
    command: "pin_worktree",
    payload: { pin },
  });
});

it("rejects opening or cloning a repository outside Tauri instead of faking a project", async () => {
  await expect(openRepository("/repos/repo")).rejects.toThrow();
  await expect(cloneRepository("https://example.com/repo.git", "/repos/repo")).rejects.toThrow();
  await expect(pickFolder("Open repository")).rejects.toThrow();
});

it("routes repository open/clone through typed Tauri commands", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return project;
  });

  expect(await openRepository("/repos/repo")).toEqual(project);
  expect(await cloneRepository("https://example.com/repo.git", "/repos/repo")).toEqual(project);
  expect(calls).toContainEqual({ command: "repository_open", payload: { path: "/repos/repo" } });
  expect(calls).toContainEqual({
    command: "repository_clone",
    payload: { url: "https://example.com/repo.git", destination: "/repos/repo" },
  });
});

it("isRepository resolves false outside Tauri instead of calling a backend", async () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  expect(await isRepository("/repos/repo")).toBe(false);
});

it("isRepository routes through the typed Tauri command", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return command === "path_is_repository";
  });

  expect(await isRepository("/repos/repo")).toBe(true);
  expect(calls).toContainEqual({ command: "path_is_repository", payload: { path: "/repos/repo" } });
});
