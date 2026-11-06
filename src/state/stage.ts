import { create } from "zustand";
import { initialStage, navigate, setFocus, type StageState } from "../stage/stageModel";
import type { ScreenId } from "../screens/registry";

interface StageStore extends StageState {
  go(id: ScreenId): void;
  focusPane(i: number): void;
}

const pick = (s: StageState): StageState => ({ panes: s.panes, focus: s.focus, dir: s.dir, ratio: s.ratio });

export const useStage = create<StageStore>((set, get) => ({
  ...initialStage,
  go: (id) => set(navigate(pick(get()), id)),
  focusPane: (i) => set(setFocus(pick(get()), i)),
}));
