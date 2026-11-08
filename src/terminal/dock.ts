import { create } from "zustand";
import { closeTerminal, onTerminalExit, spawnTerminal } from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { errorMessage } from "../ipc/errors";
import { t } from "../i18n/t";
import { toast } from "../ui/toast";
import { useWorktrees } from "../state/worktrees";

export type DockMode = "bottom" | "right" | "floating" | "maximized";

export interface DockTab {
  id: string;
  worktreePath: string;
  sessionId: string | null;
  error: string | null;
}

export interface FloatingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PersistedDock {
  mode?: DockMode;
  bottomHeight?: number;
  rightWidth?: number;
  floating?: FloatingRect;
  tabs?: Array<{ id: string; worktreePath: string }>;
  selectedId?: string | null;
  splitIds?: [string, string] | null;
}

const DOCK_KEY = "terminalDock";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

let tabCounter = 0;
function nextTabId(): string {
  tabCounter += 1;
  return `dock-tab-${Date.now().toString(36)}-${tabCounter}`;
}

function tabName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function validMode(mode: unknown): mode is DockMode {
  return mode === "bottom" || mode === "right" || mode === "floating" || mode === "maximized";
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon(snapshot: PersistedDock): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSetting(DOCK_KEY, snapshot), 300);
}

// Tabs whose PTY spawn has not settled yet. Guards two races: a spawn that
// resolves after its tab was closed must be closed, never attached; a second
// spawn for the same tab must not start while the first is in flight.
const pendingSpawns = new Set<string>();

// Process-exit subscription shared by all dock tabs. Installed once on load;
// the handler looks tabs up live, so it stays correct across reloads.
let exitSubscription: Promise<() => void> | null = null;

// Remove a tab and repair selection/split; the caller decides whether the
// PTY session is closed (closeTab) or handed to a new owner (detachTab).
function dropTab(
  get: () => DockStore,
  set: (partial: Partial<DockStore>) => void,
  save: () => void,
  id: string,
): void {
  const { tabs, selectedId, splitIds } = get();
  const remaining = tabs.filter((item) => item.id !== id);
  let nextSelected = selectedId;
  let nextSplit = splitIds;
  if (nextSplit && nextSplit.includes(id)) nextSplit = null;
  if (nextSelected === id) {
    const previousIndex = tabs.findIndex((item) => item.id === id);
    nextSelected = remaining[Math.min(previousIndex, remaining.length - 1)]?.id ?? null;
  }
  set({ tabs: remaining, selectedId: nextSelected, splitIds: nextSplit });
  save();
}

interface DockStore {
  open: boolean;
  mode: DockMode;
  bottomHeight: number;
  rightWidth: number;
  floating: FloatingRect;
  tabs: DockTab[];
  selectedId: string | null;
  /** Ordered pair of visible tab ids when split; null for a single pane. */
  splitIds: [string, string] | null;
  loaded: boolean;
  toggle(): void;
  setOpen(open: boolean): void;
  setMode(mode: DockMode): void;
  setBottomHeight(height: number): void;
  setRightWidth(width: number): void;
  setFloating(rect: FloatingRect): void;
  /** Open the dock and start a new shell tab in `worktreePath` (default: active worktree). */
  newTab(worktreePath?: string): Promise<string | null>;
  /** Open the dock on `worktreePath`, reusing an existing tab when one is already bound there. */
  openHere(worktreePath: string): Promise<void>;
  retryTab(id: string): Promise<void>;
  select(id: string): void;
  /** Show a second tab beside the selected one, or hide the second pane when already split. */
  toggleSplit(): Promise<void>;
  swapSplit(): void;
  closeTab(id: string): Promise<void>;
  /** Add a tab around a live session owned by someone else; never spawns. */
  adoptExisting(worktreePath: string, sessionId: string): string;
  /** Remove a tab without closing its PTY so a new owner can adopt the session. */
  detachTab(id: string): DockTab | null;
  load(): Promise<void>;
}

function snapshot(get: () => DockStore): PersistedDock {
  const state = get();
  return {
    mode: state.mode,
    bottomHeight: state.bottomHeight,
    rightWidth: state.rightWidth,
    floating: state.floating,
    tabs: state.tabs.map((tab) => ({ id: tab.id, worktreePath: tab.worktreePath })),
    selectedId: state.selectedId,
    splitIds: state.splitIds,
  };
}

async function spawnFor(tab: DockTab): Promise<{ sessionId: string } | { error: string }> {
  try {
    const session = await spawnTerminal(tab.worktreePath, DEFAULT_COLS, DEFAULT_ROWS);
    return { sessionId: session.sessionId };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export const useDock = create<DockStore>((set, get) => {
  const save = () => persistSoon(snapshot(get));

  const spawnTabSession = async (
    tab: DockTab,
  ): Promise<{ sessionId: string } | { error: string } | null> => {
    if (pendingSpawns.has(tab.id)) return null;
    pendingSpawns.add(tab.id);
    try {
      return await spawnFor(tab);
    } finally {
      pendingSpawns.delete(tab.id);
    }
  };

  // Close a spawn that settled after its tab was removed, so the backend
  // session never leaks. Returns true when the tab is gone.
  const closeOrphan = async (
    tabId: string,
    result: { sessionId: string } | { error: string },
  ): Promise<boolean> => {
    if (get().tabs.some((item) => item.id === tabId)) return false;
    if ("sessionId" in result) {
      try {
        await closeTerminal(result.sessionId);
      } catch {
        // The backend session is already gone; nothing left to clean up.
      }
    }
    return true;
  };

  return {
    open: false,
    mode: "bottom",
    bottomHeight: 260,
    rightWidth: 400,
    floating: { x: 80, y: 80, width: 720, height: 420 },
    tabs: [],
    selectedId: null,
    splitIds: null,
    loaded: false,

    toggle() {
      set({ open: !get().open });
    },

    setOpen(open) {
      if (get().open !== open) set({ open });
    },

    setMode(mode) {
      set({ mode });
      save();
    },

    setBottomHeight(height) {
      set({ bottomHeight: clamp(Math.round(height), 120, 640) });
      save();
    },

    setRightWidth(width) {
      set({ rightWidth: clamp(Math.round(width), 280, 880) });
      save();
    },

    setFloating(rect) {
      set({
        floating: {
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: clamp(Math.round(rect.width), 360, 1600),
          height: clamp(Math.round(rect.height), 200, 1000),
        },
      });
      save();
    },

    async newTab(worktreePath) {
      const target = worktreePath ?? useWorktrees.getState().activePath;
      if (!target) {
        toast({ title: t("dock.noWorktree"), icon: "⚠" });
        return null;
      }
      const tab: DockTab = { id: nextTabId(), worktreePath: target, sessionId: null, error: null };
      set({ tabs: [...get().tabs, tab], selectedId: tab.id, open: true });
      const result = await spawnTabSession(tab);
      // A fresh id is never pending, but guard anyway; a pending spawn owns the tab.
      if (!result) return null;
      if (await closeOrphan(tab.id, result)) return null;
      if ("sessionId" in result) {
        set({ tabs: get().tabs.map((item) => (item.id === tab.id ? { ...item, sessionId: result.sessionId } : item)) });
        save();
        return tab.id;
      }
      set({ tabs: get().tabs.map((item) => (item.id === tab.id ? { ...item, error: result.error } : item)) });
      toast({ title: t("dock.spawnError", { message: result.error }), icon: "⚠" });
      save();
      return null;
    },

    async openHere(worktreePath) {
      const existing = get().tabs.find((tab) => tab.worktreePath === worktreePath);
      if (existing) {
        set({ selectedId: existing.id, open: true });
        // Retry only a failed spawn. A tab with no session and no error still has
        // its first spawn in flight; spawning again would orphan one of the PTYs.
        if (!existing.sessionId && existing.error) await get().retryTab(existing.id);
        return;
      }
      await get().newTab(worktreePath);
    },

    async retryTab(id) {
      const tab = get().tabs.find((item) => item.id === id);
      // Never respawn a live tab (that would orphan its PTY) or a tab whose
      // spawn is still in flight (the second session would overwrite the first).
      if (!tab || tab.sessionId || pendingSpawns.has(id)) return;
      set({ tabs: get().tabs.map((item) => (item.id === id ? { ...item, error: null } : item)) });
      const result = await spawnTabSession(tab);
      if (!result || (await closeOrphan(id, result))) return;
      if ("sessionId" in result) {
        set({ tabs: get().tabs.map((item) => (item.id === id ? { ...item, sessionId: result.sessionId, error: null } : item)) });
      } else {
        set({ tabs: get().tabs.map((item) => (item.id === id ? { ...item, error: result.error } : item)) });
        toast({ title: t("dock.spawnError", { message: result.error }), icon: "⚠" });
      }
      save();
    },

    select(id) {
      if (!get().tabs.some((tab) => tab.id === id) || get().selectedId === id) return;
      const splitIds = get().splitIds;
      if (splitIds && splitIds[1] === id) {
        get().swapSplit();
        return;
      }
      set({ selectedId: id });
      if (splitIds && !splitIds.includes(id)) set({ splitIds: null });
      save();
    },

    async toggleSplit() {
      const { tabs, selectedId, splitIds } = get();
      if (splitIds) {
        set({ splitIds: null });
        save();
        return;
      }
      const selected = tabs.find((tab) => tab.id === selectedId) ?? tabs[0];
      if (!selected) return;
      const other = [...tabs].reverse().find((tab) => tab.id !== selected.id && tab.sessionId);
      if (other) {
        set({ splitIds: [selected.id, other.id], selectedId: selected.id });
        save();
        return;
      }
      const created = await get().newTab(selected.worktreePath);
      if (created) {
        set({ splitIds: [selected.id, created], selectedId: selected.id });
        save();
      }
    },

    swapSplit() {
      const splitIds = get().splitIds;
      if (!splitIds) return;
      set({ splitIds: [splitIds[1], splitIds[0]], selectedId: splitIds[1] });
      save();
    },

    async closeTab(id) {
      const tab = get().tabs.find((item) => item.id === id);
      if (!tab) return;
      // Explicit owner cleanup: closing a tab closes its PTY. Hiding the dock never reaches here.
      if (tab.sessionId) {
        try {
          await closeTerminal(tab.sessionId);
        } catch (error) {
          toast({ title: errorMessage(error), icon: "⚠" });
        }
      }
      dropTab(get, set, save, id);
    },

    adoptExisting(worktreePath, sessionId) {
      const tab: DockTab = { id: nextTabId(), worktreePath, sessionId, error: null };
      set({ tabs: [...get().tabs, tab], selectedId: tab.id, open: true });
      save();
      return tab.id;
    },

    detachTab(id) {
      const tab = get().tabs.find((item) => item.id === id);
      if (!tab || !tab.sessionId) return null;
      dropTab(get, set, save, id);
      return tab;
    },

    async load() {
      if (exitSubscription === null) {
        const subscribed = onTerminalExit((event) => {
          // A cleanly exited shell needs no further inspection: close its tab
          // like other terminal emulators do. Sessions that die abnormally
          // (signal, nonzero code, PTY error) stay open with their output and
          // error state until the owner explicitly closes the tab.
          if (event.signal != null || event.exitCode !== 0) return;
          const tab = get().tabs.find((item) => item.sessionId === event.sessionId);
          if (tab) void get().closeTab(tab.id);
        });
        exitSubscription = subscribed;
        subscribed.catch(() => {
          if (exitSubscription === subscribed) exitSubscription = null;
        });
      }
      const saved = await loadSetting<PersistedDock>(DOCK_KEY);
      const mode = validMode(saved?.mode) ? saved.mode : "bottom";
      const bottomHeight = typeof saved?.bottomHeight === "number" ? clamp(saved.bottomHeight, 120, 640) : 260;
      const rightWidth = typeof saved?.rightWidth === "number" ? clamp(saved.rightWidth, 280, 880) : 400;
      const floating = saved?.floating ?? { x: 80, y: 80, width: 720, height: 420 };
      const savedTabs = Array.isArray(saved?.tabs)
        ? saved.tabs.filter((tab) => typeof tab?.id === "string" && typeof tab?.worktreePath === "string")
        : [];
      const savedSelectedId = saved?.selectedId;
      const selectedId = savedTabs.some((tab) => tab.id === savedSelectedId) ? (savedSelectedId as string) : (savedTabs[0]?.id ?? null);
      const splitIds =
        saved?.splitIds && savedTabs.some((tab) => tab.id === saved.splitIds?.[0]) && savedTabs.some((tab) => tab.id === saved.splitIds?.[1])
          ? (saved.splitIds as [string, string])
          : null;
      set({
        mode,
        bottomHeight,
        rightWidth,
        floating: {
          x: Math.max(0, floating.x || 0),
          y: Math.max(0, floating.y || 0),
          width: clamp(floating.width || 720, 360, 1600),
          height: clamp(floating.height || 420, 200, 1000),
        },
        tabs: savedTabs.map((tab) => ({ id: tab.id, worktreePath: tab.worktreePath, sessionId: null as string | null, error: null as string | null })),
        selectedId,
        splitIds,
        loaded: true,
      });
      // Restore fresh shells for still-registered worktrees. The backend rejects
      // unregistered paths; those tabs are kept with an error instead of dropped.
      for (const tab of savedTabs) {
        const stub: DockTab = { id: tab.id, worktreePath: tab.worktreePath, sessionId: null, error: null };
        const result = await spawnTabSession(stub);
        if (!result || (await closeOrphan(tab.id, result))) continue;
        if ("sessionId" in result) {
          set({ tabs: get().tabs.map((item) => (item.id === tab.id ? { ...item, sessionId: result.sessionId } : item)) });
        } else {
          set({ tabs: get().tabs.map((item) => (item.id === tab.id ? { ...item, error: result.error } : item)) });
          toast({ title: t("dock.restoreError", { path: tab.worktreePath, message: result.error }), icon: "⚠" });
        }
      }
      persistSoon(snapshot(get));
    },
  };
});

export function dockTabName(path: string): string {
  return tabName(path);
}
