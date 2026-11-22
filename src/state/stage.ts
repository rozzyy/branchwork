import { create } from "zustand";
import * as M from "../stage/stageModel";
import { migrateScreenId, screenById, type HistoryMode, type ScreenId } from "../screens/registry";
import { useHistory } from "./history";
import { loadSetting, saveSetting } from "../ipc/settings";
import { toast } from "../ui/toast";
import { t } from "../i18n/t";

/** Derived, read-only views kept in the store so consumers stay simple. */
interface Derived {
  /** Screens in tree order (left-to-right, top-to-bottom). */
  panes: ScreenId[];
  /** Index of the focused pane in `panes`. */
  focus: number;
  /** Orientation of the outermost split ("h" when unsplit). */
  dir: M.Dir;
}

export interface StageTab {
  id: string;
  name: string;
  stage: M.StageState;
  blank?: boolean;
}
interface StageWorkspace {
  tabs: StageTab[];
  activeTabId: string;
}

interface StageStore extends M.StageState, Derived, StageWorkspace {
  go(id: ScreenId): void;
  focusPane(index: number): void;
  /** Split pane `targetIndex` (default: focused) toward `side`, showing `id`. */
  openSplit(id: ScreenId, side: M.Side, targetIndex?: number): void;
  closePane(index: number): void;
  /** ⌘\ / ⌘⇧\: split the focused pane with the next screen not yet visible. */
  splitFocused(side: M.Side): void;
  /** ⌘⌥\: close the focused pane (never the last one). */
  closeFocused(): void;
  swap(index?: number): void;
  toggleDir(index?: number): void;
  setGutter(splitId: string, index: number, leftShare: number, minShare?: number): void;
  equalize(splitId: string): void;
  equalizeAll(): void;
  newTab(screen?: ScreenId): string | null;
  activateTab(id: string): void;
  closeTab(id: string): boolean;
  renameTab(id: string, name: string): boolean;
  moveFocus(dir: M.FocusDir): void;
  setLayout(panes: ScreenId[]): void;
  /**
   * Show both screens and focus `second` without discarding a split layout:
   * one pane → the two-pane preset; otherwise add missing screens as splits
   * (or, at four panes, in a pane that shows neither).
   */
  openPair(first: ScreenId, second: ScreenId): void;
  switchWorktree(path: string | null): void;
  showEmptyWorkspace(): void;
  load(): Promise<void>;
}

const pick = (s: M.StageState): M.StageState => ({ tree: s.tree, screens: s.screens, focusId: s.focusId });
/** `prev` keeps the same `panes` array when its contents are unchanged, so
 * subscribers (sidebar, pane controls) skip re-rendering during a resize. */
const derive = (s: M.StageState, prev?: ScreenId[]): M.StageState & Derived => {
  const panes = M.panesOf(s);
  const same = prev && prev.length === panes.length && prev.every((id, i) => id === panes[i]);
  return { ...pick(s), panes: same ? prev : panes, focus: M.focusIndex(s), dir: M.rootDir(s) };
};
/** Full active-workspace snapshot for a stage; also used to reset tests. */
export const stageSnapshot = (s: M.StageState): M.StageState & Derived & StageWorkspace => {
  const workspace = makeWorkspace(s);
  return { ...derive(s), ...workspace };
};
/** Default screens ⌘\ offers, in order, skipping visible ones. */
const SPLIT_DEFAULTS: ScreenId[] = ["changes", "agents", "history", "files", "terminal", "home", "github"];
export const MAX_STAGE_TABS = 8;
export const MAX_STAGE_TAB_NAME = 40;
const validTabName = (name: string): boolean => {
  if (name.length > MAX_STAGE_TAB_NAME * 2 || name.trim() !== name) return false;
  let count = 0;
  for (const _character of name) if (++count > MAX_STAGE_TAB_NAME) return false;
  return count > 0;
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const emptyLayouts = (): Record<string, StageWorkspace> => Object.create(null) as Record<string, StageWorkspace>;
let layouts: Record<string, StageWorkspace> = emptyLayouts();
let activeLayoutPath: string | null = null;
let legacyDefault: StageWorkspace | null = null;
let switchedOnce = false;
let tabCounter = 0;
const newTabId = () => `stage-tab-${Date.now().toString(36)}-${++tabCounter}`;
const makeWorkspace = (stage: M.StageState = M.initialStage, name?: string): StageWorkspace => {
  const id = newTabId();
  return { tabs: [{ id, name: name ?? t(screenById(stage.screens[stage.focusId]).label), stage: pick(stage) }], activeTabId: id };
};
const makeBlankWorkspace = (): StageWorkspace => {
  const id = newTabId();
  return { tabs: [{ id, name: t("stage.tabs.new"), stage: pick(M.initialStage), blank: true }], activeTabId: id };
};
const activeTab = (workspace: StageWorkspace) => workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? workspace.tabs[0];
const saveLayout = (path: string, workspace: StageWorkspace) => {
  delete layouts[path];
  layouts[path] = workspace;
  while (Object.keys(layouts).length > 200) delete layouts[Object.keys(layouts)[0]];
};
const persist = (workspace: StageWorkspace) => {
  if (activeLayoutPath) saveLayout(activeLayoutPath, workspace);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSetting("stage", { version: 4, current: workspace, layouts }), 300);
};

/** Pre-M9 saved shape `{ panes, focus, dir, ratio }` (legacy ids included). */
function migrateLegacy(raw: Record<string, unknown>): { stage: M.StageState; mode: HistoryMode } {
  const source = Array.isArray(raw.panes) ? raw.panes.slice(0, 32) : [];
  const panes: ScreenId[] = [];
  const sourceTargets: number[] = [];
  let preferredHistoryMode: HistoryMode | undefined;
  for (const value of source) {
    const migrated = migrateScreenId(typeof value === "string" ? value : "");
    const existingIndex = panes.indexOf(migrated.screen);
    const targetIndex = existingIndex >= 0 ? existingIndex : panes.length;
    if (existingIndex < 0 && panes.length < 2) panes.push(migrated.screen);
    sourceTargets.push(Math.min(targetIndex, panes.length - 1));
    if (migrated.historyMode && preferredHistoryMode === undefined) preferredHistoryMode = migrated.historyMode;
  }
  if (!panes.length) panes.push("home");
  const rawFocus = typeof raw.focus === "number" && Number.isInteger(raw.focus) ? raw.focus : 0;
  const focus = rawFocus >= 0 && rawFocus < sourceTargets.length
    ? Math.max(0, sourceTargets[rawFocus])
    : Math.min(panes.length - 1, Math.max(0, rawFocus));
  const stage = M.fromLegacy({
    panes,
    focus,
    dir: raw.dir === "v" ? "v" : "h",
    ratio: typeof raw.ratio === "number" && Number.isFinite(raw.ratio) ? raw.ratio : 0.5,
  });
  const focused = source[rawFocus];
  const mode = typeof focused === "string"
    ? migrateScreenId(focused).historyMode ?? preferredHistoryMode ?? "graph"
    : preferredHistoryMode ?? "graph";
  return { stage: M.isValidStage(stage) ? stage : M.initialStage, mode };
}

/** Any saved stage (v2 tree or legacy) → a valid stage. */
function readStage(raw: unknown): { stage: M.StageState; mode: HistoryMode } | null {
  if (!raw || typeof raw !== "object") return null;
  if (M.isValidStage(raw)) return { stage: pick(raw), mode: "graph" };
  const record = raw as Record<string, unknown>;
  return Array.isArray(record.panes) ? migrateLegacy(record) : null;
}

function readWorkspace(raw: unknown): StageWorkspace | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.tabs)) {
    if (!record.tabs.length || record.tabs.length > MAX_STAGE_TABS) return null;
    const tabs: StageTab[] = [];
    const ids = new Set<string>();
    for (const value of record.tabs) {
      if (!value || typeof value !== "object") return null;
      const tab = value as Record<string, unknown>;
      if (typeof tab.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(tab.id) || ids.has(tab.id)) return null;
      if (typeof tab.name !== "string" || !validTabName(tab.name)) return null;
      if (tab.blank !== undefined && typeof tab.blank !== "boolean") return null;
      const stage = readStage(tab.stage);
      if (!stage) return null;
      ids.add(tab.id);
      tabs.push({ id: tab.id, name: tab.name, stage: stage.stage, ...(tab.blank ? { blank: true } : {}) });
    }
    const activeTabId = typeof record.activeTabId === "string" && ids.has(record.activeTabId) ? record.activeTabId : tabs[0].id;
    return { tabs, activeTabId };
  }
  const migrated = readStage(raw);
  return migrated ? makeWorkspace(migrated.stage) : null;
}

const workspaceOf = (store: StageStore): StageWorkspace => ({ tabs: store.tabs, activeTabId: store.activeTabId });
const workspaceSnapshot = (workspace: StageWorkspace): M.StageState & Derived & StageWorkspace => {
  const selected = activeTab(workspace);
  return { ...derive(selected.stage), tabs: workspace.tabs, activeTabId: selected.id } as M.StageState & Derived & StageWorkspace;
};

export const useStage = create<StageStore>((set, get) => {
  const apply = (f: (s: M.StageState) => M.StageState, tabName?: string) => {
    const current = pick(get());
    const next = f(current);
    if (next === current) return;
    const workspace = workspaceOf(get());
    const tabs = workspace.tabs.map((tab) => tab.id === workspace.activeTabId
      ? { ...tab, stage: next, blank: false, ...(tabName ? { name: tabName } : {}) }
      : tab);
    const updated = { tabs, activeTabId: workspace.activeTabId };
    set({ ...derive(next, get().panes), ...updated });
    persist(updated);
  };
  /** Pane id at `index` (default: focused); null for out-of-range indexes. */
  const paneAt = (index?: number): string | null => (index === undefined ? get().focusId : M.leafIds(get())[index] ?? null);
  const split = (id: ScreenId, side: M.Side, targetId: string) => {
    const s = pick(get());
    if (M.paneOf(s, id)) {
      if (M.leafIds(s).length === 1) toast({ title: t("split.alreadyOpen", { screen: t(screenById(id).label) }), icon: "⊞" });
      apply((st) => M.openSplit(st, id, side, targetId));
      return;
    }
    if (!M.canSplit(s)) {
      toast({ title: t("split.max", { count: M.MAX_PANES }), icon: "⊞" });
      return;
    }
    apply((st) => M.openSplit(st, id, side, targetId));
  };
  return {
    ...workspaceSnapshot(makeWorkspace()),
    go: (id) => apply((s) => M.navigate(s, id), t(screenById(id).label)),
    focusPane: (i) => { const id = paneAt(i); if (id) apply((s) => M.setFocus(s, id)); },
    openSplit: (id, side, targetIndex) => split(id, side, paneAt(targetIndex) ?? get().focusId),
    closePane: (i) => { const id = paneAt(i); if (id) apply((s) => M.closePane(s, id)); },
    splitFocused: (side) => {
      const next = SPLIT_DEFAULTS.find((id) => !get().panes.includes(id));
      if (next) split(next, side, get().focusId);
    },
    closeFocused: () => apply((s) => M.closePane(s, s.focusId)),
    swap: (i) => { const id = paneAt(i); if (id) apply((s) => M.swap(s, id)); },
    toggleDir: (i) => { const id = paneAt(i); if (id) apply((s) => M.toggleDir(s, id)); },
    equalizeAll: () => apply(M.equalizeAll),
    newTab: (screen?) => {
      const workspace = workspaceOf(get());
      if (workspace.tabs.length >= MAX_STAGE_TABS) {
        toast({ title: t("stage.tabs.max", { count: MAX_STAGE_TABS }), icon: "＋" });
        return null;
      }
      const id = newTabId();
      const stage = screen ? M.navigate(M.initialStage, screen) : M.initialStage;
      const tab = { id, name: screen ? t(screenById(screen).label) : t("stage.tabs.new"), stage, ...(!screen ? { blank: true } : {}) };
      const next = { tabs: [...workspace.tabs, tab], activeTabId: id };
      set(workspaceSnapshot(next));
      persist(next);
      return id;
    },
    activateTab: (id) => {
      const workspace = workspaceOf(get());
      if (id === workspace.activeTabId || !workspace.tabs.some((tab) => tab.id === id)) return;
      const next = { ...workspace, activeTabId: id };
      set(workspaceSnapshot(next));
      persist(next);
    },
    closeTab: (id) => {
      const workspace = workspaceOf(get());
      const index = workspace.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return false;
      if (workspace.tabs.length <= 1) {
        const next = makeBlankWorkspace();
        set(workspaceSnapshot(next));
        persist(next);
        return true;
      }
      const tabs = workspace.tabs.filter((tab) => tab.id !== id);
      const activeTabId = workspace.activeTabId === id ? tabs[Math.max(0, index - 1)].id : workspace.activeTabId;
      const next = { tabs, activeTabId };
      set(workspaceSnapshot(next));
      persist(next);
      return true;
    },
    renameTab: (id, name) => {
      if (name.length > MAX_STAGE_TAB_NAME * 2) return false;
      const normalized = name.trim();
      if (!validTabName(normalized)) return false;
      const workspace = workspaceOf(get());
      if (!workspace.tabs.some((tab) => tab.id === id)) return false;
      const tabs = workspace.tabs.map((tab) => tab.id === id ? { ...tab, name: normalized } : tab);
      const next = { ...workspace, tabs };
      set({ tabs });
      persist(next);
      return true;
    },
    setGutter: (splitId, index, leftShare, minShare) => apply((s) => M.setGutter(s, splitId, index, leftShare, minShare)),
    equalize: (splitId) => apply((s) => M.equalize(s, splitId)),
    moveFocus: (dir) => apply((s) => M.moveFocus(s, dir)),
    setLayout: (panes) => {
      if (panes.length < 1 || panes.length > M.MAX_PANES || new Set(panes).size !== panes.length) return;
      apply(() => M.layoutOf(panes));
    },
    openPair: (first, second) => {
      if (get().panes.length === 1) {
        get().setLayout([first, second]);
        return;
      }
      for (const id of [first, second]) {
        apply((s) => {
          if (M.paneOf(s, id)) return s;
          if (M.canSplit(s)) return M.openSplit(s, id, "right");
          const spare = [s.focusId, ...M.leafIds(s)].find((paneId) => s.screens[paneId] !== first && s.screens[paneId] !== second);
          return spare ? M.navigate(M.setFocus(s, spare), id) : s;
        });
      }
      apply((s) => { const target = M.paneOf(s, second); return target ? M.setFocus(s, target) : s; });
    },
    switchWorktree: (path) => {
      if (path === activeLayoutPath) return;
      const current = workspaceOf(get());
      if (activeLayoutPath) saveLayout(activeLayoutPath, current);
      const next = path
        ? layouts[path] ?? (switchedOnce ? legacyDefault ?? makeWorkspace() : current)
        : current;
      if (!switchedOnce && path) legacyDefault = current;
      switchedOnce = switchedOnce || !!path;
      activeLayoutPath = path;
      set(workspaceSnapshot(next));
      const panes = M.panesOf(activeTab(next).stage);
      useHistory.getState().setMode(panes.includes("history") ? useHistory.getState().mode : "graph");
      if (path) saveLayout(path, next);
      persist(next);
    },
    showEmptyWorkspace: () => {
      const current = workspaceOf(get());
      if (activeLayoutPath) saveLayout(activeLayoutPath, current);
      const next = makeBlankWorkspace();
      set(workspaceSnapshot(next));
      persist(next);
    },
    async load() {
      const saved = await loadSetting<unknown>("stage");
      if (!saved || typeof saved !== "object") return;
      const raw = saved as Record<string, unknown>;
      if (raw.current && typeof raw.current === "object") {
        const migratedCurrent = readStage(raw.current);
        const current = readWorkspace(raw.current) ?? makeWorkspace();
        layouts = emptyLayouts();
        if (raw.layouts && typeof raw.layouts === "object") {
          layouts = emptyLayouts();
          let count = 0;
          const sourceLayouts = raw.layouts as Record<string, unknown>;
          for (const path in sourceLayouts) {
            if (!Object.prototype.hasOwnProperty.call(sourceLayouts, path)) continue;
            if (count++ >= 200) break;
            const value = sourceLayouts[path];
            const read = path ? readWorkspace(value) : null;
            if (read) layouts[path] = read;
          }
        }
        const workspace = activeLayoutPath ? layouts[activeLayoutPath] ?? current : current;
        set(workspaceSnapshot(workspace));
        const activeStage = activeTab(workspace).stage;
        useHistory.getState().setMode(M.panesOf(activeStage).includes("history") ? migratedCurrent?.mode ?? useHistory.getState().mode : "graph");
        if (activeLayoutPath && !layouts[activeLayoutPath]) saveLayout(activeLayoutPath, workspace);
      } else if (Array.isArray(raw.panes)) {
        const migrated = migrateLegacy(raw);
        layouts = emptyLayouts();
        const workspace = makeWorkspace(migrated.stage);
        set(workspaceSnapshot(workspace));
        useHistory.getState().setMode(migrated.mode);
        if (activeLayoutPath) saveLayout(activeLayoutPath, workspace);
      }
    },
  };
});
