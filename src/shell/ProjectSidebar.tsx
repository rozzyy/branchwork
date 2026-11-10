import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { t } from "../i18n/t";
import type { Group } from "../ipc/catalog";
import { useRepos } from "../state/repos";
import { useSidebar } from "../state/sidebar";
import { GroupSwitcherPopover, buildSections, projectLabel, useSwitcher } from "./GroupSwitcher";
import { worktreeColor } from "./Sidebar";

const UNGROUPED_COLLAPSE_ID = "ungrouped";

interface PopoverState {
  anchorEl: HTMLElement;
  initialEditing?: Group | "new" | null;
  initialQuery?: string;
}

export function ProjectSidebar() {
  const railOpen = useSidebar((s) => s.projectRailOpen);
  const groups = useRepos((s) => s.groups);
  const projects = useRepos((s) => s.projects);
  const activeGroupId = useRepos((s) => s.activeGroupId);
  const activeProjectId = useRepos((s) => s.activeProjectId);
  const collapsedGroupIds = useRepos((s) => s.collapsedGroupIds);
  const status = useRepos((s) => s.status);
  const error = useRepos((s) => s.error);
  const popoverOpen = useSwitcher((s) => s.open);
  const [query, setQuery] = useState("");
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const popoverAnchor = useRef<HTMLElement | null>(null);
  const wasPopoverOpen = useRef(false);
  const searching = query.trim().length > 0;
  const sections = useMemo(() => buildSections(groups, projects, query), [groups, projects, query]);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? null;

  useEffect(() => {
    if (!railOpen && popoverOpen) useSwitcher.getState().hide();
  }, [railOpen, popoverOpen]);

  useEffect(() => {
    if (!popoverOpen) setPopover(null);
  }, [popoverOpen]);

  useEffect(() => {
    if (!popoverOpen && wasPopoverOpen.current && document.activeElement === document.body) {
      popoverAnchor.current?.focus();
    }
    wasPopoverOpen.current = popoverOpen;
  }, [popoverOpen]);

  const togglePopover = (
    event: MouseEvent<HTMLButtonElement>,
    options: Omit<PopoverState, "anchorEl"> = {},
  ) => {
    if (useSwitcher.getState().open) {
      useSwitcher.getState().hide();
      return;
    }
    popoverAnchor.current = event.currentTarget;
    setPopover({ anchorEl: event.currentTarget, ...options });
    useSwitcher.getState().show();
  };

  return (
    <aside className="project-sidebar" aria-label={t("groups.projectSidebar")} hidden={!railOpen}>
      <header className="project-sidebar-header">
        <h2 className="project-sidebar-title">{t("repos.tabs")}</h2>
        <button
          type="button"
          className="icon-btn project-sidebar-add group-pop-trigger"
          aria-label={t("groups.add")}
          title={t("groups.add")}
          onClick={(event) => togglePopover(event)}
        >
          +
        </button>
      </header>

      <div className="project-sidebar-search-wrap">
        <input
          className="input project-sidebar-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("groups.searchProjectsPlaceholder")}
          aria-label={t("groups.search")}
        />
      </div>

      <div className="project-sidebar-scroll">
        {status === "loading" && <div className="project-sidebar-message">{t("groups.loadingProjects")}</div>}
        {status === "error" && (
          <div className="project-sidebar-error" role="alert">
            <span>{t("repos.loadError", { message: error ?? t("groups.unknownError") })}</span>
            <button type="button" className="btn sm" onClick={() => void useRepos.getState().load()}>
              {t("groups.retry")}
            </button>
          </div>
        )}
        {status !== "loading" && status !== "error" && sections.length === 0 && (
          <div className="project-sidebar-message">
            {projects.length ? t("groups.noProjectMatches") : t("groups.noProjects")}
          </div>
        )}
        {status !== "loading" && status !== "error" && sections.map((section) => {
          const collapseId = section.id ?? UNGROUPED_COLLAPSE_ID;
          const collapsed = !searching && collapsedGroupIds.includes(collapseId);
          const sectionDomId = `project-group-${collapseId}`;
          return (
            <section className="project-sidebar-group" key={collapseId}>
              <div className="project-sidebar-group-head">
                <button
                  type="button"
                  className="project-sidebar-collapse"
                  aria-label={t(collapsed ? "groups.expand" : "groups.collapse", { name: section.name })}
                  aria-expanded={!collapsed}
                  aria-controls={sectionDomId}
                  onClick={() => useRepos.getState().toggleGroupCollapsed(collapseId)}
                >
                  {collapsed ? "›" : "⌄"}
                </button>
                <button
                  type="button"
                  className={"project-sidebar-group-select" + (section.id === activeGroupId ? " active" : "")}
                  onClick={() => useRepos.getState().selectGroup(section.id)}
                  title={section.name}
                >
                  <span
                    className="project-sidebar-group-mark"
                    aria-hidden
                    style={{ background: section.color ?? "var(--s3)" }}
                  />
                  <span className="project-sidebar-group-name">{section.name}</span>
                  <span className="project-sidebar-count">{section.projects.length}</span>
                </button>
                {section.id && (
                  <button
                    type="button"
                    className="icon-btn project-sidebar-group-menu group-pop-trigger"
                    aria-label={t("groups.manage", { name: section.name })}
                    title={t("groups.manage", { name: section.name })}
                    onClick={(event) => togglePopover(event, { initialQuery: section.name })}
                  >
                    ···
                  </button>
                )}
              </div>
              <div className="project-sidebar-projects" id={sectionDomId} hidden={collapsed}>
                {section.projects.map((project) => (
                  <button
                    type="button"
                    key={project.id}
                    className={"project-sidebar-project" + (project.id === activeProjectId ? " active" : "")}
                    aria-current={project.id === activeProjectId ? "page" : undefined}
                    title={project.localPath}
                    onClick={() => useRepos.getState().selectProject(project.id)}
                  >
                    <span className="project-sidebar-project-mark" aria-hidden style={{ background: worktreeColor(project.localPath) }}>
                      {project.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="project-sidebar-project-detail">
                      <span className="project-sidebar-project-name">{project.name}</span>
                      <span className="project-sidebar-project-owner">{project.owner ?? t("groups.localProject")}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <div className="project-sidebar-context" title={activeProject ? projectLabel(activeProject) : t("groups.noProjectSelected")}>
        <span className="project-sidebar-context-group">{activeGroup?.name ?? t("groups.ungrouped")}</span>
        <span className="project-sidebar-context-separator" aria-hidden>/</span>
        <span className="project-sidebar-context-project">{activeProject?.name ?? t("groups.noProjectSelected")}</span>
      </div>
      <footer className="project-sidebar-footer">
        <button
          type="button"
          className="btn sm group-pop-trigger"
          onClick={(event) => togglePopover(event, { initialEditing: "new" })}
        >
          {t("groups.addGroupShort")}
        </button>
        <button type="button" className="btn sm group-pop-trigger" onClick={(event) => togglePopover(event)}>
          {t("groups.addProjectShort")}
        </button>
      </footer>

      {popoverOpen && popover && <GroupSwitcherPopover {...popover} />}
    </aside>
  );
}
