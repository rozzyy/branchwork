import { create } from "zustand";
import * as M from "../stage/stageModel";
import { migrateScreenId, screenById, type HistoryMode, type ScreenId } from "../screens/registry";
import { useHistory } from "./history";
import { loadSetting, saveSetting } from "../ipc/settings";
import { toast } from "../ui/toast";
import { t } from "../i18n/t";

interface StageStore extends M.StageState {
  go(id: ScreenId): void;
  focusPane(i: number): void;
  openSplit(id: ScreenId, side: M.Side): void;
  closePane(i: number): void;
  /** ⌘\ behavior: close the focused pane if split (undoing the split), otherwise open a split on `side`. */
  toggleSplit(side: M.Side): void;
  swap(): void;
  toggleDir(): void;
  setRatio(r: number): void;
  setLayout(panes: ScreenId[]): void;
  switchWorktree(path: string | null): void;
  load(): Promise<void>;
}

const pick = (s: M.StageState): M.StageState => ({ panes: s.panes, focus: s.focus, dir: s.dir, ratio: s.ratio });

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
  saveTimer = setTimeout(() => void saveSetting("stage", { current: s, layouts }), 300);
};

function migrateState(raw: Record<string, unknown>): { stage: M.StageState; mode: HistoryMode } {
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
  const stage: M.StageState = {
    panes, focus,
    dir: raw.dir === "v" ? "v" : "h",
    ratio: typeof raw.ratio === "number" && Number.isFinite(raw.ratio) ? Math.min(0.8, Math.max(0.2, raw.ratio)) : 0.5,
  };
  const focused = source[rawFocus];
  return { stage: M.isValidStage(stage) ? stage : M.initialStage, mode: typeof focused === "string" ? migrateScreenId(focused).historyMode ?? preferredHistoryMode ?? "graph" : preferredHistoryMode ?? "graph" };
}

export const useStage = create<StageStore>((set, get) => {
  const apply = (f: (s: M.StageState) => M.StageState) => {
    const next = f(pick(get()));
    set(next);
    persist(next);
  };
  return {
    ...M.initialStage,
    go: (id) => apply((s) => M.navigate(s, id)),
    focusPane: (i) => {
      if (get().focus !== i) apply((s) => M.setFocus(s, i));
    },
    openSplit: (id, side) => {
      const s = get();
      if (s.panes.length === 1 && s.panes[0] === id) {
        toast({ title: t("split.alreadyOpen", { screen: t(screenById(id).label) }), icon: "⊞" });
        return;
      }
      apply((st) => M.openSplit(st, id, side));
    },
    closePane: (i) => apply((s) => M.closePane(s, i)),
    toggleSplit: (side) => {
      const s = get();
      if (s.panes.length > 1) apply((st) => M.closePane(st, st.focus));
      else get().openSplit(s.panes[0] === "changes" ? "agents" : "changes", side);
    },
    swap: () => apply(M.swap),
    toggleDir: () => apply(M.toggleDir),
    setRatio: (r) => apply((s) => M.setRatio(s, r)),
    setLayout: (panes) => {
      if (panes.length < 1 || panes.length > 2 || new Set(panes).size !== panes.length) return;
      apply((s) => ({ ...s, panes, focus: panes.length - 1, dir: "h", ratio: 0.5 }));
    },
    switchWorktree: (path) => {
      if (path === activeLayoutPath) return;
      const current = pick(get());
      if (activeLayoutPath) saveLayout(activeLayoutPath, current);
      const next = path ? layouts[path] ?? (switchedOnce ? legacyDefault ?? M.initialStage : current) : current;
      if (!switchedOnce && path) legacyDefault = current;
      switchedOnce = switchedOnce || !!path;
      activeLayoutPath = path;
      set(pick(next));
      useHistory.getState().setMode(next.panes.includes("history") ? useHistory.getState().mode : "graph");
      if (path) saveLayout(path, next);
      persist(next);
    },
    async load() {
      const saved = await loadSetting<unknown>("stage");
      if (!saved || typeof saved !== "object") return;
      const raw = saved as Record<string, unknown>;
      if (raw.current && typeof raw.current === "object") {
        const current = migrateState(raw.current as Record<string, unknown>);
        layouts = {};
        if (raw.layouts && typeof raw.layouts === "object") {
          layouts = Object.fromEntries(Object.entries(raw.layouts as Record<string, unknown>).slice(0, 200).flatMap(([path, value]) => {
            if (!path || typeof value !== "object" || !value) return [];
            const migrated = migrateState(value as Record<string, unknown>);
            return M.isValidStage(migrated.stage) ? [[path, migrated.stage]] : [];
          }));
        }
        const stage = activeLayoutPath ? layouts[activeLayoutPath] ?? current.stage : current.stage;
        set(pick(stage));
        useHistory.getState().setMode(current.mode);
        if (activeLayoutPath && !layouts[activeLayoutPath]) saveLayout(activeLayoutPath, stage);
      } else if (Array.isArray(raw.panes)) {
        const migrated = migrateState(raw);
        layouts = {};
        set(pick(migrated.stage));
        useHistory.getState().setMode(migrated.mode);
        legacyDefault = migrated.stage;
        if (activeLayoutPath) saveLayout(activeLayoutPath, migrated.stage);
      }
    },
  };
});
