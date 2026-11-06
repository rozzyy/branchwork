import { useStage } from "../state/stage";
import { VIEWS } from "../screens/views";
import { PaneControls } from "./PaneControls";

export function Pane({ index }: { index: number }) {
  const id = useStage((s) => s.panes[index]);
  const focused = useStage((s) => s.panes.length > 1 && s.focus === index);
  const focusPane = useStage((s) => s.focusPane);
  const { Toolbar, View } = VIEWS[id];
  return (
    <section className={"pane" + (focused ? " focus" : "")} data-pane={index} onMouseDown={() => focusPane(index)}>
      <header className="pane-tool">
        <Toolbar />
        <PaneControls index={index} />
      </header>
      <div className="pane-view" key={id}>
        <View />
      </div>
    </section>
  );
}
