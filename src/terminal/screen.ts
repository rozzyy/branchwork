// Full-screen Terminal workspace store (spec §6.5a). Each tab owns one pane
// layout tree (see ./layout); pane leaves carry only ids, and this store maps
// each pane id to its PTY session. Sessions are never closed except by an
// explicit owner action (close pane/tab); moving panes between tabs or to the
// dock hands the live session over without killing it.
import { create } from "zustand";
import {
  closePane,
  moveFocus,
  paneIds,
  resizeGutter,
  splitPane,
  toggleMaximized,
  equalizeSplit,
  type FocusDir,
  type LayoutNode,
  type PaneNode,
  type SplitDir,
} from "./layout";
import { closeTerminal, onTerminalExit, spawnTerminal, writeTerminal } from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { errorMessage } from "../ipc/errors";
import { t } from "../i18n/t";
import { toast } from "../ui/toast";
import { ask } from "../ui/dialog";
import { useDock } from "./dock";
import { useStage } from "../state/stage";
import { useWorktrees } from "../state/worktrees";

export interface ScreenPaneState {
  id: string;
  sessionId: string | null;
  worktreePath: string;
  cwd: string;
  error: string | null;
  cols: number;
  rows: number;
}

export interface ScreenTab {
  id: string;
  name: string;
  layout: LayoutNode;
  panes: Record<string, ScreenPaneState>;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
  broadcast: boolean;
}

interface PersistedScreenPane {
  id?: unknown;
  worktreePath?: unknown;
  cwd?: unknown;
}

interface PersistedScreenTab {
  id?: unknown;
  name?: unknown;
  layout?: unknown;
  focusedPaneId?: unknown;
  maximizedPaneId?: unknown;
  broadcast?: unknown;
  panes?: unknown;
}

interface PersistedScreen {
  tabs?: unknown;
  selectedTabId?: unknown;
}

const SCREEN_KEY = "terminalScreen";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

let tabCounter = 0;
let paneCounter = 0;
function nextTabId(): string {
  tabCounter += 1;
  return `screen-tab-${Date.now().toString(36)}-${tabCounter}`;
}
function nextPaneId(): string {
  paneCounter += 1;
  return `screen-pane-${Date.now().toString(36)}-${paneCounter}`;
}
function singlePane(): PaneNode {
  return { kind: "pane", id: nextPaneId() };
}

function tabName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** Quote a path for `cd` in the user's login shell. */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

function validLayout(node: unknown): node is LayoutNode {
  if (typeof node !== "object" || node === null) return false;
  const n = node as Record<string, unknown>;
  if (n.kind === "pane") return typeof n.id === "string";
  if (n.kind !== "split") return false;
  return (
    typeof n.id === "string" &&
    (n.dir === "h" || n.dir === "v") &&
    Array.isArray(n.children) &&
    Array.isArray(n.sizes) &&
    n.children.length > 0 &&
    n.children.length === n.sizes.length &&
    (n.sizes as unknown[]).every((s) => typeof s === "number" && s > 0) &&
    (n.children as unknown[]).every(validLayout)
  );
}

function validPane(pane: unknown): pane is PersistedScreenPane {
  if (typeof pane !== "object" || pane === null) return false;
  const p = pane as Record<string, unknown>;
  return typeof p.id === "string" && typeof p.worktreePath === "string";
}

// Sessions whose process already exited. A pane with an exited session closes
// without confirmation; only still-running processes trigger ask().
const exitedSessions = new Set<string>();

// Pane ids whose spawn has not settled yet. A spawn that settles after its
// pane was removed must be closed, never attached.
const pendingSpawns = new Set<string>();

let exitSubscription: Promise<() => void> | null = null;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon(snapshot: PersistedScreen): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSetting(SCREEN_KEY, snapshot), 300);
}

interface ScreenStore {
  tabs: ScreenTab[];
  selectedTabId: string | null;
  loaded: boolean;
  newTab(worktreePath?: string, env?: Record<string, string>): Promise<string | null>;
  closeTab(id: string): Promise<void>;
  selectTab(id: string): void;
  splitFocusedPane(tabId: string, dir: SplitDir): Promise<void>;
  closeFocusedPane(tabId: string): Promise<void>;
  focusPane(tabId: string, paneId: string): void;
  moveFocus(tabId: string, dir: FocusDir): void;
  toggleMaximize(tabId: string): void;
  toggleBroadcast(tabId: string): void;
  resizePaneGutter(tabId: string, splitId: string, index: number, delta: number): void;
  equalizePaneGutter(tabId: string, splitId: string): void;
  setPaneSize(tabId: string, paneId: string, cols: number, rows: number): void;
  /** Clear a failed pane and spawn a fresh shell without closing the pane. */
  retryPane(tabId: string, paneId: string): Promise<void>;
  setPaneWorktree(tabId: string, paneId: string, path: string): Promise<void>;
  clearPane(tabId: string, paneId: string): Promise<void>;
  /** Write input to every live pane of the tab. Returns true when consumed. */
  broadcastInput(tabId: string, data: string): boolean;
  movePaneToNewTab(tabId: string, paneId: string): Promise<string | null>;
  movePaneToDock(tabId: string, paneId: string): Promise<boolean>;
  adoptDockTab(dockTabId: string): void;
  /** Open the Terminal screen on a new shell in `worktreePath`. */
  openHere(worktreePath: string): Promise<void>;
  load(): Promise<void>;
}

function snapshot(get: () => ScreenStore): PersistedScreen {
  return {
    tabs: get().tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      layout: tab.layout,
      focusedPaneId: tab.focusedPaneId,
      maximizedPaneId: tab.maximizedPaneId,
      broadcast: tab.broadcast,
      panes: Object.values(tab.panes).map((pane) => ({
        id: pane.id,
        worktreePath: pane.worktreePath,
        cwd: pane.cwd,
      })),
    })),
    selectedTabId: get().selectedTabId,
  };
}

export const useTerminalScreen = create<ScreenStore>((set, get) => {
  const save = () => persistSoon(snapshot(get));

  const tabById = (id: string): ScreenTab | undefined => get().tabs.find((tab) => tab.id === id);

  const updateTab = (id: string, patch: Partial<ScreenTab>) =>
    set({ tabs: get().tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)) });

  const spawnFor = async (
    pane: ScreenPaneState,
    env?: Record<string, string>,
  ): Promise<{ sessionId: string } | { error: string }> => {
    try {
      const session = await spawnTerminal(pane.worktreePath, DEFAULT_COLS, DEFAULT_ROWS, env);
      return { sessionId: session.sessionId };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  };

  // Start the spawn for a pane record that is already in the store. Guards
  // the close-during-spawn race: a session that settles after its pane was
  // removed is closed, never attached.
  const spawnPaneSession = async (
    tabId: string,
    pane: ScreenPaneState,
    env?: Record<string, string>,
  ): Promise<void> => {
    if (pendingSpawns.has(pane.id)) return;
    pendingSpawns.add(pane.id);
    try {
      const result = await spawnFor(pane, env);
      const tab = tabById(tabId);
      const live = tab?.panes[pane.id];
      if (!tab || !live) {
        if ("sessionId" in result) {
          try {
            await closeTerminal(result.sessionId);
          } catch {
            // The backend session is already gone; nothing left to clean up.
          }
        }
        return;
      }
      if ("sessionId" in result) {
        exitedSessions.delete(result.sessionId);
        updateTab(tabId, {
          panes: { ...tab.panes, [pane.id]: { ...live, sessionId: result.sessionId, error: null } },
        });
        if (live.cwd !== live.worktreePath) {
          try {
            await writeTerminal(result.sessionId, new TextEncoder().encode(`cd ${shellQuote(live.cwd)}\n`));
          } catch (error) {
            const refreshed = tabById(tabId);
            const current = refreshed?.panes[pane.id];
            if (refreshed && current) {
              updateTab(tabId, {
                panes: { ...refreshed.panes, [pane.id]: { ...current, error: errorMessage(error) } },
              });
            }
          }
        }
      } else {
        updateTab(tabId, {
          panes: { ...tab.panes, [pane.id]: { ...live, error: result.error } },
        });
        toast({ title: t("screen.spawnError", { message: result.error }), icon: "⚠" });
      }
      save();
    } finally {
      pendingSpawns.delete(pane.id);
    }
  };

  // Remove a pane record from its tab. When `closeSession` is set the PTY is
  // closed (explicit owner cleanup); otherwise the live session is returned so
  // the caller can hand it to a new owner. Closing the last pane closes the tab.
  const removePane = async (
    tab: ScreenTab,
    paneId: string,
    closeSession: boolean,
  ): Promise<ScreenPaneState | null> => {
    const pane = tab.panes[paneId];
    if (!pane) return null;
    if (closeSession && pane.sessionId) {
      try {
        await closeTerminal(pane.sessionId);
      } catch (error) {
        toast({ title: errorMessage(error), icon: "⚠" });
      }
    }
    if (pane.sessionId) exitedSessions.delete(pane.sessionId);
    const next = closePane(tab.layout, paneId);
    if (next === null) {
      set({ tabs: get().tabs.filter((item) => item.id !== tab.id) });
      const selected = get().selectedTabId;
      if (selected === tab.id) {
        const remaining = get().tabs;
        set({ selectedTabId: remaining[remaining.length - 1]?.id ?? null });
      }
      save();
      return pane;
    }
    const panes = { ...tab.panes };
    delete panes[paneId];
    const ids = paneIds(next);
    updateTab(tab.id, {
      layout: next,
      panes,
      focusedPaneId: tab.focusedPaneId === paneId ? (ids[0] ?? null) : tab.focusedPaneId,
      maximizedPaneId: tab.maximizedPaneId === paneId ? null : tab.maximizedPaneId,
    });
    save();
    return pane;
  };

  const runningPanes = (tab: ScreenTab): ScreenPaneState[] =>
    Object.values(tab.panes).filter((pane) => pane.sessionId && !exitedSessions.has(pane.sessionId));

  return {
    tabs: [],
    selectedTabId: null,
    loaded: false,

    async newTab(worktreePath, env) {
      const selected = get().tabs.find((tab) => tab.id === get().selectedTabId);
      const focusedWorktree =
        selected && selected.focusedPaneId ? selected.panes[selected.focusedPaneId]?.worktreePath : undefined;
      const target = worktreePath ?? focusedWorktree ?? useWorktrees.getState().activePath;
      if (!target) {
        toast({ title: t("screen.noWorktree"), icon: "⚠" });
        return null;
      }
      const layout = singlePane();
      const pane: ScreenPaneState = {
        id: layout.id,
        sessionId: null,
        worktreePath: target,
        cwd: target,
        error: null,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      };
      const tab: ScreenTab = {
        id: nextTabId(),
        name: tabName(target),
        layout,
        panes: { [pane.id]: pane },
        focusedPaneId: pane.id,
        maximizedPaneId: null,
        broadcast: false,
      };
      set({ tabs: [...get().tabs, tab], selectedTabId: tab.id });
      save();
      await spawnPaneSession(tab.id, pane, env);
      return tab.id;
    },

    async closeTab(id) {
      const tab = tabById(id);
      if (!tab) return;
      const running = runningPanes(tab);
      if (running.length > 0) {
        const confirmed = await ask({
          title: t("screen.closeTabTitle", { name: tab.name }),
          body: t("screen.closeTabBody", { count: running.length }),
          ok: t("screen.closeTabOk"),
          danger: true,
          icon: "❯_",
        });
        if (confirmed !== true) return;
      }
      for (const pane of Object.values(tab.panes)) {
        if (pane.sessionId) {
          try {
            await closeTerminal(pane.sessionId);
          } catch (error) {
            toast({ title: errorMessage(error), icon: "⚠" });
          }
          exitedSessions.delete(pane.sessionId);
        }
      }
      set({ tabs: get().tabs.filter((item) => item.id !== id) });
      if (get().selectedTabId === id) {
        const remaining = get().tabs;
        set({ selectedTabId: remaining[remaining.length - 1]?.id ?? null });
      }
      save();
    },

    selectTab(id) {
      if (get().selectedTabId !== id && tabById(id)) set({ selectedTabId: id });
    },

    async splitFocusedPane(tabId, dir) {
      const tab = tabById(tabId);
      const paneId = tab?.focusedPaneId;
      if (!tab || !paneId || !tab.panes[paneId]) return;
      const source = tab.panes[paneId];
      const layout = splitPane(tab.layout, paneId, dir);
      const created = paneIds(layout).find((id) => id !== paneId && !tab.panes[id]);
      if (!created) return;
      const pane: ScreenPaneState = {
        id: created,
        sessionId: null,
        worktreePath: source.worktreePath,
        cwd: source.cwd,
        error: null,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      };
      updateTab(tabId, { layout, panes: { ...tab.panes, [created]: pane }, focusedPaneId: created });
      save();
      await spawnPaneSession(tabId, pane);
    },

    async closeFocusedPane(tabId) {
      const tab = tabById(tabId);
      const paneId = tab?.focusedPaneId;
      if (!tab || !paneId) return;
      const pane = tab.panes[paneId];
      if (!pane) return;
      if (pane.sessionId && !exitedSessions.has(pane.sessionId)) {
        const confirmed = await ask({
          title: t("screen.closePaneTitle"),
          body: t("screen.closePaneBody"),
          ok: t("screen.closePaneOk"),
          danger: true,
          icon: "❯_",
        });
        if (confirmed !== true) return;
      }
      await removePane(tab, paneId, true);
    },

    focusPane(tabId, paneId) {
      const tab = tabById(tabId);
      if (!tab || !tab.panes[paneId] || tab.focusedPaneId === paneId) return;
      updateTab(tabId, { focusedPaneId: paneId });
      save();
    },

    moveFocus(tabId, dir) {
      const tab = tabById(tabId);
      if (!tab || !tab.focusedPaneId) return;
      const next = moveFocus(tab.layout, tab.focusedPaneId, dir);
      if (next) {
        updateTab(tabId, { focusedPaneId: next });
        save();
      }
    },

    toggleMaximize(tabId) {
      const tab = tabById(tabId);
      if (!tab || !tab.focusedPaneId) return;
      updateTab(tabId, { maximizedPaneId: toggleMaximized(tab.maximizedPaneId, tab.focusedPaneId) });
      save();
    },

    toggleBroadcast(tabId) {
      const tab = tabById(tabId);
      if (!tab) return;
      updateTab(tabId, { broadcast: !tab.broadcast });
      save();
    },

    resizePaneGutter(tabId, splitId, index, delta) {
      const tab = tabById(tabId);
      if (!tab) return;
      try {
        updateTab(tabId, { layout: resizeGutter(tab.layout, splitId, index, delta) });
        save();
      } catch {
        // Unknown split or gutter (stale drag target after a close): ignore.
      }
    },

    equalizePaneGutter(tabId, splitId) {
      const tab = tabById(tabId);
      if (!tab) return;
      try {
        updateTab(tabId, { layout: equalizeSplit(tab.layout, splitId) });
        save();
      } catch {
        // Stale gutter target after a close: ignore.
      }
    },

    setPaneSize(tabId, paneId, cols, rows) {
      const tab = tabById(tabId);
      const pane = tab?.panes[paneId];
      if (!tab || !pane || (pane.cols === cols && pane.rows === rows)) return;
      updateTab(tabId, { panes: { ...tab.panes, [paneId]: { ...pane, cols, rows } } });
    },

    async retryPane(tabId, paneId) {
      const tab = tabById(tabId);
      const pane = tab?.panes[paneId];
      // Never respawn a live pane or a pane whose spawn is still in flight.
      if (!tab || !pane || pane.sessionId || pendingSpawns.has(paneId)) return;
      const cleared = { ...pane, error: null };
      updateTab(tabId, { panes: { ...tab.panes, [paneId]: cleared } });
      save();
      await spawnPaneSession(tabId, cleared);
    },

    async setPaneWorktree(tabId, paneId, path) {
      const tab = tabById(tabId);
      const pane = tab?.panes[paneId];
      if (!tab || !pane || pane.worktreePath === path) return;
      updateTab(tabId, {
        panes: { ...tab.panes, [paneId]: { ...pane, worktreePath: path, cwd: path, error: null } },
      });
      save();
      if (pane.sessionId && !exitedSessions.has(pane.sessionId)) {
        try {
          await writeTerminal(pane.sessionId, new TextEncoder().encode(`cd ${shellQuote(path)}\n`));
        } catch (error) {
          const refreshed = tabById(tabId);
          const current = refreshed?.panes[paneId];
          if (refreshed && current) {
            updateTab(tabId, {
              panes: { ...refreshed.panes, [paneId]: { ...current, error: errorMessage(error) } },
            });
          }
          toast({ title: errorMessage(error), icon: "⚠" });
        }
      }
    },

    async clearPane(tabId, paneId) {
      const tab = tabById(tabId);
      const pane = tab?.panes[paneId];
      if (!tab || !pane?.sessionId || exitedSessions.has(pane.sessionId)) return;
      try {
        // Form feed clears the screen in most shells without backend support.
        await writeTerminal(pane.sessionId, new TextEncoder().encode("\x0c"));
      } catch (error) {
        toast({ title: errorMessage(error), icon: "⚠" });
      }
    },

    broadcastInput(tabId, data) {
      const tab = tabById(tabId);
      if (!tab) return false;
      let delivered = false;
      for (const pane of Object.values(tab.panes)) {
        if (!pane.sessionId || exitedSessions.has(pane.sessionId)) continue;
        delivered = true;
        void writeTerminal(pane.sessionId, new TextEncoder().encode(data)).catch((error) => {
          toast({ title: errorMessage(error), icon: "⚠" });
        });
      }
      return delivered;
    },

    async movePaneToNewTab(tabId, paneId) {
      const tab = tabById(tabId);
      if (!tab || !tab.panes[paneId]) return null;
      const pane = await removePane(tab, paneId, false);
      if (!pane || !pane.sessionId) return null;
      const layout = singlePane();
      const adopted: ScreenPaneState = { ...pane, id: layout.id };
      const adoptedTab: ScreenTab = {
        id: nextTabId(),
        name: tabName(adopted.worktreePath),
        layout,
        panes: { [adopted.id]: adopted },
        focusedPaneId: adopted.id,
        maximizedPaneId: null,
        broadcast: false,
      };
      set({ tabs: [...get().tabs, adoptedTab], selectedTabId: adoptedTab.id });
      save();
      return adoptedTab.id;
    },

    async movePaneToDock(tabId, paneId) {
      const tab = tabById(tabId);
      const pane = tab?.panes[paneId];
      if (!tab || !pane?.sessionId || exitedSessions.has(pane.sessionId)) {
        toast({ title: t("screen.moveNeedsSession"), icon: "⚠" });
        return false;
      }
      await removePane(tab, paneId, false);
      useDock.getState().adoptExisting(pane.worktreePath, pane.sessionId);
      return true;
    },

    adoptDockTab(dockTabId) {
      const detached = useDock.getState().detachTab(dockTabId);
      if (!detached) return;
      const layout = singlePane();
      const pane: ScreenPaneState = {
        id: layout.id,
        sessionId: detached.sessionId,
        worktreePath: detached.worktreePath,
        cwd: detached.worktreePath,
        error: null,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      };
      if (detached.sessionId) exitedSessions.delete(detached.sessionId);
      const tab: ScreenTab = {
        id: nextTabId(),
        name: tabName(detached.worktreePath),
        layout,
        panes: { [pane.id]: pane },
        focusedPaneId: pane.id,
        maximizedPaneId: null,
        broadcast: false,
      };
      set({ tabs: [...get().tabs, tab], selectedTabId: tab.id });
      save();
      useStage.getState().go("terminal");
    },

    async openHere(worktreePath) {
      await get().load();
      await get().newTab(worktreePath);
      useStage.getState().go("terminal");
    },

    async load() {
      if (exitSubscription === null) {
        const subscribed = onTerminalExit((event) => {
          // Exited sessions stay visible with their output; they only skip
          // the running-process confirmation when the owner closes the pane.
          exitedSessions.add(event.sessionId);
        });
        exitSubscription = subscribed;
        subscribed.catch(() => {
          if (exitSubscription === subscribed) exitSubscription = null;
        });
      }
      if (get().loaded) return;
      const saved = await loadSetting<PersistedScreen>(SCREEN_KEY);
      const savedTabs = Array.isArray(saved?.tabs) ? (saved.tabs as PersistedScreenTab[]) : [];
      const tabs: ScreenTab[] = [];
      for (const entry of savedTabs) {
        if (typeof entry !== "object" || entry === null) continue;
        const panes: Record<string, ScreenPaneState> = {};
        if (Array.isArray(entry.panes)) {
          for (const raw of entry.panes as unknown[]) {
            if (!validPane(raw)) continue;
            panes[raw.id as string] = {
              id: raw.id as string,
              sessionId: null,
              worktreePath: raw.worktreePath as string,
              cwd: typeof raw.cwd === "string" ? (raw.cwd as string) : (raw.worktreePath as string),
              error: null,
              cols: DEFAULT_COLS,
              rows: DEFAULT_ROWS,
            };
          }
        }
        const layout: LayoutNode = validLayout(entry.layout)
          ? (entry.layout as LayoutNode)
          : singlePane();
        // Drop saved panes that are not part of the layout tree.
        const ids = new Set(paneIds(layout));
        for (const id of Object.keys(panes)) {
          if (!ids.has(id)) delete panes[id];
        }
        // The layout always resolves to at least one pane id; ensure it has a record.
        for (const id of ids) {
          if (!panes[id]) {
            panes[id] = {
              id,
              sessionId: null,
              worktreePath: "",
              cwd: "",
              error: t("screen.restoreError", { path: "?" }),
              cols: DEFAULT_COLS,
              rows: DEFAULT_ROWS,
            };
          }
        }
        tabs.push({
          id: typeof entry.id === "string" ? entry.id : nextTabId(),
          name: typeof entry.name === "string" ? entry.name : tabName("terminal"),
          layout,
          panes,
          focusedPaneId:
            typeof entry.focusedPaneId === "string" && panes[entry.focusedPaneId]
              ? (entry.focusedPaneId as string)
              : null,
          maximizedPaneId:
            typeof entry.maximizedPaneId === "string" && panes[entry.maximizedPaneId]
              ? (entry.maximizedPaneId as string)
              : null,
          broadcast: entry.broadcast === true,
        });
        const tab = tabs[tabs.length - 1];
        if (!tab.focusedPaneId) tab.focusedPaneId = paneIds(layout)[0] ?? null;
      }
      const savedSelected = saved?.selectedTabId;
      set({
        tabs,
        selectedTabId:
          typeof savedSelected === "string" && tabs.some((tab) => tab.id === savedSelected)
            ? (savedSelected as string)
            : (tabs[tabs.length - 1]?.id ?? null),
        loaded: true,
      });
      // Restore fresh shells for every saved pane. Panes whose worktree is
      // gone keep their error instead of dropping the tab.
      for (const tab of tabs) {
        for (const pane of Object.values(tab.panes)) {
          if (!pane.worktreePath) continue;
          await spawnPaneSession(tab.id, pane);
        }
      }
      persistSoon(snapshot(get));
    },
  };
});
