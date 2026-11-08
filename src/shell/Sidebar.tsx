import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { NAV_SECTIONS, SCREENS, screenById, type ScreenDef, type ScreenId } from "../screens/registry";
import { useStage } from "../state/stage";
import { useRepos } from "../state/repos";
import { useWorktrees } from "../state/worktrees";
import { Menu, type MenuItem } from "../ui/Menu";
import { SCREEN_MIME } from "../stage/dnd";
import { t } from "../i18n/t";
import { onGitChanged, type Worktree } from "../ipc/worktrees";
import { toast } from "../ui/toast";

// Deterministic color stripe/dot per worktree path, picked from a small token palette.
// Ordered so adjacent hashes don't land on near-identical hues (--acc and --blu are both blue-ish).
const WORKTREE_COLORS = ["var(--acc)", "var(--grn)", "var(--yel)", "var(--pur)", "var(--blu)", "var(--red)"];

function worktreeColor(path: string): string {
  // djb2-ish hash: a plain polynomial hash clusters short, similar paths into the same bucket.
  let hash = 5381;
  for (let index = 0; index < path.length; index++) hash = ((hash * 33) ^ path.charCodeAt(index)) | 0;
  return WORKTREE_COLORS[Math.abs(hash) % WORKTREE_COLORS.length];
}

function pathTail(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function branchName(worktree: Worktree): string {
  return worktree.branch ?? t("sidebar.detached");
}

function statusLabel(worktree: Worktree): string {
  switch (worktree.state) {
    case "dirty":
      return t("sidebar.changed", { count: worktree.dirtyCount });
    case "conflict":
      return t("sidebar.conflict");
    case "rebasing":
      return t("sidebar.rebasing");
    default:
      return t("sidebar.clean");
  }
}

function WorktreePicker({
  anchorEl,
  projectId,
  worktrees,
  pinnedPaths,
  activePath,
  onClose,
}: {
  anchorEl: HTMLElement | null;
  projectId: string;
  worktrees: Worktree[];
  pinnedPaths: string[];
  activePath: string | null;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [position] = useState(() => {
    const rect = anchorEl?.getBoundingClientRect();
    return rect ? { left: rect.left, top: rect.bottom + 6 } : { left: 12, top: 46 };
  });
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? worktrees.filter((worktree) =>
          `${branchName(worktree)} ${worktree.path}`.toLowerCase().includes(needle),
        )
      : worktrees;
  }, [query, worktrees]);

  useEffect(() => {
    searchRef.current?.focus();
    const onMouseDown = (event: globalThis.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (pickerRef.current?.contains(target) || target.closest(".worktree-picker-trigger")) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        anchorEl?.focus();
      }
    };
    const timer = setTimeout(() => window.addEventListener("mousedown", onMouseDown));
    window.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorEl, onClose]);

  return createPortal(
    <div
      ref={pickerRef}
      className="worktree-picker"
      role="dialog"
      aria-label={t("sidebar.pickerTitle")}
      style={{ left: position.left, top: position.top }}
    >
      <div className="worktree-picker-head">{t("sidebar.pickerHeader")}</div>
      <input
        ref={searchRef}
        className="input worktree-picker-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("sidebar.pickerSearchPlaceholder")}
        aria-label={t("sidebar.pickerSearch")}
      />
      <div className="worktree-picker-list">
        {filtered.map((worktree) => {
          const branch = branchName(worktree);
          const active = activePath === worktree.path;
          const checked = active || pinnedPaths.includes(worktree.path);
          return (
            <div className="worktree-picker-row" key={worktree.path}>
              <label className="worktree-pin-check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={active}
                  aria-label={t(checked ? "sidebar.unpinCheckbox" : "sidebar.pinCheckbox", { branch })}
                  onChange={(event) =>
                    void useWorktrees.getState().setPinned(projectId, worktree.path, event.currentTarget.checked)
                  }
                />
              </label>
              <span className="worktree-dot" style={{ background: worktreeColor(worktree.path) }} aria-hidden />
              <button
                type="button"
                className="worktree-picker-select mono"
                aria-current={active ? "true" : undefined}
                aria-label={t("sidebar.selectWorktree", { branch })}
                title={worktree.path}
                onClick={() => useWorktrees.getState().select(worktree.path)}
              >
                {branch}
              </button>
              {active ? (
                <span className="worktree-picker-active">{t("sidebar.active")}</span>
              ) : (
                <span className="worktree-status-chip" data-state={worktree.state}>{statusLabel(worktree)}</span>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <div className="side-empty">{t("sidebar.noWorktreeMatches")}</div>}
      </div>
    </div>,
    document.body,
  );
}

function WorktreeSection() {
  const projects = useRepos((state) => state.projects);
  const activeProjectId = useRepos((state) => state.activeProjectId);
  const project = projects.find((item) => item.id === activeProjectId) ?? null;
  const worktrees = useWorktrees((state) => state.worktrees);
  const pinnedPaths = useWorktrees((state) => state.pinnedPaths);
  const activePath = useWorktrees((state) => state.activePath);
  const loading = useWorktrees((state) => state.loading);
  const error = useWorktrees((state) => state.error);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void useWorktrees.getState().load(project);
  }, [project?.id, project?.localPath]);

  useEffect(() => {
    if (!project || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const reportError = (error: unknown) => {
      if (disposed) return;
      toast({
        title: t("sidebar.watchError", { message: error instanceof Error ? error.message : String(error) }),
        icon: "⚠",
      });
    };
    let subscription: Promise<() => void>;
    try {
      subscription = onGitChanged((event) => {
          const state = useWorktrees.getState();
          if (state.projectId !== project.id || !state.worktrees.some((worktree) => worktree.path === event.worktree)) {
            return;
          }
          void state.load(project);
        });
    } catch (error) {
      reportError(error);
      return;
    }
    void subscription.then(
      (stop) => {
        if (disposed) void stop();
        else unlisten = stop;
      },
      reportError,
    );
    return () => {
      disposed = true;
      if (unlisten) void unlisten();
    };
  }, [project?.id, project?.localPath]);

  const visible = useMemo(() => {
    const active = worktrees.find((worktree) => worktree.path === activePath);
    return [
      ...(active ? [active] : []),
      ...worktrees.filter(
        (worktree) => worktree.path !== activePath && pinnedPaths.includes(worktree.path),
      ),
    ];
  }, [activePath, pinnedPaths, worktrees]);
  const moreCount = worktrees.length - visible.length;
  const countLabel = t("sidebar.worktreeCount", { visible: visible.length, total: worktrees.length });
  const closePicker = () => setPickerOpen(false);

  return (
    <section className="worktree-section" aria-label={t("sidebar.worktrees")}>
      <div className="side-h worktree-head" aria-label={countLabel}>
        <span className="worktree-head-title">{t("sidebar.worktrees")}</span>
        <span className="worktree-count" aria-hidden>{visible.length}/{worktrees.length}</span>
        <button
          ref={pickerButtonRef}
          type="button"
          className="icon-btn worktree-picker-trigger"
          aria-label={t("sidebar.openPicker")}
          title={t("sidebar.openPicker")}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          disabled={!project || loading || worktrees.length === 0}
          onClick={() => setPickerOpen((open) => !open)}
        >
          ☰
        </button>
      </div>
      {!project ? (
        <div className="side-empty">{t("sidebar.noRepo")}</div>
      ) : loading ? (
        <div className="side-empty">{t("sidebar.loadingWorktrees")}</div>
      ) : error ? (
        <div className="side-empty" role="status">{t("sidebar.worktreesError", { message: error })}</div>
      ) : worktrees.length === 0 ? (
        <div className="side-empty">{t("sidebar.noWorktrees")}</div>
      ) : (
        <>
          <div className="worktree-rows">
            {visible.map((worktree) => {
              const branch = branchName(worktree);
              const pinned = pinnedPaths.includes(worktree.path);
              const selected = activePath === worktree.path;
              const label = t("sidebar.worktreeRow", { branch, status: statusLabel(worktree) });
              return (
                <div className={"worktree-row" + (selected ? " selected" : "")} key={worktree.path}>
                  <button
                    type="button"
                    className="worktree-row-main"
                    aria-label={label}
                    aria-current={selected ? "true" : undefined}
                    title={`${branch} · ${statusLabel(worktree)} · ${worktree.path}`}
                    onClick={() => useWorktrees.getState().select(worktree.path)}
                  >
                    <span className="worktree-row-stripe" aria-hidden style={{ background: worktreeColor(worktree.path) }} />
                    <span className="worktree-row-detail">
                      <span className="worktree-row-label">{branch}</span>
                      <span className="worktree-row-meta">
                        {(worktree.ahead > 0 || worktree.behind > 0) && (
                          <span>{t("sidebar.aheadBehind", { ahead: worktree.ahead, behind: worktree.behind })}</span>
                        )}
                        <span>{pathTail(worktree.path)}</span>
                      </span>
                    </span>
                  </button>
                  <span className="worktree-status-chip" data-state={worktree.state} aria-hidden>{statusLabel(worktree)}</span>
                  <span className="worktree-row-actions">
                    <button
                      type="button"
                      className="worktree-terminal-placeholder"
                      aria-label={t("sidebar.terminalPlaceholder")}
                      title={t("sidebar.terminalPlaceholder")}
                      disabled
                    >
                      ❯_
                    </button>
                    {pinned && (
                      <button
                        type="button"
                        className="worktree-unpin"
                        aria-label={t("sidebar.unpin", { branch })}
                        title={t("sidebar.unpin", { branch })}
                        onClick={() => void useWorktrees.getState().setPinned(project.id, worktree.path, false)}
                      >
                        ×
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {moreCount > 0 && (
            <button
              type="button"
              className="worktree-overflow"
              aria-label={t("sidebar.moreWorktrees", { count: moreCount })}
              title={t("sidebar.moreWorktrees", { count: moreCount })}
              onClick={() => setPickerOpen(true)}
            >
              <span className="worktree-overflow-label">{t("sidebar.moreWorktrees", { count: moreCount })}</span>
            </button>
          )}
        </>
      )}
      {pickerOpen && project && (
        <WorktreePicker
          anchorEl={pickerButtonRef.current}
          projectId={project.id}
          worktrees={worktrees}
          pinnedPaths={pinnedPaths}
          activePath={activePath}
          onClose={closePicker}
        />
      )}
    </section>
  );
}

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
        {NAV_SECTIONS.map((section) => (
          <Fragment key={section.id}>
            <div className="side-h">{t(section.label)}</div>
            {SCREENS.filter((s) => s.section === section.id).map(item)}
          </Fragment>
        ))}
        <WorktreeSection />
        <div className="side-h">{t("sidebar.tools")}</div>
        {SCREENS.filter((s) => s.section === "tools").map(item)}
      </nav>
      <div className="side-foot">{item(screenById("settings"))}</div>
      {ctx && <Menu x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} items={menuItems(ctx.id)} />}
    </aside>
  );
}
