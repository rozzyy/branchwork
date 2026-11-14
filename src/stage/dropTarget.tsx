import { createContext, useContext } from "react";
import type { Side } from "./stageModel";
import { sideLabel } from "./dnd";
import { t } from "../i18n/t";

export interface DropTarget {
  paneId: string;
  side: Side;
}

/** The pane currently under a sidebar drag, for its dropzone overlay. */
export const DropContext = createContext<DropTarget | null>(null);
export const useDropTarget = () => useContext(DropContext);

/** Dropzone overlay for one pane (rendered by `Pane` when it is the target). */
export function PaneDropzone({ side }: { side: Side }) {
  return (
    <div className="dropzone" data-side={side}>
      <div className="dz-hl">{t(sideLabel(side))}</div>
      <span className="dz-hint">{t("split.dropHint")}</span>
    </div>
  );
}
