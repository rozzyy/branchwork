import type { ScreenId } from "../screens/registry";

export type Side = "left" | "right" | "top" | "bottom";
export type Dir = "h" | "v";

export interface StageState {
  panes: ScreenId[]; // 1 or 2 entries, never the same screen twice
  focus: number;
  dir: Dir;
  ratio: number; // size of pane 0, 0.2–0.8
}

export const initialStage: StageState = { panes: ["launchpad"], focus: 0, dir: "h", ratio: 0.5 };

export function navigate(s: StageState, id: ScreenId): StageState {
  const j = s.panes.indexOf(id);
  if (j >= 0) return { ...s, focus: j };
  const panes = [...s.panes];
  panes[s.focus] = id;
  return { ...s, panes };
}

export function setFocus(s: StageState, i: number): StageState {
  return i >= 0 && i < s.panes.length ? { ...s, focus: i } : s;
}
