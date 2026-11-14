import { useState } from "react";
import { useStage } from "../state/stage";
import { Menu } from "../ui/Menu";
import { t } from "../i18n/t";
import { splitMenuItems } from "./splitMenu";

export function PaneControls({ index }: { index: number }) {
  const panes = useStage((s) => s.panes);
  const dir = useStage((s) => s.dir);
  const { swap, toggleDir, closePane, openSplit } = useStage.getState();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  if (panes.length < 2) {
    return (
      <div className="pane-ctl">
        <button
          className="open-beside"
          aria-label={t("split.openBeside")}
          title={`${t("split.openBeside")} (⌘\\)`}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 320, y: r.bottom + 6 }); }}
        >
          ◨ {t("split.openBeside")}
        </button>
        {menu && <Menu x={menu.x} y={menu.y} width={310} onClose={() => setMenu(null)} items={splitMenuItems(panes, openSplit, (next) => { useStage.getState().setLayout(next); setMenu(null); })} />}
      </div>
    );
  }
  return (
    <div className="pane-ctl">
      {index === 0 && (
        <>
          <button className="icon-btn" aria-label={t("split.swap")} title={t("split.swap")} onClick={swap}>⇄</button>
          <button className="icon-btn" aria-label={t("split.orientation")} title={t("split.orientation")} onClick={toggleDir}>{dir === "h" ? "⬒" : "◫"}</button>
        </>
      )}
      <button className="icon-btn" aria-label={t("split.close")} title={t("split.close")} onClick={() => closePane(index)}>✕</button>
    </div>
  );
}
