import { useRef, type MouseEvent as ReactMouseEvent } from "react";
import { CliPane } from "./CliPane";
import { dockTabName, useDock, type DockTab } from "./dock";
import { worktreeColor } from "../shell/Sidebar";
import { useTerminalScreen } from "./screen";
import { t } from "../i18n/t";

function TabPane({ tab }: { tab: DockTab }) {
  const retry = useDock((s) => s.retryTab);
  const close = useDock((s) => s.closeTab);
  if (tab.sessionId) return <CliPane key={tab.sessionId} sessionId={tab.sessionId} />;
  return (
    <div className="cli-pane">
      <div className="cli-pane-screen dock-pending" role="status">
        {tab.error ?? "…"}
      </div>
      {tab.error && (
        <div className="cli-pane-message cli-pane-error">
          <button type="button" className="btn sm" onClick={() => void retry(tab.id)}>
            {t("dock.retry")}
          </button>
          <button type="button" className="btn sm" onClick={() => void close(tab.id)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

export function TerminalDock() {
  const open = useDock((s) => s.open);
  const mode = useDock((s) => s.mode);
  const tabs = useDock((s) => s.tabs);
  const selectedId = useDock((s) => s.selectedId);
  const splitIds = useDock((s) => s.splitIds);
  const bottomHeight = useDock((s) => s.bottomHeight);
  const rightWidth = useDock((s) => s.rightWidth);
  const floating = useDock((s) => s.floating);
  const headerRef = useRef<HTMLDivElement>(null);

  if (!open) return null;

  const selected = tabs.find((tab) => tab.id === selectedId) ?? tabs[0] ?? null;
  const split: DockTab[] = [];
  if (splitIds) {
    for (const id of splitIds) {
      const tab = tabs.find((item) => item.id === id);
      if (tab) split.push(tab);
    }
  } else if (selected) {
    split.push(selected);
  }

  const onBottomResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = useDock.getState().bottomHeight;
    const move = (ev: globalThis.MouseEvent) => useDock.getState().setBottomHeight(startHeight + (startY - ev.clientY));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onRightResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = useDock.getState().rightWidth;
    const move = (ev: globalThis.MouseEvent) => useDock.getState().setRightWidth(startWidth + (startX - ev.clientX));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onFloatMove = (event: ReactMouseEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = useDock.getState().floating;
    const move = (ev: globalThis.MouseEvent) =>
      useDock.getState().setFloating({ ...start, x: start.x + (ev.clientX - startX), y: start.y + (ev.clientY - startY) });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onFloatResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = useDock.getState().floating;
    const move = (ev: globalThis.MouseEvent) =>
      useDock.getState().setFloating({
        ...start,
        width: start.width + (ev.clientX - startX),
        height: start.height + (ev.clientY - startY),
      });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const store = useDock.getState();
  const style =
    mode === "bottom"
      ? ({ "--dock-h": `${bottomHeight}px` } as const)
      : mode === "right"
        ? ({ "--dock-w": `${rightWidth}px` } as const)
        : mode === "floating"
          ? ({ left: floating.x, top: floating.y, width: floating.width, height: floating.height } as const)
          : undefined;

  return (
    <section
      className={`term-dock term-dock-${mode}`}
      style={style}
      aria-label={t("dock.title")}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Escape inside the terminal screen belongs to the shell (vim, helix,
        // readline); only the dock chrome dismisses the dock.
        if ((event.target as HTMLElement | null)?.closest?.(".cli-pane-screen")) return;
        store.setOpen(false);
      }}
    >
      {mode === "bottom" && (
        <div
          className="term-dock-grip"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("dock.resize")}
          aria-valuenow={bottomHeight}
          tabIndex={0}
          onMouseDown={onBottomResize}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") store.setBottomHeight(bottomHeight + 10);
            else if (event.key === "ArrowDown") store.setBottomHeight(bottomHeight - 10);
          }}
        />
      )}
      {mode === "right" && (
        <div
          className="term-dock-grip term-dock-grip-v"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("dock.resize")}
          aria-valuenow={rightWidth}
          tabIndex={0}
          onMouseDown={onRightResize}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") store.setRightWidth(rightWidth + 10);
            else if (event.key === "ArrowRight") store.setRightWidth(rightWidth - 10);
          }}
        />
      )}
      <div ref={headerRef} className="term-dock-head" onMouseDown={mode === "floating" ? onFloatMove : undefined}>
        {tabs.length > 0 ? (
          <div className="term-dock-tabs" role="tablist" aria-label={t("dock.tabs")}>
            {tabs.map((tab) => (
              <div key={tab.id} className={"term-dock-tab" + (tab.id === selected?.id ? " on" : "")} role="presentation">
                <span className="term-dock-dot" style={{ background: worktreeColor(tab.worktreePath) }} aria-hidden />
                <button
                  type="button"
                  className="term-dock-tab-main"
                  role="tab"
                  aria-selected={tab.id === selected?.id}
                  aria-label={t("dock.tabLabel", { name: dockTabName(tab.worktreePath) })}
                  title={tab.worktreePath}
                  onClick={() => store.select(tab.id)}
                >
                  {dockTabName(tab.worktreePath)}
                </button>
                <button
                  type="button"
                  className="term-dock-tab-move"
                  aria-label={t("dock.moveToScreen", { name: dockTabName(tab.worktreePath) })}
                  title={t("dock.moveToScreen", { name: dockTabName(tab.worktreePath) })}
                  onClick={() => useTerminalScreen.getState().adoptDockTab(tab.id)}
                >
                  ⤴
                </button>
                <button
                  type="button"
                  className="term-dock-tab-close"
                  aria-label={t("dock.closeTab", { name: dockTabName(tab.worktreePath) })}
                  title={t("dock.closeTab", { name: dockTabName(tab.worktreePath) })}
                  onClick={() => void store.closeTab(tab.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <span className="term-dock-empty-hint">{t("dock.empty")}</span>
        )}
        <button type="button" className="icon-btn term-dock-newtab" aria-label={t("dock.newTab")} title={t("dock.newTab")} onClick={() => void store.newTab()}>
          ＋
        </button>
        <div className="term-dock-actions">
          {tabs.length > 0 && (
            <button
              type="button"
              className={"icon-btn" + (splitIds ? " on" : "")}
              aria-label={splitIds ? t("dock.unsplit") : t("dock.split")}
              aria-pressed={splitIds ? "true" : "false"}
              title={splitIds ? t("dock.unsplit") : t("dock.split")}
              onClick={() => void store.toggleSplit()}
            >
              ⫴
            </button>
          )}
          {splitIds && (
            <button type="button" className="icon-btn" aria-label={t("dock.swap")} title={t("dock.swap")} onClick={() => store.swapSplit()}>
              ⇄
            </button>
          )}
          <div className="term-dock-modes" role="group" aria-label={t("dock.mode")}>
            {(
              [
                ["bottom", "dock.modeBottom", "▁"],
                ["right", "dock.modeRight", "▕"],
                ["floating", "dock.modeFloating", "❐"],
                ["maximized", "dock.modeMaximized", "⤢"],
              ] as const
            ).map(([value, label, glyph]) => (
              <button
                key={value}
                type="button"
                className={"icon-btn" + (mode === value ? " on" : "")}
                aria-label={t(label)}
                aria-pressed={mode === value ? "true" : "false"}
                title={t(label)}
                onClick={() => store.setMode(value)}
              >
                {glyph}
              </button>
            ))}
          </div>
          <button type="button" className="icon-btn" aria-label={t("dock.hide")} title={`${t("dock.hide")} · ⌃\``} onClick={() => store.setOpen(false)}>
            ✕
          </button>
        </div>
      </div>
      <div className={"term-dock-body" + (split.length > 1 ? " term-dock-split" : "")}>
        {split.length === 0 ? (
          <div className="term-dock-empty" role="status">
            {t("dock.empty")}
          </div>
        ) : (
          split.map((tab) => (
            <div key={tab.id} className="term-dock-pane">
              <TabPane tab={tab} />
            </div>
          ))
        )}
      </div>
      {mode === "floating" && (
        <div
          className="term-dock-corner"
          role="separator"
          aria-label={t("dock.resize")}
          tabIndex={0}
          onMouseDown={onFloatResize}
          onKeyDown={(event) => {
            const rect = useDock.getState().floating;
            if (event.key === "ArrowRight") store.setFloating({ ...rect, width: rect.width + 10 });
            else if (event.key === "ArrowLeft") store.setFloating({ ...rect, width: rect.width - 10 });
            else if (event.key === "ArrowDown") store.setFloating({ ...rect, height: rect.height + 10 });
            else if (event.key === "ArrowUp") store.setFloating({ ...rect, height: rect.height - 10 });
          }}
        />
      )}
    </section>
  );
}
