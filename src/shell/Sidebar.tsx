import { SCREENS, screenById, type ScreenDef } from "../screens/registry";
import { useStage } from "../state/stage";
import { t } from "../i18n/t";

export function Sidebar() {
  const panes = useStage((s) => s.panes);
  const focus = useStage((s) => s.focus);
  const go = useStage((s) => s.go);
  const item = (s: ScreenDef) => (
    <button
      key={s.id}
      className={"nav" + (panes[focus] === s.id ? " on" : panes.includes(s.id) ? " on2" : "")}
      onClick={() => go(s.id)}
    >
      <span className="nav-ic" aria-hidden>{s.icon}</span>
      <span className="nav-label">{t(s.label)}</span>
    </button>
  );
  return (
    <aside className="sidebar">
      <nav className="side-scroll">
        {SCREENS.filter((s) => s.section === "nav").map(item)}
        <div className="side-h">{t("sidebar.worktrees")}</div>
        <div className="side-empty">{t("sidebar.noRepo")}</div>
        <div className="side-h">{t("sidebar.tools")}</div>
        {SCREENS.filter((s) => s.section === "tools").map(item)}
      </nav>
      <div className="side-foot">{item(screenById("settings"))}</div>
    </aside>
  );
}
