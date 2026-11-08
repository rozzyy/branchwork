import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CliPane } from "./CliPane";
import { useTerminalScreen, type ScreenPaneState, type ScreenTab } from "./screen";
import type { LayoutNode } from "./layout";
import { useWorktrees } from "../state/worktrees";
import { worktreeColor } from "../shell/Sidebar";
import { Menu, type MenuItem } from "../ui/Menu";
import { t } from "../i18n/t";
import "./terminal-screen.css";

function tail(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function TerminalToolbar() {
  return (
    <>
      <h1 className="pane-title">{t("screen.title")}</h1>
      <div className="pane-ctl">
        <button
          type="button"
          className="icon-btn"
          aria-label={t("screen.newTab")}
          title={`${t("screen.newTab")} · ⌘T`}
          onClick={() => void useTerminalScreen.getState().newTab()}
        >
          ＋
        </button>
      </div>
    </>
  );
}

function PaneBody({ tab, pane }: { tab: ScreenTab; pane: ScreenPaneState }) {
  const store = useTerminalScreen.getState();
  if (!pane.sessionId) {
    return (
      <div className="term-screen-error" role="status">
        <span>{pane.error ?? "…"}</span>
        {pane.error && (
          <>
            <button type="button" className="btn sm" onClick={() => void store.retryPane(tab.id, pane.id)}>
              {t("screen.retry")}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                store.focusPane(tab.id, pane.id);
                void store.closeFocusedPane(tab.id);
              }}
            >
              ×
            </button>
          </>
        )}
      </div>
    );
  }
  return (
    <CliPane
      key={pane.sessionId}
      sessionId={pane.sessionId}
      onResize={(cols, rows) => store.setPaneSize(tab.id, pane.id, cols, rows)}
      interceptInput={
        tab.broadcast ? (data) => useTerminalScreen.getState().broadcastInput(tab.id, data) : undefined
      }
    />
  );
}

function PaneView({ tab, pane }: { tab: ScreenTab; pane: ScreenPaneState }) {
  const store = useTerminalScreen.getState();
  const worktrees = useWorktrees((s) => s.worktrees);
  const focused = tab.focusedPaneId === pane.id;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const options = worktrees.map((w) => w.path);
  if (!options.includes(pane.worktreePath)) options.unshift(pane.worktreePath);
  return (
    <div
      className={
        "term-screen-pane" + (focused ? " focused" : "") + (tab.broadcast ? " broadcasting" : "")
      }
      data-tab-id={tab.id}
      data-pane-id={pane.id}
      onFocus={() => store.focusPane(tab.id, pane.id)}
      aria-label={t("screen.paneLabel", { name: tail(pane.worktreePath) })}
    >
      <div className="term-screen-pane-head">
        <span className="term-screen-dot" style={{ background: worktreeColor(pane.worktreePath) }} aria-hidden />
        <select
          className="term-screen-worktree"
          aria-label={t("screen.worktree")}
          title={pane.worktreePath}
          value={pane.worktreePath}
          onChange={(event) => void store.setPaneWorktree(tab.id, pane.id, event.target.value)}
        >
          {options.map((path) => (
            <option key={path} value={path}>
              {tail(path)}
            </option>
          ))}
        </select>
        <span className="term-screen-pane-title" title={pane.cwd}>
          {tail(pane.cwd)}
        </span>
        <span className="term-screen-pane-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label={t("screen.splitRight")}
            title={`${t("screen.splitRight")} · ⌘D`}
            onClick={() => {
              store.focusPane(tab.id, pane.id);
              void store.splitFocusedPane(tab.id, "h");
            }}
          >
            ⫴
          </button>
          <button
            type="button"
            className="icon-btn term-screen-split-down"
            aria-label={t("screen.splitDown")}
            title={`${t("screen.splitDown")} · ⇧⌘D`}
            onClick={() => {
              store.focusPane(tab.id, pane.id);
              void store.splitFocusedPane(tab.id, "v");
            }}
          >
            ⫴
          </button>
          <button
            type="button"
            className={"icon-btn" + (tab.maximizedPaneId === pane.id ? " on" : "")}
            aria-label={t("screen.maximize")}
            aria-pressed={tab.maximizedPaneId === pane.id ? "true" : "false"}
            title={`${t("screen.maximize")} · ⇧⌘↵`}
            onClick={() => {
              store.focusPane(tab.id, pane.id);
              store.toggleMaximize(tab.id);
            }}
          >
            ⤢
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={t("screen.closePane")}
            title={`${t("screen.closePane")} · ⌘W`}
            onClick={() => {
              store.focusPane(tab.id, pane.id);
              void store.closeFocusedPane(tab.id);
            }}
          >
            ×
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={t("screen.moreActions")}
            title={t("screen.moreActions")}
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              setMenuAt({ x: bounds.right - 240, y: bounds.bottom + 6 });
            }}
          >
            ⋯
          </button>
        </span>
      </div>
      <div className="term-screen-pane-body">
        <PaneBody tab={tab} pane={pane} />
      </div>
      {menuAt && (
        <Menu
          items={paneMenuItems(tab, pane)}
          onClose={() => setMenuAt(null)}
          x={menuAt.x}
          y={menuAt.y}
        />
      )}
    </div>
  );
}

function paneMenuItems(tab: ScreenTab, pane: ScreenPaneState): MenuItem[] {
  const store = useTerminalScreen.getState();
  const focus = () => store.focusPane(tab.id, pane.id);
  return [
    { kind: "item", label: t("screen.splitRight"), icon: "⫴", kbd: "⌘D", onSelect: () => { focus(); void store.splitFocusedPane(tab.id, "h"); } },
    { kind: "item", label: t("screen.splitDown"), icon: "⫴", kbd: "⇧⌘D", onSelect: () => { focus(); void store.splitFocusedPane(tab.id, "v"); } },
    {
      kind: "item",
      label: tab.maximizedPaneId === pane.id ? t("screen.restoreLayout") : t("screen.maximize"),
      icon: "⤢",
      kbd: "⇧⌘↵",
      onSelect: () => { focus(); store.toggleMaximize(tab.id); },
    },
    {
      kind: "item",
      label: t("screen.broadcast"),
      icon: "◉",
      kbd: "⌥⌘I",
      onSelect: () => store.toggleBroadcast(tab.id),
    },
    { kind: "item", label: t("screen.clear"), icon: "∅", onSelect: () => void store.clearPane(tab.id, pane.id) },
    { kind: "item", label: t("screen.moveToNewTab"), icon: "❐", onSelect: () => void store.movePaneToNewTab(tab.id, pane.id) },
    { kind: "item", label: t("screen.moveToDock"), icon: "▕", onSelect: () => void store.movePaneToDock(tab.id, pane.id) },
    { kind: "separator" },
    {
      kind: "item",
      label: t("screen.closePane"),
      icon: "×",
      kbd: "⌘W",
      danger: true,
      onSelect: () => { focus(); void store.closeFocusedPane(tab.id); },
    },
  ];
}

function Gutter({
  tabId,
  splitId,
  index,
  horizontal,
}: {
  tabId: string;
  splitId: string;
  index: number;
  horizontal: boolean;
}) {
  const store = useTerminalScreen.getState();
  const onDrag = (event: ReactMouseEvent) => {
    event.preventDefault();
    // The gutter lives inside one cell; measure the split container so the
    // drag delta is a fraction of the whole split, not of that one cell.
    const container = (event.currentTarget.parentElement?.parentElement ?? undefined) as
      | HTMLElement
      | undefined;
    const rect = container?.getBoundingClientRect();
    const size = horizontal ? (rect?.width ?? 0) : (rect?.height ?? 0);
    if (size <= 0) return;
    const start = horizontal ? event.clientX : event.clientY;
    const move = (ev: globalThis.MouseEvent) => {
      const delta = ((horizontal ? ev.clientX : ev.clientY) - start) / size;
      useTerminalScreen.getState().resizePaneGutter(tabId, splitId, index, delta);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return (
    <div
      className={"term-screen-gutter" + (horizontal ? "" : " vertical")}
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      tabIndex={0}
      onMouseDown={onDrag}
      onDoubleClick={() => store.equalizePaneGutter(tabId, splitId)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" && horizontal) store.resizePaneGutter(tabId, splitId, index, -0.02);
        else if (event.key === "ArrowRight" && horizontal) store.resizePaneGutter(tabId, splitId, index, 0.02);
        else if (event.key === "ArrowUp" && !horizontal) store.resizePaneGutter(tabId, splitId, index, -0.02);
        else if (event.key === "ArrowDown" && !horizontal) store.resizePaneGutter(tabId, splitId, index, 0.02);
        else return;
        event.preventDefault();
      }}
    />
  );
}

function LayoutView({ tab, node }: { tab: ScreenTab; node: LayoutNode }) {
  if (node.kind === "pane") {
    const pane = tab.panes[node.id];
    if (!pane) return null;
    return <PaneView tab={tab} pane={pane} />;
  }
  const horizontal = node.dir === "h";
  return (
    <div className={"term-screen-split" + (horizontal ? " horizontal" : "")} data-split-id={node.id}>
      {node.children.map((child, i) => (
        <div key={child.id} className="term-screen-cell" style={{ flexGrow: node.sizes[i], flexBasis: 0 }}>
          <LayoutView tab={tab} node={child} />
          {i < node.children.length - 1 && (
            <Gutter tabId={tab.id} splitId={node.id} index={i} horizontal={horizontal} />
          )}
        </div>
      ))}
    </div>
  );
}

function StatusBar({ tab }: { tab: ScreenTab }) {
  const store = useTerminalScreen.getState();
  const pane = (tab.focusedPaneId && tab.panes[tab.focusedPaneId]) ?? null;
  const ids = Object.keys(tab.panes);
  const index = pane ? ids.indexOf(pane.id) + 1 : 0;
  return (
    <div className="term-screen-status" role="status">
      {pane ? (
        <>
          <span className="term-screen-dot" style={{ background: worktreeColor(pane.worktreePath) }} aria-hidden />
          <span className="term-screen-status-item" title={pane.worktreePath}>
            {tail(pane.worktreePath)}
          </span>
          <span className="term-screen-status-item term-screen-status-dim" title={pane.cwd}>
            {pane.cwd}
          </span>
          <span className="term-screen-status-item">
            {t("screen.statusPosition", { index, total: ids.length })}
          </span>
          <span className="term-screen-status-item">
            {t("screen.statusSize", { cols: pane.cols, rows: pane.rows })}
          </span>
        </>
      ) : (
        <span className="term-screen-status-dim">{t("screen.empty")}</span>
      )}
      <button
        type="button"
        className={"term-screen-broadcast" + (tab.broadcast ? " on" : "")}
        aria-pressed={tab.broadcast ? "true" : "false"}
        title={`${t("screen.broadcast")} · ⌥⌘I`}
        onClick={() => store.toggleBroadcast(tab.id)}
      >
        {tab.broadcast ? t("screen.broadcasting", { count: ids.length }) : `◉ ${t("screen.broadcast")}`}
      </button>
    </div>
  );
}

function TabBar({ tabs, selected }: { tabs: ScreenTab[]; selected: ScreenTab | null }) {
  const store = useTerminalScreen.getState();
  return (
    <div className="term-screen-tabs" role="tablist" aria-label={t("screen.tabs")}>
      {tabs.map((tab) => {
        const count = Object.keys(tab.panes).length;
        const label = count > 1 ? `${tab.name} (${count})` : tab.name;
        return (
          <div key={tab.id} className={"term-screen-tab" + (tab.id === selected?.id ? " on" : "")} role="presentation">
            <button
              type="button"
              className="term-screen-tab-main"
              role="tab"
              aria-selected={tab.id === selected?.id}
              title={label}
              onClick={() => store.selectTab(tab.id)}
            >
              {label}
            </button>
            <button
              type="button"
              className="term-screen-tab-close"
              aria-label={t("screen.closeTab", { name: tab.name })}
              title={t("screen.closeTab", { name: tab.name })}
              onClick={() => void store.closeTab(tab.id)}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="icon-btn"
        aria-label={t("screen.newTab")}
        title={`${t("screen.newTab")} · ⌘T`}
        onClick={() => void store.newTab()}
      >
        ＋
      </button>
    </div>
  );
}

export function TerminalScreen() {
  const tabs = useTerminalScreen((s) => s.tabs);
  const selectedTabId = useTerminalScreen((s) => s.selectedTabId);
  const loaded = useTerminalScreen((s) => s.loaded);
  const selected = tabs.find((tab) => tab.id === selectedTabId) ?? null;

  useEffect(() => {
    void useTerminalScreen.getState().load();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Scope every shortcut to this screen. Events from dialogs, the palette,
      // or other panes never reach here. Inputs and selects are skipped, except
      // inside xterm itself, where ⌘-shortcuts must still split and navigate.
      if (!target?.closest?.(".term-screen")) return;
      const editable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable;
      if (editable && !target.closest(".cli-pane-screen")) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const container = target.closest("[data-tab-id]");
      const tabId = container?.getAttribute("data-tab-id") ?? useTerminalScreen.getState().selectedTabId;
      if (!tabId) return;
      const store = useTerminalScreen.getState();
      if (event.code === "KeyD" && !event.altKey) {
        event.preventDefault();
        void store.splitFocusedPane(tabId, event.shiftKey ? "v" : "h");
      } else if (event.code === "KeyT" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        void store.newTab();
      } else if (event.code === "KeyW" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        void store.closeFocusedPane(tabId);
      } else if (event.code === "Enter" && event.shiftKey && !event.altKey) {
        event.preventDefault();
        store.toggleMaximize(tabId);
      } else if (event.code === "KeyI" && event.altKey && !event.shiftKey) {
        event.preventDefault();
        store.toggleBroadcast(tabId);
      } else if (event.altKey && event.code.startsWith("Arrow")) {
        const dir =
          event.code === "ArrowLeft" ? "left" : event.code === "ArrowRight" ? "right" : event.code === "ArrowUp" ? "up" : "down";
        event.preventDefault();
        store.moveFocus(tabId, dir);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!loaded) return null;
  if (!selected) {
    return (
      <div className="term-screen term-screen-empty" role="status">
        <span>{t("screen.empty")}</span>
        <button type="button" className="btn" onClick={() => void useTerminalScreen.getState().newTab()}>
          ＋ {t("screen.newTab")}
        </button>
      </div>
    );
  }
  const maximizedPane = selected.maximizedPaneId ? selected.panes[selected.maximizedPaneId] : null;
  return (
    <div className="term-screen">
      <TabBar tabs={tabs} selected={selected} />
      <div className="term-screen-body">
        {maximizedPane ? <PaneView tab={selected} pane={maximizedPane} /> : <LayoutView tab={selected} node={selected.layout} />}
      </div>
      <StatusBar tab={selected} />
    </div>
  );
}
