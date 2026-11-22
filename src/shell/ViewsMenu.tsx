import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useConflictCount } from "../screens/conflicts/conflictsState";
import { SCREENS, type ScreenDef, type ScreenId } from "../screens/registry";
import { useStage } from "../state/stage";
import { useWorktrees } from "../state/worktrees";
import { Menu, type MenuItem } from "../ui/Menu";
import { SCREEN_MIME } from "../stage/dnd";
import { t } from "../i18n/t";
import { useSessions } from "../agents/sessions";
import { Icon } from "../ui/Icon";

const SCREEN_KEYS: Partial<Record<ScreenId, string>> = {
  home: "⌘1",
  changes: "⌘2",
  history: "⌘3",
  files: "⌘4",
  agents: "⌘5",
  terminal: "⌘6",
  github: "⌘7",
};

const VIEW_SECTIONS = [
  { label: "shell.viewsScreens", screens: SCREENS.filter((screen) => screen.section === "screens") },
  { label: "shell.viewsTools", screens: SCREENS.filter((screen) => screen.section === "tools") },
  { label: "shell.viewsSettings", screens: SCREENS.filter((screen) => screen.section === "footer") },
] as const;

export function ViewsMenu({ mode = "views" }: { mode?: "views" | "newTab" } = {}) {
  const panes = useStage((state) => state.panes);
  const focus = useStage((state) => state.focus);
  const dir = useStage((state) => state.dir);
  const dirtyCount = useWorktrees((state) => state.worktrees.find((worktree) => worktree.path === state.activePath)?.dirtyCount ?? 0);
  const waitingAgents = useSessions((store) => store.sessions.filter((session) => session.status === "waiting").length);
  const conflictCount = useConflictCount();
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number; id: ScreenId } | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { go, newTab, openSplit, closePane } = useStage.getState();

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (mode === "newTab") return;
      if (event.button !== 0) return;
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, mode]);

  const glyph = (id: ScreenId) => {
    const index = panes.indexOf(id);
    if (panes.length < 2 || index < 0) return null;
    const value = panes.length > 2 ? String(index + 1) : index === 0
      ? (dir === "h" ? "◧" : "⬒")
      : (dir === "h" ? "◨" : "⬓");
    return <span className="nav-split" aria-hidden>{value}</span>;
  };

  const onClick = (event: MouseEvent<HTMLButtonElement>, id: ScreenId) => {
    setOpen(false);
    triggerRef.current?.focus();
    if (mode === "newTab") {
      newTab(id);
      return;
    }
    if (event.altKey) openSplit(id, "bottom");
    else if (event.metaKey || event.ctrlKey || event.shiftKey) openSplit(id, "right");
    else go(id);
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (items.length === 0) return;
    const current = items.findIndex((item) => item === document.activeElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = (current + 1) % items.length; break;
      case "ArrowUp": next = (current - 1 + items.length) % items.length; break;
      case "Home": next = 0; break;
      case "End": next = items.length - 1; break;
      default: return;
    }
    event.preventDefault();
    items[next]?.focus();
  };

  const menuItems = (id: ScreenId): MenuItem[] => [
    { kind: "item", label: t("split.openHere"), onSelect: () => go(id) },
    { kind: "item", icon: "＋", label: t("stage.tabs.openInNew"), onSelect: () => newTab(id) },
    { kind: "item", icon: "◨", label: t("split.right"), kbd: "⌘-click", onSelect: () => openSplit(id, "right") },
    { kind: "item", icon: "◧", label: t("split.left"), onSelect: () => openSplit(id, "left") },
    { kind: "item", icon: "⬒", label: t("split.top"), onSelect: () => openSplit(id, "top") },
    { kind: "item", icon: "⬓", label: t("split.bottom"), kbd: "⌥-click", onSelect: () => openSplit(id, "bottom") },
    ...(panes.length > 1 && panes.includes(id)
      ? ([{ kind: "separator" }, { kind: "item", icon: "✕", label: t("split.closeFromSplit"), onSelect: () => closePane(panes.indexOf(id)) }] as MenuItem[])
      : []),
  ];

  const renderItem = (screen: ScreenDef) => (
    <button
      key={screen.id}
      type="button"
      role="menuitem"
      className={"nav" + (panes[focus] === screen.id ? " on" : panes.includes(screen.id) ? " on2" : "")}
      draggable
      aria-label={t(screen.label)}
      title={`${t(screen.label)} · ${t("sidebar.splitHint")}`}
      onDragStart={(event) => {
        event.dataTransfer.setData(SCREEN_MIME, screen.id);
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={(event) => onClick(event, screen.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        setOpen(false);
        setCtx({ x: event.clientX, y: event.clientY, id: screen.id });
      }}
    >
      <span className="nav-ic" aria-hidden>{screen.icon}</span>
      <span className="nav-label">{t(screen.label)}</span>
      {screen.id === "changes" && dirtyCount > 0 && (
        <span className="count" role="status" aria-label={t("sidebar.changed", { count: dirtyCount })}>{dirtyCount}</span>
      )}
      {screen.id === "agents" && waitingAgents > 0 && (
        <span className="count agent" role="status" aria-label={t("agents.waitingBadge", { count: waitingAgents })}>{waitingAgents}</span>
      )}
      {screen.id === "conflicts" && conflictCount > 0 && (
        <span className="count bad" role="status" aria-label={t("conflicts.badge", { count: conflictCount })}>{conflictCount}</span>
      )}
      {glyph(screen.id)}
      {SCREEN_KEYS[screen.id] && <span className="nav-k" aria-hidden>{SCREEN_KEYS[screen.id]}</span>}
    </button>
  );

  const openFirstItem = () => requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());

  return (
    <div className="views-control">
      <button
        ref={triggerRef}
        type="button"
        className={mode === "newTab" ? "stage-tab-new" : "views-trigger"}
        aria-label={mode === "newTab" ? t("stage.tabs.new") : t("shell.views")}
        title={mode === "newTab" ? t("stage.tabs.new") : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (mode === "newTab" && !open) {
            const rect = triggerRef.current?.getBoundingClientRect();
            if (rect) {
              const left = Math.max(8, Math.min(rect.left - 112, window.innerWidth - 260));
              setMenuPosition({ left, top: rect.bottom + 6 });
            }
          }
          setOpen(mode === "newTab" ? true : (value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          if (!open) setOpen(true);
          openFirstItem();
        }}
      >
        {mode === "newTab" ? <Icon name="grid" size={16} /> : <>{t("shell.views")} <Icon name="chevronDown" size={12} /></>}
      </button>
      {open && (mode === "newTab" ? createPortal(
        <>
          <button
            type="button"
            className="views-modal-backdrop"
            aria-label={t("dialog.cancel")}
            onClick={() => setOpen(false)}
          />
          <div
            ref={menuRef}
            className="views-menu views-menu-modal new-tab-views-menu"
            role="menu"
            aria-label={t("shell.views")}
            style={menuPosition ? { left: menuPosition.left, top: menuPosition.top, position: "fixed" } : undefined}
            onKeyDown={onMenuKeyDown}
          >
            {VIEW_SECTIONS.map((section) => (
              <div className="views-menu-section" role="group" aria-label={t(section.label)} key={section.label}>
                <div className="views-menu-heading">{t(section.label)}</div>
                {section.screens.map(renderItem)}
              </div>
            ))}
          </div>
        </>,
        document.body,
      ) : (
        <div ref={menuRef} className="views-menu" role="menu" aria-label={t("shell.views")} onKeyDown={onMenuKeyDown}>
          {VIEW_SECTIONS.map((section) => (
            <div className="views-menu-section" role="group" aria-label={t(section.label)} key={section.label}>
              <div className="views-menu-heading">{t(section.label)}</div>
              {section.screens.map(renderItem)}
            </div>
          ))}
        </div>
      ))}
      {ctx && <Menu x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} items={menuItems(ctx.id)} />}
    </div>
  );
}
