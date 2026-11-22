import { memo } from "react";
import { useStage } from "../state/stage";
import { VIEWS } from "../screens/views";
import { PaneControls } from "./PaneControls";
import { PaneChromeProvider } from "./PaneHeader";
import { PaneDropzone, useDropTarget } from "./dropTarget";

const pct = (fraction: number) => `${fraction * 100}%`;

/** One stage pane; `x/y/w/h` are its box as fractions of the stage canvas. */
export const Pane = memo(function Pane({ paneId, x, y, w, h }: { paneId: string; x: number; y: number; w: number; h: number }) {
  const id = useStage((s) => s.screens[paneId]);
  const index = useStage((s) => s.panes.indexOf(s.screens[paneId]));
  const panesCount = useStage((s) => s.panes.length);
  const focused = useStage((s) => s.panes.length > 1 && s.focusId === paneId);
  const full = useStage((s) => s.panes.length >= 4);
  // Spec G1: the action cluster always shows on the only pane or the
  // focused pane in a split; otherwise it reveals on hover/focus-within.
  const active = panesCount < 2 || focused;
  const focusPane = useStage((s) => s.focusPane);
  const drop = useDropTarget();
  if (!id) return null;
  const { Toolbar, View, ownsHeader } = VIEWS[id];
  return (
    <section
      className={"pane" + (focused ? " focus" : "")}
      style={{ left: pct(x), top: pct(y), width: pct(w), height: pct(h) }}
      data-pane={index}
      data-stage-pane={paneId}
      onMouseDown={() => focusPane(index)}
    >
      {!ownsHeader && Toolbar && (
        <header className="pane-tool">
          <Toolbar />
          <PaneControls index={index} />
        </header>
      )}
      <div className="pane-view" key={id}>
        <PaneChromeProvider value={{ index, controls: <PaneControls index={index} />, active }}>
          <View />
        </PaneChromeProvider>
      </div>
      {drop?.paneId === paneId && !full && <PaneDropzone side={drop.side} />}
    </section>
  );
});
