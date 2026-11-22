import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useStage } from "../state/stage";
import { Pane } from "./Pane";
import { MIN_SHARE, layoutRects, nearestSide, type Gutter } from "./stageModel";
import { SCREEN_MIME } from "./dnd";
import { DropContext, type DropTarget } from "./dropTarget";
import type { ScreenId } from "../screens/registry";
import { t } from "../i18n/t";
import { OperationBanner } from "../shell/OperationBanner";
import { useWorktrees } from "../state/worktrees";
import { StageTabs } from "./StageTabs";
import { useRepos } from "../state/repos";
import { createWorktree } from "../ipc/worktrees";
import { toast } from "../ui/toast";
import { ViewsMenu } from "../shell/ViewsMenu";
import { Icon } from "../ui/Icon";
import { pickFolder, type Project } from "../ipc/catalog";

/** A divider drag never shrinks a pane below this many pixels. */
const MIN_PANE_PX = 200;
const pct = (fraction: number) => `${fraction * 100}%`;

function Divider({ gutter, canvas }: { gutter: Gutter; canvas: RefObject<HTMLDivElement | null> }) {
  const { split, index, box, at } = gutter;
  const horizontal = split.dir === "h";
  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = canvas.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // The split's own box in pixels, from its fractional box in the canvas.
    const start = horizontal ? rect.left + rect.width * box.x : rect.top + rect.height * box.y;
    const length = horizontal ? rect.width * box.w : rect.height * box.h;
    const before = split.sizes.slice(0, index).reduce((a, b) => a + b, 0);
    const minShare = Math.max(MIN_SHARE, length > 0 ? MIN_PANE_PX / length : MIN_SHARE);
    const stage = el.closest(".stage");
    stage?.classList.add("resizing");
    const move = (ev: globalThis.MouseEvent) => {
      const along = ((horizontal ? ev.clientX : ev.clientY) - start) / length;
      useStage.getState().setGutter(split.id, index, along - before, minShare);
    };
    const up = () => {
      stage?.classList.remove("resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const style = horizontal
    ? { left: pct(at), top: pct(box.y), height: pct(box.h) }
    : { top: pct(at), left: pct(box.x), width: pct(box.w) };
  return (
    <div
      className={"divider divider-" + split.dir}
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      title={t("split.resizeHint")}
      style={style}
      onMouseDown={onMouseDown}
      onDoubleClick={() => useStage.getState().equalize(split.id)}
    />
  );
}

function WorkspaceActionModal({
  kind,
  project,
  onClose,
}: {
  kind: "project" | "worktree";
  project: Project | null;
  onClose(): void;
}) {
  const [mode, setMode] = useState<"open" | "clone">("open");
  const [folder, setFolder] = useState("");
  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const browse = async () => {
    try {
      const path = await pickFolder(kind === "project" ? t("groups.openTitle") : t("groups.browseTitle"));
      if (path) setFolder(path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (kind === "project") {
        if (mode === "open") {
          if (!folder) throw new Error(t("workspace.chooseRepository"));
          await useRepos.getState().openRepo(folder);
        } else {
          if (!url.trim()) throw new Error(t("workspace.enterRepositoryUrl"));
          if (!destination.trim()) throw new Error(t("workspace.chooseCloneDestination"));
          await useRepos.getState().cloneRepo(url.trim(), destination.trim());
        }
      } else {
        if (!project) throw new Error(t("workspace.noProjectForWorktree"));
        if (!branch.trim()) throw new Error(t("workspace.enterBranchName"));
        const parent = project.localPath.slice(0, project.localPath.lastIndexOf("/")) || "/";
        const worktreePath = destination.trim() || `${parent}/${branch.trim().replaceAll("/", "-")}`;
        const created = await createWorktree(project.id, worktreePath, branch.trim());
        await useWorktrees.getState().load(project);
        useWorktrees.getState().select(created.path);
        toast({ title: t("sidebar.worktreeCreated", { branch: branch.trim() }), icon: "✓" });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="workspace-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="workspace-modal" role="dialog" aria-modal="true" aria-label={kind === "project" ? t("workspace.addProject") : t("workspace.createWorktree")}>
        <div className="workspace-modal-head">
          <h2>{kind === "project" ? t("workspace.addProject") : t("workspace.createWorktree")}</h2>
          <button type="button" className="icon-btn" aria-label={t("workspace.close")} onClick={onClose}><Icon name="close" size={15} /></button>
        </div>
        {kind === "project" ? (
          <>
            <div className="workspace-modal-tabs" role="tablist" aria-label={t("workspace.addProject")}>
              <button type="button" role="tab" aria-selected={mode === "open"} className={mode === "open" ? "active" : ""} onClick={() => setMode("open")}>{t("workspace.openExisting")}</button>
              <button type="button" role="tab" aria-selected={mode === "clone"} className={mode === "clone" ? "active" : ""} onClick={() => setMode("clone")}>{t("workspace.cloneRepository")}</button>
            </div>
            {mode === "open" ? (
              <div className="workspace-modal-field">
                <label>{t("workspace.repositoryFolder")}</label>
                <div className="workspace-modal-file-row">
                  <input className="input" value={folder} readOnly placeholder={t("workspace.chooseFolderPlaceholder")} />
                  <button type="button" className="btn" onClick={() => void browse()}>{t("groups.browse")}</button>
                </div>
              </div>
            ) : (
              <>
                <div className="workspace-modal-field">
                  <label>{t("workspace.repositoryUrl")}</label>
                  <input className="input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder={t("groups.cloneUrlPlaceholder")} />
                </div>
                <div className="workspace-modal-field">
                  <label>{t("workspace.cloneDestination")}</label>
                  <div className="workspace-modal-file-row">
                    <input className="input" value={destination} onChange={(event) => setDestination(event.target.value)} placeholder={t("workspace.chooseFolderPlaceholder")} />
                    <button type="button" className="btn" onClick={() => void browse()}>{t("groups.browse")}</button>
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="workspace-modal-field">
              <label>{t("workspace.branchName")}</label>
              <input className="input" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder={t("sidebar.createWorktreePlaceholder")} autoFocus />
            </div>
            <div className="workspace-modal-field">
              <label>{t("workspace.destinationOptional")}</label>
              <div className="workspace-modal-file-row">
                <input className="input" value={destination} onChange={(event) => setDestination(event.target.value)} placeholder={t("workspace.destinationPlaceholder")} />
              </div>
            </div>
          </>
        )}
        {error && <div className="workspace-modal-error" role="alert">{error}</div>}
        <div className="workspace-modal-actions">
          <button type="button" className="btn" onClick={onClose}>{t("dialog.cancel")}</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {kind === "project" ? t("workspace.addProject") : t("workspace.createWorktree")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Stage() {
  const tree = useStage((s) => s.tree);
  const activeTabId = useStage((s) => s.activeTabId);
  const count = useStage((s) => s.panes.length);
  const dir = useStage((s) => s.dir);
  const activePath = useWorktrees((s) => s.activePath);
  const activeProjectId = useRepos((s) => s.activeProjectId);
  const activeProject = useRepos((s) => s.projects.find((project) => project.id === activeProjectId) ?? null);
  const blankTab = useStage((s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.blank);
  useEffect(() => { useStage.getState().switchWorktree(activePath); }, [activePath]);
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [modalKind, setModalKind] = useState<"project" | "worktree" | null>(null);
  const full = count >= 4;
  const { panes, gutters } = useMemo(() => layoutRects(tree), [tree]);
  // Panes render as flat siblings keyed by pane id (in visual order, for
  // Tab order): splitting or closing changes only their boxes, so React keeps
  // the screens that stay mounted (editor state, terminals).
  const paneIds = useMemo(() => [...panes.keys()], [panes]);

  const empty = blankTab || !activeProjectId || !activePath;

  /** The stage pane under the pointer and the side of it nearest the pointer. */
  const targetAt = (e: DragEvent): DropTarget | null => {
    // `data-stage-pane` is stage-only (the Terminal screen has its own pane ids).
    const el = ((e.target as Element | null)?.closest?.("[data-stage-pane]") ??
      (count === 1 ? ref.current?.querySelector("[data-stage-pane]") : null)) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { paneId: el.dataset.stagePane!, side: nearestSide((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height) };
  };

  return (
    <div className="stage-stack">
      {!empty && <StageTabs />}
      <OperationBanner />
      <div
        ref={ref}
        className={"stage" + (count > 1 ? " split split-" + dir : "")}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(SCREEN_MIME)) return;
          e.preventDefault();
          const target = targetAt(e);
          setDrop((current) => (current?.paneId === target?.paneId && current?.side === target?.side ? current : target));
        }}
        onDragLeave={(e) => { if (!ref.current!.contains(e.relatedTarget as Node)) setDrop(null); }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(SCREEN_MIME) as ScreenId;
          const target = targetAt(e);
          setDrop(null);
          if (!id || !target) return;
          e.preventDefault();
          const stage = useStage.getState();
          const index = stage.panes.indexOf(stage.screens[target.paneId]);
          stage.openSplit(id, target.side, index >= 0 ? index : undefined);
        }}
      >
        <div ref={canvas} className="stage-canvas">
          {empty ? (
            <div className="workspace-empty" role="status" aria-label={activeProjectId ? t("workspace.noWorkspace") : t("workspace.noWorkspace")}>
              <div className="workspace-empty-brand" aria-label={t("app.name")}>
                <span className="app-mark" aria-hidden />
                <span>{t("app.name").toUpperCase()}</span>
              </div>
              <h2>{t("workspace.noWorkspace")}</h2>
              <p>{t("workspace.selectWorkspace")}</p>
              <div className="workspace-empty-actions">
                <button type="button" className="btn sm" onClick={() => setModalKind("project")}>＋ {t("workspace.addProject")}</button>
                <button type="button" className="btn sm" onClick={() => setModalKind("worktree")} disabled={!activeProject}>⌁ {t("workspace.createWorktree")}</button>
                <ViewsMenu mode="newTab" />
              </div>
              <div className="workspace-empty-shortcuts" aria-label={t("workspace.shortcuts")}>
                <span>{t("workspace.createWorktreeShortcut")} <kbd>⌘ N</kbd></span>
                <span>{t("workspace.moveWorkspaceShortcut")} <kbd>⌘ ↑</kbd></span>
                <span>{t("workspace.moveDownShortcut")} <kbd>⌘ ↓</kbd></span>
              </div>
            </div>
          ) : (
            <>
              <DropContext.Provider value={drop}>
                {paneIds.map((paneId) => {
                  const box = panes.get(paneId)!;
                  // Pane IDs can overlap between tabs; including the tab ID prevents
                  // one tab's screen-local state from leaking into another.
                  return <Pane key={`${activeTabId}:${paneId}`} paneId={paneId} x={box.x} y={box.y} w={box.w} h={box.h} />;
                })}
              </DropContext.Provider>
              {gutters.map((gutter) => <Divider key={`${gutter.split.id}:${gutter.index}`} gutter={gutter} canvas={canvas} />)}
            </>
          )}
        </div>
        {drop && full && <span className="dz-hint dz-full">{t("split.dropFull")}</span>}
      </div>
      {modalKind && <WorkspaceActionModal kind={modalKind} project={activeProject} onClose={() => setModalKind(null)} />}
    </div>
  );
}
