import type { MsgKey } from "../i18n/en";
import type { Side } from "./stageModel";

/** Custom drag type for sidebar screen items (must be lowercase; browsers lowercase drag types). */
export const SCREEN_MIME = "application/x-branchwork-screen";

export const SIDES: { side: Side; icon: string; label: MsgKey }[] = [
  { side: "left", icon: "◧", label: "split.left" },
  { side: "right", icon: "◨", label: "split.right" },
  { side: "top", icon: "⬒", label: "split.top" },
  { side: "bottom", icon: "⬓", label: "split.bottom" },
];

export const sideLabel = (side: Side): MsgKey => SIDES.find((s) => s.side === side)!.label;
