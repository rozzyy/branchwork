import type { ScreenId } from "../screens/registry";
import { SCREEN_IDS } from "../screens/registry";

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

export function openSplit(s: StageState, id: ScreenId, side: Side): StageState {
  const dir: Dir = side === "top" || side === "bottom" ? "v" : "h";
  const first = side === "left" || side === "top";
  if (s.panes.length === 1) {
    if (s.panes[0] === id) return s;
    const panes = first ? [id, s.panes[0]] : [s.panes[0], id];
    return { ...s, panes, dir, focus: panes.indexOf(id) };
  }
  const k = first ? 0 : 1;
  let panes = [...s.panes];
  if (panes[1 - k] === id) panes = [panes[1], panes[0]];
  else panes[k] = id;
  return { ...s, panes, dir, focus: panes.indexOf(id) };
}

export function closePane(s: StageState, i: number): StageState {
  if (s.panes.length < 2) return s;
  return { ...s, panes: s.panes.filter((_, k) => k !== i), focus: 0 };
}

export function swap(s: StageState): StageState {
  if (s.panes.length < 2) return s;
  return { ...s, panes: [s.panes[1], s.panes[0]], focus: 1 - s.focus };
}

export function toggleDir(s: StageState): StageState {
  return { ...s, dir: s.dir === "h" ? "v" : "h" };
}

export function setRatio(s: StageState, r: number): StageState {
  return { ...s, ratio: Math.min(0.8, Math.max(0.2, r)) };
}

/** x, y are pointer coordinates normalized to 0..1 within the stage. */
export function nearestSide(x: number, y: number): Side {
  const d: Record<Side, number> = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  return (Object.keys(d) as Side[]).reduce((a, b) => (d[a] <= d[b] ? a : b));
}

export function isValidStage(v: unknown): v is StageState {
  if (!v || typeof v !== "object") return false;
  const s = v as StageState;
  return (
    Array.isArray(s.panes) && s.panes.length >= 1 && s.panes.length <= 2 &&
    s.panes.every((p) => SCREEN_IDS.includes(p)) && new Set(s.panes).size === s.panes.length &&
    Number.isInteger(s.focus) && s.focus >= 0 && s.focus < s.panes.length &&
    (s.dir === "h" || s.dir === "v") && typeof s.ratio === "number"
  );
}
