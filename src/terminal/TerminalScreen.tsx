import {
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { CliPane } from "./CliPane";
import { useTerminalScreen, type ScreenPaneState, type ScreenTab } from "./screen";
import { usePanePin, usePaneProject } from "../stage/paneProject";
import { PaneHeader } from "../stage/PaneHeader";
import type { LayoutNode } from "./layout";
import { useWorktrees } from "../state/worktrees";
import { useRepos } from "../state/repos";
import { worktreeColor } from "../shell/Sidebar";
import { Menu, type MenuItem } from "../ui/Menu";
import { ScreenLoader } from "../ui/ScreenLoader";
import { t } from "../i18n/t";
import "./terminal-screen.css";

/** Hover delay before a corner label expands (spec G3); focus expands it
 * immediately (see `PaneCornerLabel`). */
const CORNER_HOVER_DELAY_MS = 150;

function tail(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** Pane id -> its 1-based position among the tab's panes ("pane i/n"), plus
 * the total. Built once per tab render (O(panes)) and threaded down through
 * `LayoutView`/`PaneView` so each leaf's `PaneCornerLabel` does an O(1)
 * lookup instead of an `Object.keys(...).indexOf(...)` scan per leaf
 * (O(panes) per leaf, O(panes²) for the whole tab). */
type PaneOrder = ReadonlyMap<string, number>;

function paneOrderOf(tab: ScreenTab): PaneOrder {
  return new Map(Object.keys(tab.panes).map((id, i) => [id, i + 1]));
}

/** New-tab worktree for this pane: the pinned project's worktree, or undefined for default behavior. */
function usePaneNewTabPath(): string | undefined {
  const paneProject = usePaneProject();
  const pin = usePanePin();
  const globalProjectId = useRepos((s) => s.activeProjectId);
  const cached = useWorktrees((s) => (paneProject ? s.byProject[paneProject.id] : undefined));
  if (!paneProject || pin === null || pin !== paneProject.id || paneProject.id === globalProjectId) return undefined;
  return cached?.activePath ?? paneProject.localPath;
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

/**
 * Split-part corner label (spec G3, option B): idle shows the worktree dot
 * and folder tail over the terminal content; it expands in place on hover
 * (150ms delay) or focus-within (immediately) to the worktree select and
 * the split controls that used to be a full header row per part. Collapses
 * on mouse leave, Escape, or losing focus entirely. The whole label stays
 * one element (not swapped for a separate trigger), so focusing it to
 * expand never moves focus elsewhere in the DOM.
 *
 * Reuses the same store calls as the former `.term-screen-pane-head`
 * (`focusPane` then `splitFocusedPane`/`toggleMaximize`/`closeFocusedPane`,
 * and `setPaneWorktree`), so accessible names, shortcuts and handlers are
 * unchanged — only their placement moved.
 */
function PaneCornerLabel({
  tab,
  pane,
  index,
  total,
  worktreeOptions,
}: {
  tab: ScreenTab;
  pane: ScreenPaneState;
  index: number;
  total: number;
  worktreeOptions: string[];
}) {
  const store = useTerminalScreen.getState();
  const [expanded, setExpanded] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const scheduleExpand = () => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setExpanded(true), CORNER_HOVER_DELAY_MS);
  };
  const collapse = () => {
    window.clearTimeout(hoverTimer.current);
    // I1: moving the pointer from ⋯ into the portaled `Menu` (or a click
    // moving focus there) fires this label's mouseleave/blur before the
    // menu item's click lands. Collapsing here used to unmount `Menu` via
    // `setMenuAt(null)` mid-click, so the item's `onSelect` never ran. Stay
    // expanded while the menu is open; `Menu` closes itself (outside
    // click/Escape/item select) via its own `onClose` below.
    if (menuAt) return;
    setExpanded(false);
  };
  const onBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) collapse();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      collapse();
      if (event.target instanceof HTMLElement) event.target.blur();
    }
  };
  const focus = () => store.focusPane(tab.id, pane.id);

  return (
    <div
      className={"term-screen-corner" + (expanded ? " expanded" : "")}
      tabIndex={0}
      title={`${pane.cwd} · ${pane.worktreePath}`}
      aria-label={t("screen.paneLabel", { name: tail(pane.worktreePath) })}
      onMouseEnter={scheduleExpand}
      onMouseLeave={collapse}
      onFocus={() => setExpanded(true)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <span className="term-screen-dot" style={{ background: worktreeColor(pane.worktreePath) }} aria-hidden />
      {expanded ? (
        <>
          <select
            className="term-screen-worktree"
            aria-label={t("screen.worktree")}
            title={pane.worktreePath}
            value={pane.worktreePath}
            onChange={(event) => void store.setPaneWorktree(tab.id, pane.id, event.target.value)}
          >
            {worktreeOptions.map((path) => (
              <option key={path} value={path}>
                {tail(path)}
              </option>
            ))}
          </select>
          <span className="term-screen-corner-meta">
            {t("screen.statusPosition", { index, total })} · {t("screen.statusSize", { cols: pane.cols, rows: pane.rows })}
          </span>
          <span className="term-screen-corner-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label={t("screen.splitRight")}
              title={`${t("screen.splitRight")} · ⌘D`}
              onClick={() => {
                focus();
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
                focus();
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
                focus();
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
                focus();
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
        </>
      ) : (
        <span className="term-screen-corner-text">{tail(pane.cwd)}</span>
      )}
      {menuAt && (
        <Menu items={paneMenuItems(tab, pane)} onClose={() => setMenuAt(null)} x={menuAt.x} y={menuAt.y} />
      )}
    </div>
  );
}

function PaneView({
  tab,
  pane,
  paneOrder,
}: {
  tab: ScreenTab;
  pane: ScreenPaneState;
  paneOrder: PaneOrder;
}) {
  const store = useTerminalScreen.getState();
  const worktrees = useWorktrees((s) => s.worktrees);
  const focused = tab.focusedPaneId === pane.id;
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
      <PaneCornerLabel
        tab={tab}
        pane={pane}
        index={paneOrder.get(pane.id) ?? 1}
        total={paneOrder.size}
        worktreeOptions={options}
      />
      <div className="term-screen-pane-body">
        <PaneBody tab={tab} pane={pane} />
      </div>
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

function LayoutView({ tab, node, paneOrder }: { tab: ScreenTab; node: LayoutNode; paneOrder: PaneOrder }) {
  if (node.kind === "pane") {
    const pane = tab.panes[node.id];
    if (!pane) return null;
    return <PaneView tab={tab} pane={pane} paneOrder={paneOrder} />;
  }
  const horizontal = node.dir === "h";
  return (
    <div className={"term-screen-split" + (horizontal ? " horizontal" : "")} data-split-id={node.id}>
      {node.children.map((child, i) => (
        <div key={child.id} className="term-screen-cell" style={{ flexGrow: node.sizes[i], flexBasis: 0 }}>
          <LayoutView tab={tab} node={child} paneOrder={paneOrder} />
          {i < node.children.length - 1 && (
            <Gutter tabId={tab.id} splitId={node.id} index={i} horizontal={horizontal} />
          )}
        </div>
      ))}
    </div>
  );
}

function TabBar({ tabs, selected }: { tabs: ScreenTab[]; selected: ScreenTab | null }) {
  const store = useTerminalScreen.getState();
  const newTabPath = usePaneNewTabPath();
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
        onClick={() => void store.newTab(newTabPath)}
      >
        ＋
      </button>
    </div>
  );
}

/**
 * Terminal's pane header (spec G1/G3): identity is the tab strip (content,
 * always visible); the status element is the Broadcasting chip, shown only
 * while the selected tab's broadcast is on; the action cluster is the
 * Broadcast toggle, then `PaneControls` from context (no ⋯ — nothing to
 * put in it yet, so it is omitted rather than rendered empty). With no
 * tabs, `selected` is null: the tab strip still renders its ＋ button and
 * the toggle is disabled (nothing to broadcast to).
 */
function TerminalPaneHeader({ tabs, selected }: { tabs: ScreenTab[]; selected: ScreenTab | null }) {
  const store = useTerminalScreen.getState();
  return (
    <PaneHeader
      heading={t("nav.terminal")}
      identity={<TabBar tabs={tabs} selected={selected} />}
      status={
        selected?.broadcast ? (
          <span className="term-screen-broadcast-chip">
            {t("screen.broadcasting", { count: Object.keys(selected.panes).length })}
          </span>
        ) : undefined
      }
      actions={
        <button
          type="button"
          className={"icon-btn term-screen-broadcast-toggle" + (selected?.broadcast ? " on" : "")}
          aria-label={t("screen.broadcast")}
          aria-pressed={selected?.broadcast ? "true" : "false"}
          title={`${t("screen.broadcast")} · ⌥⌘I`}
          disabled={!selected}
          onClick={() => selected && store.toggleBroadcast(selected.id)}
        >
          ◉
        </button>
      }
    />
  );
}

export function TerminalScreen() {
  const tabs = useTerminalScreen((s) => s.tabs);
  const selectedTabId = useTerminalScreen((s) => s.selectedTabId);
  const loaded = useTerminalScreen((s) => s.loaded);
  const globalProject = useRepos((s) => s.projects.find((project) => project.id === s.activeProjectId) ?? null);
  const globalProjectId = useRepos((s) => s.activeProjectId);
  const rawPin = usePanePin();
  const paneProject = usePaneProject();
  // An explicit pin to another project scopes this screen to it; otherwise
  // the screen follows the global project exactly as before.
  const pinned = rawPin !== null && paneProject !== null && rawPin === paneProject.id && paneProject.id !== globalProjectId;
  const project = pinned && paneProject ? paneProject : globalProject;
  const projectId = project?.id ?? null;
  const worktreesProjectId = useWorktrees((s) => s.projectId);
  const worktrees = useWorktrees((s) => s.worktrees);
  const cached = useWorktrees((s) => (pinned && paneProject ? s.byProject[paneProject.id] : undefined));
  useEffect(() => {
    if (pinned && paneProject && paneProject.id !== worktreesProjectId && !cached) {
      void useWorktrees.getState().ensureProjectWorktrees(paneProject);
    }
  }, [pinned, paneProject, worktreesProjectId, cached]);
  const newTabPath = usePaneNewTabPath();
  const projectPaths = new Set([
    ...(project ? [project.localPath] : []),
    ...(projectId !== null && worktreesProjectId === projectId
      ? worktrees.map((worktree) => worktree.path)
      : (cached?.worktrees.map((worktree) => worktree.path) ?? [])),
  ]);
  // Hide mixed-project tabs as a whole so hidden panes cannot receive broadcast input.
  const visibleTabs = tabs.filter((tab) =>
    Object.values(tab.panes).every((pane) => projectPaths.has(pane.worktreePath)),
  );
  const selected =
    visibleTabs.find((tab) => tab.id === selectedTabId) ?? visibleTabs[visibleTabs.length - 1] ?? null;

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
        void store.newTab(newTabPath);
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
  }, [newTabPath]);

  if (!loaded) {
    return (
      <div className="term-screen">
        <TerminalPaneHeader tabs={[]} selected={null} />
        <ScreenLoader>{t("screen.loading")}</ScreenLoader>
      </div>
    );
  }
  return (
    <div className="term-screen">
      <TerminalPaneHeader tabs={visibleTabs} selected={selected} />
      {!selected ? (
        <div className="term-screen-empty" role="status">
          <span>{t("screen.empty")}</span>
          <button type="button" className="btn" onClick={() => void useTerminalScreen.getState().newTab(newTabPath)}>
            ＋ {t("screen.newTab")}
          </button>
        </div>
      ) : (
        <div className="term-screen-body">
          {tabs.map((tab) => {
            // Every tab stays mounted but hidden (the Agents pattern): switching
            // tabs never detaches the PTY or discards the rendered buffer, so the
            // view is intact when the tab is shown again.
            const hidden = tab.id !== selected?.id;
            const maximizedPane = tab.maximizedPaneId ? tab.panes[tab.maximizedPaneId] : null;
            // Built once per tab per render (O(panes)), not once per leaf.
            const paneOrder = paneOrderOf(tab);
            return (
              <div key={tab.id} className="term-screen-tabpage" hidden={hidden}>
                {maximizedPane ? (
                  <PaneView tab={tab} pane={maximizedPane} paneOrder={paneOrder} />
                ) : (
                  <LayoutView tab={tab} node={tab.layout} paneOrder={paneOrder} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
