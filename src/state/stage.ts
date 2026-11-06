import { create } from "zustand";
import * as M from "../stage/stageModel";
import { screenById, type ScreenId } from "../screens/registry";
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
  load(): Promise<void>;
}

const pick = (s: M.StageState): M.StageState => ({ panes: s.panes, focus: s.focus, dir: s.dir, ratio: s.ratio });

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const persist = (s: M.StageState) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSetting("stage", s), 300);
};

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
    async load() {
      const saved = await loadSetting<unknown>("stage");
      if (M.isValidStage(saved)) set(pick(saved));
    },
  };
});
