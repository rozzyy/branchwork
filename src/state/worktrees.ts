import { create } from "zustand";
import { listPins, pinWorktree, unpinWorktree, type Project } from "../ipc/catalog";
import { errorMessage } from "../ipc/errors";
import { listWorktrees, type Worktree } from "../ipc/worktrees";
import { loadSetting, saveSetting } from "../ipc/settings";
import { t } from "../i18n/t";
import { toast } from "../ui/toast";

interface WorktreesStore {
  projectId: string | null;
  worktrees: Worktree[];
  pinnedPaths: string[];
  activePath: string | null;
  selections: Record<string, string>;
  loading: boolean;
  error: string | null;
  load(project: Project | null): Promise<void>;
  select(path: string): void;
  setPinned(projectId: string, path: string, pinned: boolean): Promise<void>;
}

let revision = 0;

export const useWorktrees = create<WorktreesStore>((set, get) => ({
  projectId: null,
  worktrees: [],
  pinnedPaths: [],
  activePath: null,
  selections: {},
  loading: false,
  error: null,
  async load(project) {
    const request = ++revision;
    if (!project) {
      set({ projectId: null, worktrees: [], pinnedPaths: [], activePath: null, loading: false, error: null });
      return;
    }

    const projectChanged = get().projectId !== project.id;
    set({
      projectId: project.id,
      ...(projectChanged ? { worktrees: [], pinnedPaths: [], activePath: null } : {}),
      loading: true,
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
      set({
        projectId: project.id,
        worktrees,
        pinnedPaths: pins.map((pin) => pin.worktreePath),
        activePath,
        selections,
        loading: false,
        error: null,
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
