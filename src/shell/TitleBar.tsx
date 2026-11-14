import { useState } from "react";
import { t } from "../i18n/t";
import { useSettings } from "../state/settings";
import { useSidebar } from "../state/sidebar";
import { useDock } from "../terminal/dock";
import { useWorktrees } from "../state/worktrees";
import { GroupSwitcherPopover, projectLabel, useSwitcher } from "./GroupSwitcher";
import { useRepos } from "../state/repos";
import { Menu } from "../ui/Menu";
import { useShortcutSheet } from "./ShortcutSheet";

export function TitleBar() {
  const dockOpen = useDock((s) => s.open);
  const activePath = useWorktrees((s) => s.activePath);
  const worktrees = useWorktrees((s) => s.worktrees);
  const pinnedPaths = useWorktrees((s) => s.pinnedPaths);
  const [projectAnchor, setProjectAnchor] = useState<HTMLElement | null>(null);
  const [worktreeMenu, setWorktreeMenu] = useState<{x:number;y:number} | null>(null);
  const projectOpen = useSwitcher((s) => s.open);
  const activeProjectId = useRepos((s) => s.activeProjectId);
  const activeGroupId = useRepos((s) => s.activeGroupId);
  const project = useRepos((s) => s.projects.find((p) => p.id === activeProjectId) ?? null);
  const group = useRepos((s) => s.groups.find((g) => g.id === activeGroupId) ?? null);
  const activeWorktree = worktrees.find((w) => w.path === activePath);
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="traffic-space" data-tauri-drag-region />
      <button className="icon-btn side-toggle" aria-label={t("sidebar.toggle")} title={t("sidebar.toggle")} onClick={() => useSidebar.getState().toggle()}>◧</button>
      <span className="app-mark" aria-hidden data-tauri-drag-region />
      <span className="app-name" data-tauri-drag-region>{t("app.name")}</span>
      <div className="title-breadcrumb" aria-label={t("shell.location")}>
        <button className="breadcrumb-segment" onClick={(e) => { setProjectAnchor(e.currentTarget); useSwitcher.getState().show(); }}>{group?.name ?? t("groups.ungrouped")}</button>
        <span aria-hidden>›</span>
        <button className="breadcrumb-segment" onClick={(e) => { setProjectAnchor(e.currentTarget); useSwitcher.getState().show(); }}>{project ? projectLabel(project) : t("groups.noProjectSelected")}</button>
        <span aria-hidden>›</span>
        <button className="breadcrumb-segment worktree-crumb" onClick={(e) => { const r=e.currentTarget.getBoundingClientRect(); setWorktreeMenu({x:r.left,y:r.bottom+5}); }}>{activeWorktree?.branch ?? t("sidebar.noWorktree") } ▾</button>
      </div>
      {projectOpen && projectAnchor && <GroupSwitcherPopover anchorEl={projectAnchor} />}
      {worktreeMenu && <Menu x={worktreeMenu.x} y={worktreeMenu.y} onClose={() => setWorktreeMenu(null)} items={worktrees.filter((w) => pinnedPaths.includes(w.path) || w.path === activePath).map((w) => ({ kind:"item" as const, label:w.branch ?? w.path, onSelect:() => useWorktrees.getState().select(w.path) }))} />}
      <button className="search" onClick={() => window.dispatchEvent(new CustomEvent("bw:palette"))}>
        <span aria-hidden>⌕</span>
        <span className="search-label">{t("search.placeholder")}</span>
        <kbd className="kbd">⌘K</kbd>
      </button>
      <div className="title-right" data-tauri-drag-region>
        <button
          className={"icon-btn dock-toggle" + (dockOpen ? " on" : "")}
          aria-label={t("dock.toggle")}
          aria-pressed={dockOpen ? "true" : "false"}
          title={`${t("dock.toggle")} · ⌃\``}
          onClick={() => useDock.getState().toggle()}
        >
          ❯_
        </button>
        <button
          className="icon-btn theme-toggle"
          aria-label={t("palette.toggleTheme")}
          title={t("palette.toggleTheme")}
          onClick={() => useSettings.getState().toggleTheme()}
        >
          ◐
        </button>
        <button className="icon-btn help-toggle" aria-label={t("shortcuts.open")} title={t("shortcuts.open")} onClick={() => useShortcutSheet.getState().show()}>?</button>
      </div>
    </header>
  );
}
