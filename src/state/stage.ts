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

interface StageStore extends M.StageState, Derived {
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
  moveFocus(dir: M.FocusDir): void;
  setLayout(panes: ScreenId[]): void;
  /**
   * Show both screens and focus `second` without discarding a split layout:
   * one pane → the two-pane preset; otherwise add missing screens as splits
   * (or, at four panes, in a pane that shows neither).
   */
  openPair(first: ScreenId, second: ScreenId): void;
  switchWorktree(path: string | null): void;
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
/** Full store slice (state + derived) for a stage; also used by tests. */
export const stageSnapshot = (s: M.StageState): M.StageState & Derived => derive(s);
/** Default screens ⌘\ offers, in order, skipping visible ones. */
const SPLIT_DEFAULTS: ScreenId[] = ["changes", "agents", "history", "files", "terminal", "home", "github"];

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let layouts: Record<string, M.StageState> = {};
let legacyDefault: M.StageState | null = null;
let activeLayoutPath: string | null = null;
let switchedOnce = false;
const saveLayout = (path: string, stage: M.StageState) => {
  delete layouts[path];
  layouts[path] = stage;
  while (Object.keys(layouts).length > 200) delete layouts[Object.keys(layouts)[0]];
};
const persist = (s: M.StageState) => {
  if (activeLayoutPath) saveLayout(activeLayoutPath, s);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSetting("stage", { version: 2, current: s, layouts }), 300);
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

export const useStage = create<StageStore>((set, get) => {
  const apply = (f: (s: M.StageState) => M.StageState) => {
    const current = pick(get());
    const next = f(current);
    if (next === current) return;
    set(derive(next, get().panes));
    persist(next);
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
    ...derive(M.initialStage),
    go: (id) => apply((s) => M.navigate(s, id)),
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
      const current = pick(get());
      if (activeLayoutPath) saveLayout(activeLayoutPath, current);
      const next = path ? layouts[path] ?? (switchedOnce ? legacyDefault ?? M.initialStage : current) : current;
      if (!switchedOnce && path) legacyDefault = current;
      switchedOnce = switchedOnce || !!path;
      activeLayoutPath = path;
      set(derive(next));
      const panes = M.panesOf(next);
      useHistory.getState().setMode(panes.includes("history") ? useHistory.getState().mode : "graph");
      if (path) saveLayout(path, next);
      persist(next);
    },
    async load() {
      const saved = await loadSetting<unknown>("stage");
      if (!saved || typeof saved !== "object") return;
      const raw = saved as Record<string, unknown>;
      if (raw.current && typeof raw.current === "object") {
        const current = readStage(raw.current) ?? { stage: M.initialStage, mode: "graph" as HistoryMode };
        layouts = {};
        if (raw.layouts && typeof raw.layouts === "object") {
          layouts = Object.fromEntries(Object.entries(raw.layouts as Record<string, unknown>).slice(0, 200).flatMap(([path, value]) => {
            const read = path ? readStage(value) : null;
            return read ? [[path, read.stage]] : [];
          }));
        }
        const stage = activeLayoutPath ? layouts[activeLayoutPath] ?? current.stage : current.stage;
        set(derive(stage));
        useHistory.getState().setMode(current.mode);
        if (activeLayoutPath && !layouts[activeLayoutPath]) saveLayout(activeLayoutPath, stage);
      } else if (Array.isArray(raw.panes)) {
        const migrated = migrateLegacy(raw);
        layouts = {};
        set(derive(migrated.stage));
        useHistory.getState().setMode(migrated.mode);
        legacyDefault = migrated.stage;
        if (activeLayoutPath) saveLayout(activeLayoutPath, migrated.stage);
      }
    },
  };
});
