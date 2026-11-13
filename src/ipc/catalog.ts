import { open } from "@tauri-apps/plugin-dialog";
import { commands, type Group, type Project_Serialize, type WorktreePin, type FolderKind } from "./bindings";

export type { Group, WorktreePin } from "./bindings";
export type Project = Project_Serialize;

interface Catalog {
  groups: Group[];
  projects: Project[];
  pins: WorktreePin[];
}

const STORAGE_KEY = "bw:catalog";
const emptyCatalog = (): Catalog => ({ groups: [], projects: [], pins: [] });
const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isGroup = (value: unknown): value is Group =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  typeof value.color === "string" &&
  typeof value.clonePathTemplate === "string";

const isProject = (value: unknown): value is Project =>
  isRecord(value) &&
  typeof value.id === "string" &&
  (value.owner === null || typeof value.owner === "string") &&
  typeof value.name === "string" &&
  typeof value.localPath === "string" &&
  (value.groupId === null || typeof value.groupId === "string");

const isPin = (value: unknown): value is WorktreePin =>
  isRecord(value) &&
  typeof value.projectId === "string" &&
  typeof value.worktreePath === "string";

const isCatalog = (value: unknown): value is Catalog =>
  isRecord(value) &&
  Array.isArray(value.groups) &&
  value.groups.every(isGroup) &&
  Array.isArray(value.projects) &&
  value.projects.every(isProject) &&
  Array.isArray(value.pins) &&
  value.pins.every(isPin);

function readCatalog(): Catalog {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyCatalog();
  const value: unknown = JSON.parse(raw);
  if (!isCatalog(value)) throw new Error("Stored repository catalog is invalid");
  return value;
}

function updateCatalog(update: (catalog: Catalog) => Catalog): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(update(readCatalog())));
}

export function listGroups(): Promise<Group[]> {
  return inTauri() ? commands.groupsList() : Promise.resolve(readCatalog().groups);
}

export function saveGroup(group: Group): Promise<void> {
  if (inTauri()) return commands.groupSave(group).then(() => undefined);
  updateCatalog((catalog) => ({
    ...catalog,
    groups: [...catalog.groups.filter((item) => item.id !== group.id), group],
  }));
  return Promise.resolve();
}

export function deleteGroup(id: string): Promise<boolean> {
  if (inTauri()) return commands.groupDelete(id);
  let deleted = false;
  updateCatalog((catalog) => {
    deleted = catalog.groups.some((group) => group.id === id);
    return {
      ...catalog,
      groups: catalog.groups.filter((group) => group.id !== id),
      projects: catalog.projects.map((project) =>
        project.groupId === id ? { ...project, groupId: null } : project,
      ),
    };
  });
  return Promise.resolve(deleted);
}

export function listProjects(): Promise<Project[]> {
  return inTauri() ? commands.projectsList() : Promise.resolve(readCatalog().projects);
}

export function saveProject(project: Project): Promise<void> {
  if (inTauri()) return commands.projectSave(project).then(() => undefined);
  updateCatalog((catalog) => ({
    ...catalog,
    projects: [...catalog.projects.filter((item) => item.id !== project.id), project],
  }));
  return Promise.resolve();
}

export function deleteProject(id: string): Promise<boolean> {
  if (inTauri()) return commands.projectDelete(id);
  let deleted = false;
  updateCatalog((catalog) => {
    deleted = catalog.projects.some((project) => project.id === id);
    return {
      ...catalog,
      projects: catalog.projects.filter((project) => project.id !== id),
      pins: catalog.pins.filter((pin) => pin.projectId !== id),
    };
  });
  return Promise.resolve(deleted);
}

export function listPins(projectId?: string): Promise<WorktreePin[]> {
  if (inTauri()) return commands.pinsList(projectId ?? null);
  const pins = readCatalog().pins;
  return Promise.resolve(projectId ? pins.filter((pin) => pin.projectId === projectId) : pins);
}

export function pinWorktree(pin: WorktreePin): Promise<void> {
  if (inTauri()) return commands.pinWorktree(pin).then(() => undefined);
  updateCatalog((catalog) => ({
    ...catalog,
    pins: catalog.pins.some(
      (item) => item.projectId === pin.projectId && item.worktreePath === pin.worktreePath,
    )
      ? catalog.pins
      : [...catalog.pins, pin],
  }));
  return Promise.resolve();
}

/** Opens an existing repository on disk and registers it as a project. No browser fallback: this needs the Rust/libgit2 backend. */
export function openRepository(path: string): Promise<Project> {
  if (!inTauri()) return Promise.reject(new Error("Opening a repository requires the desktop app"));
  return commands.repositoryOpen(path);
}

/** Read-only: whether a picked folder is a repository, inside one, not one, or unreadable. */
export type { FolderKind };

export function classifyFolder(path: string): Promise<FolderKind> {
  if (!inTauri()) return Promise.reject(new Error("Opening a folder requires the desktop app"));
  return commands.repositoryClassify(path);
}

/** Runs `git init` in a folder that isn't a repository yet and registers it as a project. */
export function initRepository(path: string): Promise<Project> {
  if (!inTauri()) return Promise.reject(new Error("Initializing a repository requires the desktop app"));
  return commands.repositoryInit(path);
}

/** Read-only check: whether `path` is itself a Git repository root (no parent search). Outside Tauri, resolves `false` (no browser equivalent to check against). */
export function isRepository(path: string): Promise<boolean> {
  if (!inTauri()) return Promise.resolve(false);
  return commands.pathIsRepository(path);
}

/** Shows the native folder picker; resolves to the chosen path, or `null` if cancelled. No browser fallback: needs the desktop app's dialog plugin. */
export function pickFolder(title: string): Promise<string | null> {
  if (!inTauri()) return Promise.reject(new Error("Opening a repository requires the desktop app"));
  return open({ directory: true, multiple: false, title });
}

/** Clones a repository to `destination` and registers it as a project. No browser fallback: this needs the Rust/libgit2 backend. */
export function cloneRepository(url: string, destination: string): Promise<Project> {
  if (!inTauri()) return Promise.reject(new Error("Cloning a repository requires the desktop app"));
  return commands.repositoryClone(url, destination);
}

export function unpinWorktree(projectId: string, worktreePath: string): Promise<boolean> {
  if (inTauri()) return commands.unpinWorktree(projectId, worktreePath);
  let removed = false;
  updateCatalog((catalog) => ({
    ...catalog,
    pins: catalog.pins.filter((pin) => {
      const keep = pin.projectId !== projectId || pin.worktreePath !== worktreePath;
      if (!keep) removed = true;
      return keep;
    }),
  }));
  return Promise.resolve(removed);
}
