import { create } from "zustand";
import { listPins, pinWorktree, unpinWorktree, type Project } from "../ipc/catalog";
import { errorMessage } from "../ipc/errors";
import { listWorktrees, type Worktree } from "../ipc/worktrees";
import { loadSetting, saveSetting } from "../ipc/settings";
import { t } from "../i18n/t";
import { toast } from "../ui/toast";
import { useFiles } from "./files";

interface CachedProjectWorktrees {
  worktrees: Worktree[];
  activePath: string | null;
}

interface WorktreesStore {
  projectId: string | null;
  worktrees: Worktree[];
  pinnedPaths: string[];
  activePath: string | null;
  selections: Record<string, string>;
  byProject: Record<string, CachedProjectWorktrees>;
  loading: boolean;
  error: string | null;
  load(project: Project | null): Promise<void>;
  select(path: string): void;
  setPinned(projectId: string, path: string, pinned: boolean): Promise<void>;
  /** Load (and cache) another project's worktrees without disturbing the active one. Null on failure. */
  ensureProjectWorktrees(project: Project): Promise<CachedProjectWorktrees | null>;
  /** Worktree paths for a project: live global list, cache, or the repo root as a last resort. */
  worktreePathsFor(project: Project): string[];
  /** Switch the cached active worktree of a non-active project (pinned panes). Dirty-guarded like select(). */
  selectCachedWorktree(projectId: string, path: string): void;
}

let revision = 0;

/** In-flight per-project loads, so concurrent pins share one fetch. */
const inflight = new Map<string, Promise<CachedProjectWorktrees | null>>();
/** Most-recently-used cache order; evicted past the cap. */
const cacheOrder: string[] = [];
const CACHE_CAP = 5;

/** Move the id to the most-recent end, evicting nothing here (set() drops the overflow). */
function touchCacheOrder(id: string): void {
  const at = cacheOrder.indexOf(id);
  if (at >= 0) cacheOrder.splice(at, 1);
  cacheOrder.push(id);
}

export const useWorktrees = create<WorktreesStore>((set, get) => ({
  projectId: null,
  worktrees: [],
  pinnedPaths: [],
  activePath: null,
  selections: {},
  byProject: {},
  loading: false,
  error: null,
  async ensureProjectWorktrees(project) {
    const cached = get().byProject[project.id];
    if (cached) {
      touchCacheOrder(project.id);
      return cached;
    }
    const running = inflight.get(project.id);
    if (running) return running;
    const task = (async (): Promise<CachedProjectWorktrees | null> => {
      try {
        const [worktrees, persistedSelections] = await Promise.all([
          listWorktrees(project.id),
          loadSetting<Record<string, string>>("activeWorktrees"),
        ]);
        const persistedPath = persistedSelections?.[project.id];
        const activePath =
          worktrees.some((worktree) => worktree.path === persistedPath)
            ? (persistedPath as string)
            : worktrees.some((worktree) => worktree.path === project.localPath)
              ? project.localPath
              : (worktrees[0]?.path ?? null);
        const entry: CachedProjectWorktrees = { worktrees, activePath };
        touchCacheOrder(project.id);
        set((state) => {
          const byProject = { ...state.byProject, [project.id]: entry };
          for (const stale of cacheOrder.slice(CACHE_CAP)) delete byProject[stale];
          return { byProject };
        });
        return entry;
      } catch {
        return null;
      } finally {
        inflight.delete(project.id);
      }
    })();
    inflight.set(project.id, task);
    return task;
  },
  worktreePathsFor(project) {
    const { projectId, worktrees, byProject } = get();
    // Live data wins for the active project; the cache serves pinned ones.
    if (project.id === projectId) return worktrees.map((worktree) => worktree.path);
    const cached = byProject[project.id];
    if (cached) return cached.worktrees.map((worktree) => worktree.path);
    return [project.localPath];
  },
  selectCachedWorktree(projectId, path) {
    const cached = get().byProject[projectId];
    if (!cached || !cached.worktrees.some((worktree) => worktree.path === path)) return;
    if (path !== cached.activePath && Object.keys(useFiles.getState().dirty).length > 0) {
      toast({ title: t("files.switchDirtyBlocked"), icon: "⚠" });
      return;
    }
    const selections = { ...get().selections, [projectId]: path };
    set((state) => ({
      selections,
      byProject: { ...state.byProject, [projectId]: { ...cached, activePath: path } },
    }));
    void saveSetting("activeWorktrees", selections).catch((error: unknown) => {
      toast({ title: t("sidebar.selectionError", { message: errorMessage(error) }), icon: "⚠" });
    });
  },
  async load(project) {
    const request = ++revision;
    const projectChanged = get().projectId !== (project?.id ?? null);
    // R5b: load() also switches the active worktree (and so the editor's buffers) when the
    // project changes — it must refuse the same way select() does instead of silently dropping
    // unsaved edits and leaving the dirty flag stuck on another project's file.
    if (projectChanged && Object.keys(useFiles.getState().dirty).length > 0) {
      toast({ title: t("files.switchDirtyBlocked"), icon: "⚠" });
      return;
    }
    if (!project) {
      set({ projectId: null, worktrees: [], pinnedPaths: [], activePath: null, loading: false, error: null });
      return;
    }

    set({
      projectId: project.id,
      ...(projectChanged ? { worktrees: [], pinnedPaths: [], activePath: null } : {}),
      // Only show the loading spinner on a project change (no data yet).
      // On a same-project refresh (e.g. triggered by git:changed), keep the
      // existing data visible so the sidebar doesn't flash to a blank state.
      loading: projectChanged,
      error: null,
    });
    try {
      const [worktrees, pins, persistedSelections] = await Promise.all([
        listWorktrees(project.id),
        listPins(project.id),
        loadSetting<Record<string, string>>("activeWorktrees"),
      ]);
      if (request !== revision) return;
      const previous = get().projectId === project.id ? get().activePath : null;
      const selections = { ...get().selections, ...(persistedSelections ?? {}) };
      const persistedPath = selections[project.id] ?? previous;
      const activePath =
        worktrees.some((worktree) => worktree.path === persistedPath)
          ? persistedPath
          : worktrees.some((worktree) => worktree.path === project.localPath)
            ? project.localPath
            : worktrees[0]?.path ?? null;
      set((state) => {
        touchCacheOrder(project.id);
        const byProject = { ...state.byProject, [project.id]: { worktrees, activePath } };
        for (const stale of cacheOrder.slice(CACHE_CAP)) delete byProject[stale];
        return {
          projectId: project.id,
          worktrees,
          pinnedPaths: pins.map((pin) => pin.worktreePath),
          activePath,
          selections,
          loading: false,
          error: null,
          byProject,
        };
      });
    } catch (error) {
      if (request !== revision) return;
      set({
        projectId: project.id,
        worktrees: [],
        pinnedPaths: [],
        activePath: null,
        loading: false,
        error: errorMessage(error),
      });
    }
  },
  select(path) {
    const { projectId, worktrees, selections } = get();
    if (!projectId || !worktrees.some((worktree) => worktree.path === path)) return;
    // Editor buffers belong to the active worktree; switching would drop unsaved edits.
    if (path !== get().activePath && Object.keys(useFiles.getState().dirty).length > 0) {
      toast({ title: t("files.switchDirtyBlocked"), icon: "⚠" });
      return;
    }
    const nextSelections = { ...selections, [projectId]: path };
    set({ activePath: path, selections: nextSelections });
    void saveSetting("activeWorktrees", nextSelections).catch((error: unknown) => {
      toast({
        title: t("sidebar.selectionError", { message: errorMessage(error) }),
        icon: "⚠",
      });
    });
  },
  async setPinned(projectId, path, pinned) {
    if (get().projectId !== projectId) return;
    try {
      if (pinned) {
        await pinWorktree({ projectId, worktreePath: path });
        if (get().projectId !== projectId) return;
        set({ pinnedPaths: get().pinnedPaths.includes(path) ? get().pinnedPaths : [...get().pinnedPaths, path] });
      } else {
        await unpinWorktree(projectId, path);
        if (get().projectId !== projectId) return;
        set({ pinnedPaths: get().pinnedPaths.filter((item) => item !== path) });
      }
    } catch (error) {
      if (get().projectId !== projectId) return;
      toast({
        title: t("sidebar.pinError", { message: errorMessage(error) }),
        icon: "⚠",
      });
    }
  },
}));
