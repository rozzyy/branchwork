import { useMemo } from "react";
import { t } from "../i18n/t";
import { useSidebar } from "../state/sidebar";
import { projectsForGroup, useRepos } from "../state/repos";
import { GroupSwitcher, GroupSwitcherAddButton } from "./GroupSwitcher";

function ProjectTabs() {
  const activeProjectId = useRepos((s) => s.activeProjectId);
  const activeGroupId = useRepos((s) => s.activeGroupId);
  const allProjects = useRepos((s) => s.projects);
  const groups = useRepos((s) => s.groups);
  const openProjectIds = useRepos((s) => s.openProjectIds);
  const projects = useMemo(
    () => projectsForGroup(allProjects, activeGroupId, groups).filter((p) => openProjectIds.includes(p.id)),
    [allProjects, activeGroupId, groups, openProjectIds],
  );
  if (!projects.length) return null;
  return (
    <ul className="project-tabs" aria-label={t("repos.tabs")}>
      {projects.map((p) => (
        <li key={p.id} className="project-tab-wrap">
          <button
            className="project-tab"
            aria-current={p.id === activeProjectId ? "true" : undefined}
            title={p.name}
            onClick={() => useRepos.getState().selectProject(p.id)}
          >
            {p.name}
          </button>
          <button
            className="project-tab-close"
            aria-label={t("repos.closeTab", { name: p.name })}
            onClick={(e) => {
              e.stopPropagation();
              useRepos.getState().closeTab(p.id);
            }}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

export function TitleBar() {
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="traffic-space" data-tauri-drag-region />
      <button className="icon-btn side-toggle" aria-label={t("sidebar.toggle")} title={t("sidebar.toggle")} onClick={() => useSidebar.getState().toggle()}>◧</button>
      <span className="app-name" data-tauri-drag-region>{t("app.name")}</span>
      <GroupSwitcher />
      <ProjectTabs />
      <GroupSwitcherAddButton />
      <button className="search" onClick={() => window.dispatchEvent(new CustomEvent("bw:palette"))}>
        <span aria-hidden>⌕</span>
        <span className="search-label">{t("search.placeholder")}</span>
        <kbd className="kbd">⌘K</kbd>
      </button>
      <div className="title-right" data-tauri-drag-region />
    </header>
  );
}
