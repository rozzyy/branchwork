import { useState, type MouseEvent } from "react";
import { SCREENS, screenById, type ScreenDef, type ScreenId } from "../screens/registry";
import { useStage } from "../state/stage";
import { Menu, type MenuItem } from "../ui/Menu";
import { SCREEN_MIME } from "../stage/dnd";
import { t } from "../i18n/t";

export function Sidebar() {
  const panes = useStage((s) => s.panes);
  const focus = useStage((s) => s.focus);
  const dir = useStage((s) => s.dir);
  const [ctx, setCtx] = useState<{ x: number; y: number; id: ScreenId } | null>(null);
  const { go, openSplit, closePane } = useStage.getState();

  const glyph = (id: ScreenId) => {
    const i = panes.indexOf(id);
    if (panes.length < 2 || i < 0) return null;
    const g = i === 0 ? (dir === "h" ? "◧" : "⬒") : dir === "h" ? "◨" : "⬓";
    return <span className="nav-split" aria-hidden>{g}</span>;
  };

  const onClick = (e: MouseEvent, id: ScreenId) => {
    if (e.altKey) openSplit(id, "bottom");
    else if (e.metaKey || e.ctrlKey || e.shiftKey) openSplit(id, "right");
    else go(id);
  };

  const menuItems = (id: ScreenId): MenuItem[] => [
    { kind: "item", label: t("split.openHere"), onSelect: () => go(id) },
    { kind: "item", icon: "◨", label: t("split.right"), kbd: "⌘-click", onSelect: () => openSplit(id, "right") },
    { kind: "item", icon: "◧", label: t("split.left"), onSelect: () => openSplit(id, "left") },
    { kind: "item", icon: "⬒", label: t("split.top"), onSelect: () => openSplit(id, "top") },
    { kind: "item", icon: "⬓", label: t("split.bottom"), kbd: "⌥-click", onSelect: () => openSplit(id, "bottom") },
    ...(panes.length > 1 && panes.includes(id)
      ? ([{ kind: "separator" }, { kind: "item", icon: "✕", label: t("split.closeFromSplit"), onSelect: () => closePane(panes.indexOf(id)) }] as MenuItem[])
      : []),
  ];

  const item = (s: ScreenDef) => (
    <button
      key={s.id}
      className={"nav" + (panes[focus] === s.id ? " on" : panes.includes(s.id) ? " on2" : "")}
      draggable
      aria-label={t(s.label)}
      title={`${t(s.label)} · ${t("sidebar.splitHint")}`}
      onDragStart={(e) => { e.dataTransfer.setData(SCREEN_MIME, s.id); e.dataTransfer.effectAllowed = "copy"; }}
      onClick={(e) => onClick(e, s.id)}
      onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, id: s.id }); }}
    >
      <span className="nav-ic" aria-hidden>{s.icon}</span>
      <span className="nav-label">{t(s.label)}</span>
      {glyph(s.id)}
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
      {ctx && <Menu x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} items={menuItems(ctx.id)} />}
    </aside>
  );
}
