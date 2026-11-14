import { memo } from "react";
import { useStage } from "../state/stage";
import { VIEWS } from "../screens/views";
import { PaneControls } from "./PaneControls";
import { PaneDropzone, useDropTarget } from "./dropTarget";

const pct = (fraction: number) => `${fraction * 100}%`;

/** One stage pane; `x/y/w/h` are its box as fractions of the stage canvas. */
export const Pane = memo(function Pane({ paneId, x, y, w, h }: { paneId: string; x: number; y: number; w: number; h: number }) {
  const id = useStage((s) => s.screens[paneId]);
  const index = useStage((s) => s.panes.indexOf(s.screens[paneId]));
  const focused = useStage((s) => s.panes.length > 1 && s.focusId === paneId);
  const full = useStage((s) => s.panes.length >= 4);
  const focusPane = useStage((s) => s.focusPane);
  const drop = useDropTarget();
  if (!id) return null;
  const { Toolbar, View } = VIEWS[id];
  return (
    <section
      className={"pane" + (focused ? " focus" : "")}
      style={{ left: pct(x), top: pct(y), width: pct(w), height: pct(h) }}
      data-pane={index}
      data-stage-pane={paneId}
      onMouseDown={() => focusPane(index)}
    >
      <header className="pane-tool">
        <Toolbar />
        <PaneControls index={index} />
      </header>
      <div className="pane-view" key={id}>
        <View />
      </div>
      {drop?.paneId === paneId && !full && <PaneDropzone side={drop.side} />}
    </section>
  );
});
