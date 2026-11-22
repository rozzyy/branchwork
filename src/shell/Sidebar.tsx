import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStage } from "../state/stage";
import { useRepos } from "../state/repos";
import { useWorktrees } from "../state/worktrees";
import { t } from "../i18n/t";
import { createWorktree, onGitChanged, removeWorktree, type Worktree } from "../ipc/worktrees";
import { ask } from "../ui/dialog";
import { errorMessage } from "../ipc/errors";
import type { Project } from "../ipc/catalog";
import { useDock } from "../terminal/dock";
import { toast } from "../ui/toast";
import { GroupInlineList } from "./GroupSwitcher";
import { StatusLabel } from "../ui/StatusLabel";
import { Icon } from "../ui/Icon";

// Deterministic color stripe/dot per worktree path, picked from a small token palette.
// Ordered so adjacent hashes don't land on near-identical hues (--acc and --blu are both blue-ish).
const WORKTREE_COLORS = ["var(--acc)", "var(--grn)", "var(--yel)", "var(--pur)", "var(--blu)", "var(--red)"];

/** Shared with the terminal dock so tabs carry the same worktree color as the sidebar. */
export function worktreeColor(path: string): string {
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

function WorktreeStatus({ worktree }: { worktree: Worktree }) {
  const tone = worktree.state === "conflict" ? "bad" : worktree.state === "dirty" ? "warn" : worktree.state === "rebasing" ? "info" : "ok";
  const icon = worktree.state === "conflict" ? "⚠" : worktree.state === "dirty" ? "●" : worktree.state === "rebasing" ? "↻" : "✓";
  return <StatusLabel tone={tone} icon={icon}>{statusLabel(worktree)}</StatusLabel>;
}

function WorktreePicker({
  anchorEl,
  project,
  worktrees,
  pinnedPaths,
  activePath,
  onClose,
}: {
  anchorEl: HTMLElement | null;
  project: Project;
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

  const handleNew = async () => {
    const answer = await ask({
      title: t("sidebar.createWorktreeTitle"),
      input: "",
      placeholder: t("sidebar.createWorktreePlaceholder"),
      icon: "⌂",
    });
    if (typeof answer !== "string") return;
    const branch = answer.trim();
    if (!branch) return;
    const parent = project.localPath.slice(0, project.localPath.lastIndexOf("/")) || "/";
    const destination = `${parent}/${branch.replaceAll("/", "-")}`;
    try {
      const created = await createWorktree(project.id, destination, branch);
      await useWorktrees.getState().load(project);
      useWorktrees.getState().select(created.path);
      onClose();
      toast({ title: t("sidebar.worktreeCreated", { branch }), icon: "✓" });
    } catch (error) {
      toast({ title: errorMessage(error), icon: "⚠" });
    }
  };

  const handleRemove = async (worktree: Worktree) => {
    const branch = branchName(worktree);
    const confirmed = await ask({
      title: t("sidebar.removeWorktreeTitle", { branch }),
      body: t("sidebar.removeWorktreeBody"),
      danger: true,
      ok: t("sidebar.removeWorktreeOk"),
      icon: "⚠",
    });
    if (confirmed !== true) return;
    try {
      await removeWorktree(project.id, worktree.path);
      await useWorktrees.getState().load(project);
      toast({ title: t("sidebar.worktreeRemoved", { branch }), icon: "✓" });
    } catch (error) {
      toast({ title: errorMessage(error), icon: "⚠" });
    }
  };

  useEffect(() => {
    searchRef.current?.focus();
    const onMouseDown = (event: globalThis.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (pickerRef.current?.contains(target) || target.closest(".worktree-picker-trigger") || target.closest(".worktree-overflow")) return;
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
                    void useWorktrees.getState().setPinned(project.id, worktree.path, event.currentTarget.checked)
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
                onClick={() => {
                  useRepos.getState().selectProject(project.id);
                  void useWorktrees.getState().load(project).then(() => {
                    useWorktrees.getState().select(worktree.path);
                    useStage.getState().showEmptyWorkspace();
                  });
                }}
              >
                {branch}
              </button>
              {active ? (
                <span className="worktree-picker-active">{t("sidebar.active")}</span>
              ) : (
                <>
                  <span className="worktree-status-chip" data-state={worktree.state}><WorktreeStatus worktree={worktree} /></span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t("sidebar.removeWorktree", { branch })}
                    title={t("sidebar.removeWorktree", { branch })}
                    onClick={() => void handleRemove(worktree)}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <div className="side-empty">{t("sidebar.noWorktreeMatches")}</div>}
      </div>
      <div className="worktree-picker-foot">
        <button className="btn sm" onClick={() => void handleNew()}>＋ {t("sidebar.newWorktree")}</button>
      </div>
    </div>,
    document.body,
  );
}

function WorktreeSection({ project }: { project: Project }) {
  const activeProjectId = useRepos((state) => state.activeProjectId);
  const liveWorktrees = useWorktrees((state) => state.worktrees);
  const livePinnedPaths = useWorktrees((state) => state.pinnedPaths);
  const liveActivePath = useWorktrees((state) => state.activePath);
  const liveLoading = useWorktrees((state) => state.loading);
  const liveError = useWorktrees((state) => state.error);
  const cached = useWorktrees((state) => state.byProject[project.id]);
  const isActive = activeProjectId === project.id;
  const worktrees = isActive ? liveWorktrees : (cached?.worktrees ?? []);
  const pinnedPaths = isActive ? livePinnedPaths : [];
  const activePath = isActive ? liveActivePath : (cached?.activePath ?? null);
  const loading = isActive ? liveLoading : !cached;
  const error = isActive ? liveError : null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isActive) void useWorktrees.getState().load(project);
    else void useWorktrees.getState().ensureProjectWorktrees(project);
  }, [project.id, project.localPath, isActive]);

  useEffect(() => {
    if (!project || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let reloadTimer: number | undefined;
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
          if (state.projectId !== project.id || !state.worktrees.some((worktree) => worktree.path === event.worktree)) return;
          if (reloadTimer !== undefined) window.clearTimeout(reloadTimer);
          reloadTimer = window.setTimeout(() => {
            reloadTimer = undefined;
            const current = useWorktrees.getState();
            if (current.projectId === project.id) void current.load(project);
          }, 400);
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
      if (reloadTimer !== undefined) window.clearTimeout(reloadTimer);
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
  const closePicker = () => setPickerOpen(false);
  const activateWorktree = (worktree: Worktree) => {
    if (!isActive) {
      useRepos.getState().selectProject(project.id);
      void useWorktrees.getState().load(project).then(() => {
        useWorktrees.getState().select(worktree.path);
        useStage.getState().showEmptyWorkspace();
      });
    } else {
      useWorktrees.getState().select(worktree.path);
      useStage.getState().showEmptyWorkspace();
    }
  };

  return (
    <section className="worktree-section" aria-label={t("sidebar.worktrees")}>
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
                    onClick={() => activateWorktree(worktree)}
                  >
                    <span className="worktree-row-icon" aria-hidden>
                      <Icon name="branch" size={15} />
                    </span>
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
                  {worktree.state === "conflict" ? <button className="worktree-status-chip wt-conflict-action" data-state={worktree.state} aria-label={t("operation.resolve") + ` · ${branch}`} onClick={(event) => { event.stopPropagation(); if (!isActive) { useRepos.getState().selectProject(project.id); void useWorktrees.getState().load(project).then(() => useWorktrees.getState().select(worktree.path)); } else { useWorktrees.getState().select(worktree.path); } useStage.getState().go("conflicts"); }}><WorktreeStatus worktree={worktree} /></button> : <span className="worktree-status-chip" data-state={worktree.state}><WorktreeStatus worktree={worktree} /></span>}
                  <span className="worktree-row-actions">
                    <button
                      type="button"
                      className="worktree-terminal-placeholder"
                      aria-label={t("sidebar.terminalPlaceholder")}
                      title={t("sidebar.terminalPlaceholder")}
                      onClick={() => void useDock.getState().openHere(worktree.path)}
                    >
                      <Icon name="terminal" size={14} />
                    </button>
                    {pinned && (
                      <button
                        type="button"
                        className="worktree-unpin"
                        aria-label={t("sidebar.unpin", { branch })}
                        title={t("sidebar.unpin", { branch })}
                        onClick={() => void useWorktrees.getState().setPinned(project.id, worktree.path, false)}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {moreCount > 0 && (
            <button
              ref={overflowButtonRef}
              type="button"
              className="worktree-overflow"
              aria-label={t("sidebar.moreWorktrees", { count: moreCount })}
              title={t("sidebar.moreWorktrees", { count: moreCount })}
              onClick={() => setPickerOpen(true)}
            >
              <span className="worktree-overflow-label">{t("sidebar.moreWorktrees", { count: moreCount })}</span>
            </button>
          )}
          {moreCount === 0 && (
            <div className="worktree-picker-footer">
              <button
                ref={pickerButtonRef}
                type="button"
                className="worktree-picker-trigger"
                aria-label={t("sidebar.openPicker")}
                title={t("sidebar.openPicker")}
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
                disabled={!project || loading || worktrees.length === 0}
                onClick={() => setPickerOpen((open) => !open)}
              >
                <span aria-hidden><Icon name="more" size={15} /></span>
                <span>{t("sidebar.openPicker")}</span>
              </button>
            </div>
          )}
        </>
      )}
      {pickerOpen && project && (
        <WorktreePicker
          anchorEl={pickerButtonRef.current ?? overflowButtonRef.current}
          project={project}
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
  return (
    <aside className="sidebar">
      <div className="side-scroll">
        <div className="side-brand">
          <span className="app-mark" aria-hidden />
          <span className="app-name">{t("app.name")}</span>
        </div>
        <GroupInlineList renderProjectContent={(project) => <WorktreeSection project={project} />} />
      </div>
      <div className="sidebar-settings">
        <button
          type="button"
          className="sidebar-settings-button"
          aria-label={t("nav.settings")}
          title={t("nav.settings")}
          onClick={() => useStage.getState().go("settings")}
        >
          <span aria-hidden><Icon name="settings" size={16} /></span>
          <span>{t("nav.settings")}</span>
        </button>
      </div>
    </aside>
  );
}
