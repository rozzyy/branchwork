import { create } from "zustand";
import {
  cloneRepository,
  deleteGroup as deleteGroupIpc,
  deleteProject as deleteProjectIpc,
  listGroups,
  listProjects,
  openRepository,
  classifyFolder,
  initRepository,
  type FolderKind,
  saveGroup as saveGroupIpc,
  saveProject as saveProjectIpc,
  type Group,
  type Project,
} from "../ipc/catalog";
import { errorMessage } from "../ipc/errors";
import { loadSetting, saveSetting } from "../ipc/settings";
import { toast } from "../ui/toast";
import { ask } from "../ui/dialog";
import { t } from "../i18n/t";
import { useFiles } from "./files";

/** What's needed to put a deleted group (and its projects) back. */
export interface GroupSnapshot {
  group: Group;
  projectIds: string[];
}

/** What's needed to put a removed project back: the record, and whether it was open/active. */
export interface ProjectSnapshot {
  project: Project;
  wasOpen: boolean;
  wasActive: boolean;
}

type Status = "idle" | "loading" | "ready" | "error";

interface PersistedSelection {
  activeGroupId: string | null;
  activeProjectId: string | null;
  openProjectIds?: string[];
  collapsedGroupIds?: string[];
}

interface ReposStore {
  groups: Group[];
  projects: Project[];
  activeGroupId: string | null;
  activeProjectId: string | null;
  openProjectIds: string[];
  collapsedGroupIds: string[];
  status: Status;
  error: string | null;
  load(): Promise<void>;
  selectProject(id: string): void;
  selectGroup(id: string | null): void;
  closeTab(id: string): void;
  removeProject(id: string): Promise<ProjectSnapshot | undefined>;
  restoreProject(snapshot: ProjectSnapshot): Promise<void>;
  toggleGroupCollapsed(id: string): void;
  openRepo(path: string): Promise<Project | undefined>;
  cloneRepo(url: string, destination: string): Promise<Project | undefined>;
  saveGroup(group: Group): Promise<void>;
  moveProject(projectId: string, groupId: string | null): Promise<void>;
  deleteGroup(id: string): Promise<GroupSnapshot | null>;
  restoreGroup(snapshot: GroupSnapshot): Promise<void>;
}

export const byName = <T extends { name: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => a.name.localeCompare(b.name));

/** A project's group for rendering: its own `groupId`, unless that group isn't among the loaded `groups` (orphaned → Ungrouped). Doesn't rewrite the stored `groupId`. */
export const effectiveGroupId = (project: Project, groups: Group[]): string | null =>
  project.groupId === null || groups.some((g) => g.id === project.groupId) ? project.groupId : null;

/**
 * Projects in a group (Ungrouped when `groupId` is null), ordered by name.
 * Pass `groups` to also fold in projects whose stored `groupId` doesn't match any loaded group.
 */
export const projectsForGroup = (projects: Project[], groupId: string | null, groups?: Group[]): Project[] =>
  byName(projects.filter((p) => (groups ? effectiveGroupId(p, groups) : p.groupId) === groupId));

/** Merges freshly loaded items with any already in state but missing from the load (e.g. added mid-flight), by id. */
function mergeById<T extends { id: string }>(loaded: T[], current: T[]): T[] {
  const loadedIds = new Set(loaded.map((x) => x.id));
  return [...loaded, ...current.filter((x) => !loadedIds.has(x.id))];
}

function resolveSelection(
  groups: Group[],
  projects: Project[],
  persisted: PersistedSelection | null,
): PersistedSelection {
  const persistedProjectId = persisted?.activeProjectId ?? null;
  const persistedGroupId = persisted?.activeGroupId ?? null;
  // Non-legacy data that explicitly closed every tab (openProjectIds present, no active project)
  // stays closed on relaunch; legacy data (no openProjectIds) keeps the old group-fallback behavior.
  const closedAllTabs = persisted !== null && persisted.openProjectIds !== undefined && persistedProjectId === null;

  const project = persistedProjectId ? projects.find((p) => p.id === persistedProjectId) : undefined;
  if (project) return { activeGroupId: effectiveGroupId(project, groups), activeProjectId: project.id };

  const groupValid = persistedGroupId === null || groups.some((g) => g.id === persistedGroupId);
  const restoredGroupId = groupValid ? persistedGroupId : null;
  if (closedAllTabs) return { activeGroupId: restoredGroupId, activeProjectId: null };

  const inGroup = projectsForGroup(projects, restoredGroupId, groups);
  if (inGroup.length) return { activeGroupId: restoredGroupId, activeProjectId: inGroup[0].id };

  const all = byName(projects);
  if (all.length) return { activeGroupId: effectiveGroupId(all[0], groups), activeProjectId: all[0].id };

  return { activeGroupId: restoredGroupId, activeProjectId: null };
}

/** Open tabs: legacy data (no persisted list) opens everything; otherwise drop missing ids. The active project is always open. */
function resolveOpenProjectIds(
  projects: Project[],
  persistedOpenIds: string[] | undefined,
  activeProjectId: string | null,
): string[] {
  const validIds = new Set(projects.map((p) => p.id));
  const open =
    persistedOpenIds === undefined
      ? projects.map((p) => p.id)
      : persistedOpenIds.filter((id) => validIds.has(id));
  if (activeProjectId !== null && !open.includes(activeProjectId)) open.push(activeProjectId);
  return open;
}

/** Which open tab becomes active after `removedProject` is closed/removed: its right neighbor among open tabs in the same (effective) group, else its left, else none. */
function neighborAfterRemoval(projects: Project[], openProjectIds: string[], groups: Group[], removedProject: Project): string | null {
  const groupId = effectiveGroupId(removedProject, groups);
  const tabOrder = projectsForGroup(projects, groupId, groups).filter((p) => openProjectIds.includes(p.id));
  const idx = tabOrder.findIndex((p) => p.id === removedProject.id);
  return tabOrder[idx + 1]?.id ?? tabOrder[idx - 1]?.id ?? null;
}

/** Collapsed group ids ("ungrouped" for Ungrouped), dropping ids of groups that no longer exist. Missing persisted list → all expanded. */
function resolveCollapsedGroupIds(groups: Group[], persisted: string[] | undefined): string[] {
  if (!persisted) return [];
  return persisted.filter((id) => id === "ungrouped" || groups.some((g) => g.id === id));
}

// ponytail: bumped on every load()/selectProject/selectGroup so a slow load()
// can't clobber a selection made (or a newer load started) while it was in flight.
let revision = 0;

/** All writers share this so `repos` settings always carries every persisted field. */
function persistRepos(state: Pick<ReposStore, "activeGroupId" | "activeProjectId" | "openProjectIds" | "collapsedGroupIds">) {
  void saveSetting("repos", {
    activeGroupId: state.activeGroupId,
    activeProjectId: state.activeProjectId,
    openProjectIds: state.openProjectIds,
    collapsedGroupIds: state.collapsedGroupIds,
  });
}

/** R7: editor buffers belong to the active project's worktree. Refuse (with a toast) any change of
 * active project while an editor buffer is dirty, before the title bar and sidebar can diverge. */
function dirtySwitchBlocked(currentId: string | null, nextId: string | null): boolean {
  if (nextId === currentId || Object.keys(useFiles.getState().dirty).length === 0) return false;
  toast({ title: t("files.switchDirtyBlocked"), icon: "⚠" });
  return true;
}

export const useRepos = create<ReposStore>((set, get) => ({
  groups: [],
  projects: [],
  activeGroupId: null,
  activeProjectId: null,
  openProjectIds: [],
  collapsedGroupIds: [],
  status: "idle",
  error: null,
  async load() {
    revision++;
    const loadedAtRevision = revision;
    set({ status: "loading" });
    try {
      const [groups, projects] = await Promise.all([listGroups(), listProjects()]);
      const persisted = await loadSetting<PersistedSelection>("repos");
      const mergedGroups = mergeById(groups, get().groups);
      const mergedProjects = mergeById(projects, get().projects);
      if (revision !== loadedAtRevision) {
        // A selection/open was made while this load was in flight: keep it, but still surface the loaded data.
        set({ groups: mergedGroups, projects: mergedProjects, status: "ready", error: null });
        return;
      }
      const selection = resolveSelection(groups, projects, persisted);
      const openProjectIds = resolveOpenProjectIds(projects, persisted?.openProjectIds, selection.activeProjectId);
      const collapsedGroupIds = resolveCollapsedGroupIds(groups, persisted?.collapsedGroupIds);
      set({ groups: mergedGroups, projects: mergedProjects, status: "ready", error: null, ...selection, openProjectIds, collapsedGroupIds });
    } catch (e) {
      if (revision !== loadedAtRevision) return;
      const message = errorMessage(e);
      set({ status: "error", error: message });
      toast({ title: t("repos.loadError", { message }), icon: "⚠" });
    }
  },
  selectProject(id) {
    const project = get().projects.find((p) => p.id === id);
    if (!project || dirtySwitchBlocked(get().activeProjectId, project.id)) return;
    revision++;
    const openProjectIds = get().openProjectIds.includes(id) ? get().openProjectIds : [...get().openProjectIds, id];
    set({ activeGroupId: effectiveGroupId(project, get().groups), activeProjectId: project.id, openProjectIds });
    persistRepos(get());
  },
  selectGroup(id) {
    revision++;
    const { projects, groups, openProjectIds } = get();
    const inGroup = projectsForGroup(projects, id, groups);
    const first = inGroup.find((p) => openProjectIds.includes(p.id)) ?? inGroup[0] ?? null;
    if (dirtySwitchBlocked(get().activeProjectId, first?.id ?? null)) return;
    const nextOpenIds = first && !openProjectIds.includes(first.id) ? [...openProjectIds, first.id] : openProjectIds;
    set({ activeGroupId: id, activeProjectId: first?.id ?? null, openProjectIds: nextOpenIds });
    persistRepos(get());
  },
  closeTab(id) {
    const project = get().projects.find((p) => p.id === id);
    if (!project) return;
    const { openProjectIds, activeProjectId, projects, groups } = get();
    const nextOpenIds = openProjectIds.filter((pid) => pid !== id);
    const nextActiveId =
      activeProjectId === id ? neighborAfterRemoval(projects, openProjectIds, groups, project) : activeProjectId;
    if (dirtySwitchBlocked(activeProjectId, nextActiveId)) return;
    revision++;
    set({ openProjectIds: nextOpenIds, activeProjectId: nextActiveId });
    persistRepos(get());
  },
  async removeProject(id) {
    const project = get().projects.find((p) => p.id === id);
    if (!project) return undefined;
    const wasOpen = get().openProjectIds.includes(id);
    const wasActive = get().activeProjectId === id;
    if (wasActive && dirtySwitchBlocked(id, null)) return undefined;
    try {
      await deleteProjectIpc(id);
      revision++;
      const { projects, openProjectIds, activeProjectId, groups } = get();
      const nextActiveId = wasActive ? neighborAfterRemoval(projects, openProjectIds, groups, project) : activeProjectId;
      set({
        projects: projects.filter((p) => p.id !== id),
        openProjectIds: openProjectIds.filter((pid) => pid !== id),
        activeProjectId: nextActiveId,
      });
      persistRepos(get());
      return { project, wasOpen, wasActive };
    } catch (e) {
      toast({ title: t("repos.removeError", { message: errorMessage(e) }), icon: "⚠" });
      return undefined;
    }
  },
  async restoreProject(snapshot) {
    const { project, wasOpen, wasActive } = snapshot;
    try {
      await saveProjectIpc(project);
      revision++;
      const openProjectIds =
        wasOpen && !get().openProjectIds.includes(project.id) ? [...get().openProjectIds, project.id] : get().openProjectIds;
      set({
        projects: [...get().projects.filter((p) => p.id !== project.id), project],
        openProjectIds,
        ...(wasActive && !dirtySwitchBlocked(get().activeProjectId, project.id)
          ? { activeProjectId: project.id, activeGroupId: effectiveGroupId(project, get().groups) }
          : {}),
      });
      persistRepos(get());
    } catch (e) {
      toast({ title: t("repos.restoreError", { message: errorMessage(e) }), icon: "⚠" });
    }
  },
  toggleGroupCollapsed(id) {
    revision++;
    const { collapsedGroupIds } = get();
    const next = collapsedGroupIds.includes(id) ? collapsedGroupIds.filter((gid) => gid !== id) : [...collapsedGroupIds, id];
    set({ collapsedGroupIds: next });
    persistRepos(get());
  },
  async openRepo(path) {
    // Issue #5: a non-Git folder is offered `git init`; a folder inside a repo offers that repo.
    let kind: FolderKind;
    try {
      kind = await classifyFolder(path);
    } catch (e) {
      toast({ title: t("repos.openError", { message: errorMessage(e) }), icon: "⚠" });
      return undefined;
    }
    if (kind.kind === "invalid") {
      toast({ title: t("repos.openError", { message: kind.message }), icon: "⚠" });
      return undefined;
    }
    if (kind.kind === "insideRepository") {
      const confirmed = await ask({ title: t("repos.insideTitle", { root: kind.root }), ok: t("repos.insideOk"), icon: "⌂" });
      if (confirmed !== true) return undefined;
      path = kind.root;
    }
    let initialize = false;
    if (kind.kind === "notRepository") {
      const folder = path.split("/").filter(Boolean).pop() ?? path;
      const confirmed = await ask({
        title: t("repos.initTitle", { folder }),
        body: t("repos.initBody", { path }),
        ok: t("repos.initOk"),
        icon: "⎇",
      });
      if (confirmed !== true) return undefined;
      initialize = true;
    }
    try {
      const project = await (initialize ? initRepository(path) : openRepository(path));
      revision++;
      const openProjectIds = get().openProjectIds.includes(project.id) ? get().openProjectIds : [...get().openProjectIds, project.id];
      const activate = !dirtySwitchBlocked(get().activeProjectId, project.id);
      set({
        projects: [...get().projects.filter((p) => p.id !== project.id), project],
        openProjectIds,
        ...(activate ? { activeGroupId: effectiveGroupId(project, get().groups), activeProjectId: project.id } : {}),
      });
      persistRepos(get());
      return project;
    } catch (e) {
      toast({
        title: t("repos.openError", { message: errorMessage(e) }),
        icon: "⚠",
        details: (e as { detail?: string | null } | null)?.detail ?? undefined,
      });
      return undefined;
    }
  },
  async cloneRepo(url, destination) {
    try {
      const project = await cloneRepository(url, destination);
      revision++;
      const openProjectIds = get().openProjectIds.includes(project.id) ? get().openProjectIds : [...get().openProjectIds, project.id];
      const activate = !dirtySwitchBlocked(get().activeProjectId, project.id);
      set({
        projects: [...get().projects.filter((p) => p.id !== project.id), project],
        openProjectIds,
        ...(activate ? { activeGroupId: effectiveGroupId(project, get().groups), activeProjectId: project.id } : {}),
      });
      persistRepos(get());
      return project;
    } catch (e) {
      toast({ title: t("repos.cloneError", { message: errorMessage(e) }), icon: "⚠" });
      return undefined;
    }
  },
  async saveGroup(group) {
    try {
      await saveGroupIpc(group);
      set({ groups: [...get().groups.filter((g) => g.id !== group.id), group] });
    } catch (e) {
      toast({ title: t("repos.saveGroupError", { message: errorMessage(e) }), icon: "⚠" });
    }
  },
  async moveProject(projectId, groupId) {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;
    const moved = { ...project, groupId };
    try {
      await saveProjectIpc(moved);
      revision++;
      set({
        projects: get().projects.map((p) => (p.id === projectId ? moved : p)),
        activeGroupId: get().activeProjectId === projectId ? groupId : get().activeGroupId,
      });
    } catch (e) {
      toast({ title: t("repos.moveError", { message: errorMessage(e) }), icon: "⚠" });
    }
  },
  async deleteGroup(id) {
    const group = get().groups.find((g) => g.id === id);
    if (!group) return null;
    const projectIds = projectsForGroup(get().projects, id).map((p) => p.id);
    try {
      await deleteGroupIpc(id);
      revision++;
      set({
        groups: get().groups.filter((g) => g.id !== id),
        projects: get().projects.map((p) => (p.groupId === id ? { ...p, groupId: null } : p)),
        activeGroupId: get().activeGroupId === id ? null : get().activeGroupId,
      });
      return { group, projectIds };
    } catch (e) {
      toast({ title: t("repos.deleteGroupError", { message: errorMessage(e) }), icon: "⚠" });
      return null;
    }
  },
  async restoreGroup(snapshot) {
    try {
      await saveGroupIpc(snapshot.group);
      const projects = get().projects.filter((p) => snapshot.projectIds.includes(p.id));
      await Promise.all(projects.map((p) => saveProjectIpc({ ...p, groupId: snapshot.group.id })));
      revision++;
      const activeProjectId = get().activeProjectId;
      const activeRestored = activeProjectId !== null && snapshot.projectIds.includes(activeProjectId);
      set({
        groups: [...get().groups.filter((g) => g.id !== snapshot.group.id), snapshot.group],
        projects: get().projects.map((p) =>
          snapshot.projectIds.includes(p.id) ? { ...p, groupId: snapshot.group.id } : p,
        ),
        activeGroupId: activeRestored ? snapshot.group.id : get().activeGroupId,
      });
      if (activeRestored) {
        persistRepos(get());
      }
    } catch (e) {
      toast({ title: t("repos.restoreGroupError", { message: errorMessage(e) }), icon: "⚠" });
    }
  },
}));
