import { t } from "../i18n/t";
import { useSettings } from "../state/settings";
import { useSidebar } from "../state/sidebar";
import { useDock } from "../terminal/dock";
import { projectLabel } from "./GroupSwitcher";
import { useRepos } from "../state/repos";

function ProjectContext() {
  const activeProjectId = useRepos((s) => s.activeProjectId);
  const activeGroupId = useRepos((s) => s.activeGroupId);
  const project = useRepos((s) => s.projects.find((item) => item.id === activeProjectId) ?? null);
  const group = useRepos((s) => s.groups.find((item) => item.id === activeGroupId) ?? null);

  return (
    <div className="title-project-context" title={project ? projectLabel(project) : t("groups.noProjectSelected")}>
      <span className="title-project-group-mark" aria-hidden style={{ background: group?.color ?? "var(--s3)" }} />
      <span className="title-project-group">{group?.name ?? t("groups.ungrouped")}</span>
      <span className="title-project-separator" aria-hidden>/</span>
      <span className="title-project-name">{project ? projectLabel(project) : t("groups.noProjectSelected")}</span>
    </div>
  );
}

export function TitleBar() {
  const dockOpen = useDock((s) => s.open);
  const projectRailOpen = useSidebar((s) => s.projectRailOpen);
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="traffic-space" data-tauri-drag-region />
      <button className="icon-btn side-toggle" aria-label={t("sidebar.toggle")} title={t("sidebar.toggle")} onClick={() => useSidebar.getState().toggle()}>◧</button>
      <span className="app-mark" aria-hidden data-tauri-drag-region />
      <span className="app-name" data-tauri-drag-region>{t("app.name")}</span>
      <ProjectContext />
      <button className="search" onClick={() => window.dispatchEvent(new CustomEvent("bw:palette"))}>
        <span aria-hidden>⌕</span>
        <span className="search-label">{t("search.placeholder")}</span>
        <kbd className="kbd">⌘K</kbd>
      </button>
      <div className="title-right" data-tauri-drag-region>
        <button
          className={"icon-btn project-rail-toggle" + (projectRailOpen ? " on" : "")}
          aria-label={t("groups.toggleProjectSidebar")}
          aria-pressed={projectRailOpen ? "true" : "false"}
          title={t("groups.toggleProjectSidebar")}
          onClick={() => useSidebar.getState().toggleProjectRail()}
        >
          ▤
        </button>
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
      </div>
    </header>
  );
}
