import { useState } from "react";
import { useStage } from "../state/stage";
import { Menu } from "../ui/Menu";
import { t } from "../i18n/t";
import { splitMenuItems } from "./splitMenu";
import { MAX_PANES } from "./stageModel";
import { moveFocusedPaneToNewWindow } from "../state/windows";

export function PaneControls({ index }: { index: number }) {
  const panes = useStage((s) => s.panes);
  const { swap, toggleDir, closePane, openSplit } = useStage.getState();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const single = panes.length < 2;
  // Windows exist only in the desktop app.
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const openMenu = (el: HTMLElement) => { const r = el.getBoundingClientRect(); setMenu({ x: r.right - 320, y: r.bottom + 6 }); };
  const menuEl = menu && (
    <Menu
      x={menu.x}
      y={menu.y}
      width={310}
      onClose={() => setMenu(null)}
      items={splitMenuItems(
        panes,
        (id, side) => openSplit(id, side, index),
        // Presets rebuild the stage, so they are offered only while unsplit.
        single ? (next) => { useStage.getState().setLayout(next); setMenu(null); } : undefined,
      )}
    />
  );

  if (single) {
    return (
      <div className="pane-ctl">
        <button
          className="btn sm ghost open-beside"
          aria-label={t("split.openBeside")}
          title={`${t("split.openBeside")} (⌘\\)`}
          onClick={(e) => openMenu(e.currentTarget)}
        >
          ◨ {t("split.openBeside")}
        </button>
        {menuEl}
      </div>
    );
  }
  return (
    <div className="pane-ctl">
      {panes.length < MAX_PANES && (
        <button className="icon-btn" aria-label={t("split.openBeside")} title={`${t("split.openBeside")} (⌘\\)`} onClick={(e) => openMenu(e.currentTarget)}>◨</button>
      )}
      <button className="icon-btn" aria-label={t("split.swap")} title={t("split.swap")} onClick={() => swap(index)}>⇄</button>
      <button className="icon-btn" aria-label={t("split.orientation")} title={t("split.orientation")} onClick={() => toggleDir(index)}>⬒</button>
      {desktop && <button className="icon-btn" aria-label={t("windows.moveToNew")} title={t("windows.moveToNew")} onClick={() => void moveFocusedPaneToNewWindow(index)}>⧉</button>}
      <button className="icon-btn" aria-label={t("split.close")} title={`${t("split.close")} (⌘⌥\\)`} onClick={() => closePane(index)}>✕</button>
      {menuEl}
    </div>
  );
}
