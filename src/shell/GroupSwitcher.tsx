import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { t } from "../i18n/t";
import { ask, useDialog } from "../ui/dialog";
import { toast } from "../ui/toast";
import { Menu, type MenuItem } from "../ui/Menu";
import { byName, projectsForGroup, useRepos } from "../state/repos";
import { isRepository, pickFolder, type Group, type Project } from "../ipc/catalog";
import { Icon } from "../ui/Icon";

const SWATCH_HUES = [250, 300, 350, 25, 60, 155, 200];
export const swatchColor = (hue: number): string => `oklch(.68 .13 ${hue})`;
const DEFAULT_CLONE_TEMPLATE = "~/clients/{repo}";
const REPO_SUFFIX = "/{repo}";

export const projectLabel = (p: Project) => (p.owner ? `${p.owner}/${p.name}` : p.name);

/** Drops the trailing `/{repo}` from a clone path template to get the folder to show the user. */
const folderFromTemplate = (template: string): string =>
  template.endsWith(REPO_SUFFIX) ? template.slice(0, -REPO_SUFFIX.length) : template;

/** Strips trailing slashes and `.git`, then takes the last path segment, to derive a repo name from a clone URL. */
export const repoNameFromUrl = (url: string): string => {
  const trimmed = url.trim().replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? trimmed;
  return last.replace(/\.git$/i, "");
};

interface SwitcherOpenOptions {
  onSelectProject?: (id: string) => void;
}

interface SwitcherState {
  open: boolean;
  /** Anchor the single popover instance positions against; owned here so two triggers can never render two popovers. */
  anchorEl: HTMLElement | null;
  onSelectProject: ((id: string) => void) | null;
  show(anchor: HTMLElement | null, opts?: SwitcherOpenOptions): void;
  hide(): void;
  toggle(anchor?: HTMLElement | null, opts?: SwitcherOpenOptions): void;
}

// Shared by the title-bar switcher and the project rail's group/project actions.
export const useSwitcher = create<SwitcherState>((set, get) => ({
  open: false,
  anchorEl: null,
  onSelectProject: null,
  show: (anchor, opts) =>
    set({
      open: true,
      anchorEl: anchor,
      onSelectProject: opts?.onSelectProject ?? null,
    }),
  hide: () => set({ open: false, anchorEl: null, onSelectProject: null }),
  toggle: (anchor, opts) => {
    if (get().open) get().hide();
    else get().show(anchor ?? null, opts);
  },
}));

/** The single project-popover instance. Rendered once (App root); every trigger opens it via `show`. */
export function GroupSwitcherHost() {
  const open = useSwitcher((s) => s.open);
  const anchorEl = useSwitcher((s) => s.anchorEl);
  const onSelectProject = useSwitcher((s) => s.onSelectProject);
  if (!open || !anchorEl) return null;
  return (
    <GroupSwitcherPopover
      anchorEl={anchorEl}
      onSelectProject={onSelectProject ?? undefined}
      onClose={() => useSwitcher.getState().hide()}
    />
  );
}

export interface Section {
  id: string | null;
  name: string;
  color: string | null;
  projects: Project[];
}

export function buildSections(groups: Group[], projects: Project[], query: string): Section[] {
  const sections: Section[] = [
    ...byName(groups).map((g) => ({ id: g.id, name: g.name, color: g.color, projects: projectsForGroup(projects, g.id, groups) })),
    { id: null, name: t("groups.ungrouped"), color: null, projects: projectsForGroup(projects, null, groups) },
  ];
  const needle = query.trim().toLowerCase();
  if (!needle) return sections;
  const matches = (s: string) => s.toLowerCase().includes(needle);
  return sections
    .map((section) => ({
      ...section,
      projects: matches(section.name)
        ? section.projects
        : section.projects.filter((p) => matches(projectLabel(p)) || matches(p.localPath)),
    }))
    .filter((section) => matches(section.name) || section.projects.length > 0);
}

function rowMenuItems(groups: Group[], project: Project, onRemove: (project: Project) => void): MenuItem[] {
  const items: MenuItem[] = byName(groups).map((g) => ({
    kind: "item",
    label: g.name,
    onSelect: () => void useRepos.getState().moveProject(project.id, g.id),
  }));
  items.push({ kind: "item", label: t("groups.ungrouped"), onSelect: () => void useRepos.getState().moveProject(project.id, null) });
  items.push({ kind: "separator" });
  items.push({ kind: "item", label: t("groups.removeProject"), danger: true, onSelect: () => onRemove(project) });
  return items;
}

/** Effective active project ids: just the global project (pane pins removed). */
function useActiveProjectIds(): Set<string> {
  const activeId = useRepos((s) => s.activeProjectId);
  const projects = useRepos((s) => s.projects);
  return useMemo(() => {
    const valid = new Set(projects.map((p) => p.id));
    const ids = new Set<string>();
    if (activeId && valid.has(activeId)) ids.add(activeId);
    return ids;
  }, [activeId, projects]);
}

function ProjectRow({
  project,
  onSelect,
  onMove,
  onToggleWorktrees,
  expanded,
  active,
}: {
  project: Project;
  onSelect(id: string): void;
  onMove(project: Project, at: { x: number; y: number }): void;
  onToggleWorktrees?(id: string): void;
  expanded?: boolean;
  active?: boolean;
}) {
  return (
    <div className={"group-row" + (active ? " is-active" : "")}>
      {onToggleWorktrees && (
        <button
          type="button"
          className="icon-btn group-project-toggle"
          aria-label={t(expanded ? "groups.collapseWorktrees" : "groups.expandWorktrees", { name: projectLabel(project) })}
          aria-expanded={expanded}
          title={t(expanded ? "groups.collapseWorktrees" : "groups.expandWorktrees", { name: projectLabel(project) })}
          onClick={() => onToggleWorktrees(project.id)}
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={13} />
        </button>
      )}
      <button className={"group-row-main" + (active ? " is-active" : "")} aria-current={active ? "true" : undefined} onClick={() => onSelect(project.id)}>
        <span className="group-row-name">{projectLabel(project)}</span>
      </button>
      <button
        className="icon-btn"
        aria-label={t("groups.moveTo")}
        title={t("groups.moveTo")}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onMove(project, { x: r.left, y: r.bottom + 4 }); }}
      >
        <Icon name="move" size={15} />
      </button>
    </div>
  );
}

function GroupForm({ initial, onCancel, onSave }: { initial: Group | null; onCancel(): void; onSave(group: Group): void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState(initial?.color ?? swatchColor(SWATCH_HUES[0]));
  const [clonePathTemplate, setClonePathTemplate] = useState(initial?.clonePathTemplate ?? DEFAULT_CLONE_TEMPLATE);
  const [folderIsRepo, setFolderIsRepo] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  const browse = async () => {
    let path: string | null;
    try {
      path = await pickFolder(t("groups.browseTitle"));
    } catch (e) {
      toast({ title: t("groups.browseError", { message: e instanceof Error ? e.message : String(e) }), icon: "⚠" });
      return;
    }
    if (path === null) return; // cancelled, keep the current value
    setClonePathTemplate(`${path}${REPO_SUFFIX}`);
    setFolderIsRepo(await isRepository(path));
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      name: trimmed,
      color,
      clonePathTemplate: clonePathTemplate.trim() || DEFAULT_CLONE_TEMPLATE,
    });
  };

  return (
    <div className="group-form">
      <input ref={nameRef} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("groups.formNamePlaceholder")} aria-label={t("groups.formName")} />
      <div className="swatches">
        {SWATCH_HUES.map((hue) => {
          const c = swatchColor(hue);
          return (
            <button key={hue} type="button" className={"swatch" + (color === c ? " on" : "")} style={{ background: c }} aria-label={t("settings.accentHue", { hue })} onClick={() => setColor(c)} />
          );
        })}
      </div>
      {initial && (
        <>
          <div className="group-form-path-row">
            <input className="input" value={folderFromTemplate(clonePathTemplate)} readOnly aria-label={t("groups.formClonePath")} />
            <button type="button" className="btn sm" onClick={() => void browse()}>{t("groups.browse")}</button>
          </div>
          {folderIsRepo && <p className="group-form-warning">{t("groups.cloneFolderIsRepo")}</p>}
          <p className="group-form-hint">{t("groups.cloneFolderHint")}</p>
        </>
      )}
      <div className="dlg-actions">
        <button className="btn" onClick={onCancel}>{t("dialog.cancel")}</button>
        <button className="btn primary" disabled={!name.trim()} onClick={save}>{t("groups.save")}</button>
      </div>
    </div>
  );
}

export function GroupSwitcherPopover({
  anchorEl,
  initialEditing = null,
  initialQuery = "",
  onSelectProject,
  onClose,
}: {
  anchorEl: HTMLElement | null;
  initialEditing?: Group | "new" | null;
  initialQuery?: string;
  /** Override the global project switch. */
  onSelectProject?: (id: string) => void;
  /** Override the close handling (e.g. a locally anchored popover). */
  onClose?: () => void;
}) {
  const groups = useRepos((s) => s.groups);
  const projects = useRepos((s) => s.projects);
  const recentIds = useRepos((s) => s.recentProjectIds);
  const activeGroupId = useRepos((s) => s.activeGroupId);
  const collapsedGroupIds = useRepos((s) => s.collapsedGroupIds);
  const activeProjectIds = useActiveProjectIds();
  const [query, setQuery] = useState(initialQuery);
  const [editing, setEditing] = useState<Group | "new" | null>(initialEditing);
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number; project: Project } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Memoized (not one-shot state): the singleton host re-targets the same
  // mounted popover when another trigger opens it.
  const pos = useMemo(() => {
    const r = anchorEl?.getBoundingClientRect();
    if (!r) return { left: 12, top: 46 };
    const width = Math.min(340, window.innerWidth - 24);
    const height = Math.min(520, window.innerHeight * 0.7);
    return {
      left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(r.bottom + 6, window.innerHeight - height - 12)),
    };
  }, [anchorEl]);

  const sections = useMemo(() => buildSections(groups, projects, query), [groups, projects, query]);
  // Recents are shortcuts above the grouped list (hidden while searching).
  // The grouped list below stays complete and unchanged.
  const recents = useMemo(() => {
    if (query.trim()) return [];
    const byId = new Map(projects.map((p) => [p.id, p]));
    return recentIds.map((id) => byId.get(id)).filter((p): p is Project => p !== undefined);
  }, [projects, recentIds, query]);

  useEffect(() => searchRef.current?.focus(), []);

  const close = onClose ?? (() => useSwitcher.getState().hide());
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        popRef.current?.contains(target) ||
        target.closest(".menu") ||
        target.closest(".dlg-backdrop") ||
        target.closest(".group-chip") ||
        target.closest(".group-pop-trigger")
      )
        return; // the chip/＋ triggers handle their own toggle on click
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || useDialog.getState().current || moveMenu) return;
      e.preventDefault();
      close();
    };
    const timer = setTimeout(() => window.addEventListener("mousedown", onMouseDown)); // skip the opening click
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [moveMenu]);

  const selectProject = (id: string) => {
    if (onSelectProject) onSelectProject(id);
    else useRepos.getState().selectProject(id);
    close();
  };

  const handleDelete = async (id: string, name: string) => {
    const confirmed = await ask({ title: t("groups.deleteTitle", { name }), body: t("groups.deleteBody"), danger: true, ok: t("groups.deleteOk") });
    if (confirmed !== true) return;
    const snapshot = await useRepos.getState().deleteGroup(id);
    if (!snapshot) return;
    toast({ title: t("groups.deleted", { name }), action: { label: t("toast.undo"), run: () => void useRepos.getState().restoreGroup(snapshot) } });
  };

  const handleRemove = async (project: Project) => {
    const name = projectLabel(project);
    const confirmed = await ask({ title: t("groups.removeTitle", { name }), body: t("groups.removeBody"), danger: true, ok: t("groups.removeOk") });
    if (confirmed !== true) return;
    const snapshot = await useRepos.getState().removeProject(project.id);
    if (!snapshot) return;
    toast({ title: t("groups.removed", { name }), action: { label: t("toast.undo"), run: () => void useRepos.getState().restoreProject(snapshot) } });
  };

  const moveIntoActiveGroup = async (project: Project | undefined) => {
    if (project && activeGroupId) await useRepos.getState().moveProject(project.id, activeGroupId);
  };

  const handleAddRepository = async (groupId: string) => {
    let path: string | null;
    try {
      path = await pickFolder(t("groups.openTitle"));
    } catch (e) {
      toast({ title: t("repos.openError", { message: e instanceof Error ? e.message : String(e) }), icon: "⚠" });
      return;
    }
    if (path === null) return; // cancelled
    const project = await useRepos.getState().openRepo(path);
    if (!project) return;
    await useRepos.getState().moveProject(project.id, groupId);
    if (collapsedGroupIds.includes(groupId)) useRepos.getState().toggleGroupCollapsed(groupId);
  };

  const handleOpen = async () => {
    let path: string | null;
    try {
      path = await pickFolder(t("groups.openTitle"));
    } catch (e) {
      toast({ title: t("repos.openError", { message: e instanceof Error ? e.message : String(e) }), icon: "⚠" });
      return;
    }
    if (path === null) return; // cancelled
    await useRepos.getState().openRepo(path);
  };

  const handleClone = async () => {
    const url = await ask({ title: t("groups.cloneUrlTitle"), input: "", placeholder: t("groups.cloneUrlPlaceholder") });
    if (typeof url !== "string" || !url.trim()) return;
    const template = (activeGroupId && groups.find((g) => g.id === activeGroupId)?.clonePathTemplate) || DEFAULT_CLONE_TEMPLATE;
    const repoName = repoNameFromUrl(url);
    const destination = template.replace("{repo}", () => repoName); // function replacement: avoids $&/$`/$' special patterns in repoName
    const dest = await ask({ title: t("groups.cloneDestTitle"), input: destination, placeholder: destination });
    if (typeof dest !== "string") return;
    await moveIntoActiveGroup(await useRepos.getState().cloneRepo(url.trim(), dest));
  };

  return createPortal(
    <div ref={popRef} className="group-pop" role="dialog" aria-label={t("groups.search")} style={{ left: pos.left, top: pos.top }}>
      {editing ? (
        <GroupForm
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={(group) => { void useRepos.getState().saveGroup(group); setEditing(null); }}
        />
      ) : (
        <>
          <input
            ref={searchRef}
            className="input group-pop-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("groups.searchPlaceholder")}
            aria-label={t("groups.search")}
          />
          <div className="group-pop-list">
            {recents.length > 0 && (
              <div className="group-sec">
                <div className="group-sec-head">
                  <span className="group-sec-name">{t("groups.recent")}</span>
                </div>
                <div>
                  {recents.map((p) => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      onSelect={selectProject}
                      onMove={(project, at) => setMoveMenu({ ...at, project })}
                      active={activeProjectIds.has(p.id)}
                    />
                  ))}
                </div>
              </div>
            )}
            {sections.map((section) => {
              const key = section.id ?? "ungrouped";
              const listId = `group-sec-list-${key}`;
              const isSearching = query.trim().length > 0;
              const collapsed = !isSearching && collapsedGroupIds.includes(key);
              return (
                <div key={key} className="group-sec">
                  <div className="group-sec-head">
                    <button
                      type="button"
                      className="group-sec-toggle"
                      aria-expanded={!collapsed}
                      aria-controls={listId}
                      onClick={() => useRepos.getState().toggleGroupCollapsed(key)}
                    >
                      <span className="group-sec-chevron" aria-hidden>
                        <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={13} />
                      </span>
                      <span className="group-sec-sw" aria-hidden style={{ background: section.color ?? "var(--s3)" }} />
                      <span className="group-sec-name">{section.name}{collapsed ? ` · ${section.projects.length}` : ""}</span>
                    </button>
                    {section.id && (
                      <>
                        <button className="icon-btn" aria-label={t("groups.addRepo", { name: section.name })} title={t("groups.addRepo", { name: section.name })} onClick={() => void handleAddRepository(section.id!)}><Icon name="plus" size={14} /></button>
                        <button className="icon-btn" aria-label={t("groups.edit")} title={t("groups.edit")} onClick={() => setEditing(groups.find((g) => g.id === section.id) ?? null)}>✎</button>
                        <button className="icon-btn" aria-label={t("groups.delete")} title={t("groups.delete")} onClick={() => void handleDelete(section.id!, section.name)}>✕</button>
                      </>
                    )}
                  </div>
                  <div id={listId}>
                    {!collapsed && section.projects.map((p) => (
                      <ProjectRow
                        key={p.id}
                        project={p}
                        onSelect={selectProject}
                        onMove={(project, at) => setMoveMenu({ ...at, project })}
                        active={activeProjectIds.has(p.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="group-pop-foot">
            <button className="btn sm" onClick={() => setEditing("new")}>{t("groups.new")}</button>
            <button className="btn sm" onClick={() => void handleOpen()}>{t("groups.openRepo")}</button>
            <button className="btn sm" onClick={() => void handleClone()}>{t("groups.cloneRepo")}</button>
          </div>
        </>
      )}
      {moveMenu && <Menu x={moveMenu.x} y={moveMenu.y} onClose={() => setMoveMenu(null)} items={rowMenuItems(groups, moveMenu.project, handleRemove)} />}
    </div>,
    document.body,
  );
}

/** Inline group list for the sidebar, with the active project's worktrees nested beneath it.
 *  Renders every group and project in place — no popover/modal — so the whole
 *  catalog is visible without an extra click. The list scrolls internally so
 *  it never expands the sidebar. Create/open/clone are icon buttons in the
 *  heading row; search, collapse, move/remove mirror the popover. */
export function GroupInlineList({ renderProjectContent }: { renderProjectContent?: (project: Project) => ReactNode }) {
  const groups = useRepos((s) => s.groups);
  const projects = useRepos((s) => s.projects);
  const activeProjectId = useRepos((s) => s.activeProjectId);
  const openProjectIds = useRepos((s) => s.openProjectIds);
  const activeGroupId = useRepos((s) => s.activeGroupId);
  const collapsedGroupIds = useRepos((s) => s.collapsedGroupIds);
  const activeProjectIds = useActiveProjectIds();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number; project: Project } | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; section: Section } | null>(null);
  const [collapsedWorktreeProjects, setCollapsedWorktreeProjects] = useState<Set<string>>(() => new Set());

  const sections = useMemo(() => buildSections(groups, projects, query), [groups, projects, query]);

  const selectProject = (id: string) => useRepos.getState().openProject(id);
  const toggleProjectWorktrees = (id: string) => {
    if (id !== activeProjectId) {
      if (openProjectIds.includes(id)) useRepos.getState().closeProject(id);
      else useRepos.getState().openProject(id);
      setCollapsedWorktreeProjects((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      return;
    }
    setCollapsedWorktreeProjects((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDelete = async (id: string, name: string) => {
    const confirmed = await ask({ title: t("groups.deleteTitle", { name }), body: t("groups.deleteBody"), danger: true, ok: t("groups.deleteOk") });
    if (confirmed !== true) return;
    const snapshot = await useRepos.getState().deleteGroup(id);
    if (!snapshot) return;
    toast({ title: t("groups.deleted", { name }), action: { label: t("toast.undo"), run: () => void useRepos.getState().restoreGroup(snapshot) } });
  };

  const handleRemove = async (project: Project) => {
    const name = projectLabel(project);
    const confirmed = await ask({ title: t("groups.removeTitle", { name }), body: t("groups.removeBody"), danger: true, ok: t("groups.removeOk") });
    if (confirmed !== true) return;
    const snapshot = await useRepos.getState().removeProject(project.id);
    if (!snapshot) return;
    toast({ title: t("groups.removed", { name }), action: { label: t("toast.undo"), run: () => void useRepos.getState().restoreProject(snapshot) } });
  };

  const moveIntoActiveGroup = async (project: Project | undefined) => {
    if (project && activeGroupId) await useRepos.getState().moveProject(project.id, activeGroupId);
  };

  const handleAddRepository = async (groupId: string) => {
    let path: string | null;
    try {
      path = await pickFolder(t("groups.openTitle"));
    } catch (e) {
      toast({ title: t("repos.openError", { message: e instanceof Error ? e.message : String(e) }), icon: "⚠" });
      return;
    }
    if (path === null) return;
    const project = await useRepos.getState().openRepo(path);
    if (!project) return;
    await useRepos.getState().moveProject(project.id, groupId);
    if (collapsedGroupIds.includes(groupId)) useRepos.getState().toggleGroupCollapsed(groupId);
  };

  const handleOpen = async () => {
    let path: string | null;
    try {
      path = await pickFolder(t("groups.openTitle"));
    } catch (e) {
      toast({ title: t("repos.openError", { message: e instanceof Error ? e.message : String(e) }), icon: "⚠" });
      return;
    }
    if (path === null) return;
    await useRepos.getState().openRepo(path);
  };

  const handleClone = async () => {
    const url = await ask({ title: t("groups.cloneUrlTitle"), input: "", placeholder: t("groups.cloneUrlPlaceholder") });
    if (typeof url !== "string" || !url.trim()) return;
    const template = (activeGroupId && groups.find((g) => g.id === activeGroupId)?.clonePathTemplate) || DEFAULT_CLONE_TEMPLATE;
    const repoName = repoNameFromUrl(url);
    const destination = template.replace("{repo}", () => repoName);
    const dest = await ask({ title: t("groups.cloneDestTitle"), input: destination, placeholder: destination });
    if (typeof dest !== "string") return;
    await moveIntoActiveGroup(await useRepos.getState().cloneRepo(url.trim(), dest));
  };

  return (
    <section className="group-inline" aria-label={t("groups.title")}>
      <div className="side-h group-inline-head">
        <span className="group-head-title">{t("groups.title")}</span>
        {!editing && (
          <>
            <button className="icon-btn group-inline-action" aria-label={t("groups.new")} title={t("groups.new")} onClick={() => setEditing("new")}><Icon name="plus" size={14} /></button>
            <button className="icon-btn group-inline-action" aria-label={t("groups.openProject")} title={t("groups.openProject")} onClick={() => void handleOpen()}><Icon name="folder" size={15} /></button>
            <button className="icon-btn group-inline-action" aria-label={t("groups.cloneRepo")} title={t("groups.cloneRepo")} onClick={() => void handleClone()}><Icon name="branch" size={15} /></button>
          </>
        )}
      </div>
      {editing ? (
        <GroupForm
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={(group) => { void useRepos.getState().saveGroup(group); setEditing(null); }}
        />
      ) : (
        <>
          <input
            className="input group-inline-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("groups.searchPlaceholder")}
            aria-label={t("groups.search")}
          />
          {sections.length === 0 ? (
            <div className="side-empty">{t("groups.noProjectMatches")}</div>
          ) : (
            <div className="group-inline-list">
              {sections.map((section) => {
                const key = section.id ?? "ungrouped";
                const listId = `group-inline-list-${key}`;
                const isSearching = query.trim().length > 0;
                const collapsed = !isSearching && collapsedGroupIds.includes(key);
                return (
                  <div key={key} className="group-sec">
                    <div className="group-sec-head">
                      <button
                        type="button"
                        className="group-sec-toggle"
                        aria-expanded={!collapsed}
                        aria-controls={listId}
                        onClick={() => useRepos.getState().toggleGroupCollapsed(key)}
                      >
                        <span className="group-sec-chevron" aria-hidden>
                          <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={13} />
                        </span>
                        <span className="group-sec-sw" aria-hidden style={{ background: section.color ?? "var(--s3)" }} />
                        <span className="group-sec-name">{section.name}{collapsed ? ` · ${section.projects.length}` : ""}</span>
                      </button>
                      {section.id && (
                        <button className="icon-btn" aria-label={t("groups.manage", { name: section.name })} title={t("groups.manage", { name: section.name })} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setGroupMenu({ x: r.right, y: r.bottom + 4, section }); }}><Icon name="more" size={16} /></button>
                      )}
                    </div>
                    <div id={listId}>
                      {!collapsed && section.projects.map((p) => (
                        <div className="group-project-entry" key={p.id}>
                          <ProjectRow
                            project={p}
                            onSelect={selectProject}
                            onMove={(project, at) => setMoveMenu({ ...at, project })}
                            onToggleWorktrees={toggleProjectWorktrees}
                            expanded={(openProjectIds.includes(p.id) || p.id === activeProjectId) && !collapsedWorktreeProjects.has(p.id)}
                            active={activeProjectIds.has(p.id)}
                          />
                          {(openProjectIds.includes(p.id) || p.id === activeProjectId) && (
                            <div className="group-project-worktrees" id={`project-worktrees-${p.id}`} hidden={collapsedWorktreeProjects.has(p.id)}>
                              {renderProjectContent?.(p)}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {moveMenu && <Menu x={moveMenu.x} y={moveMenu.y} onClose={() => setMoveMenu(null)} items={rowMenuItems(groups, moveMenu.project, handleRemove)} />}
      {groupMenu && (
        <Menu
          x={groupMenu.x}
          y={groupMenu.y}
          onClose={() => setGroupMenu(null)}
          items={[
            { kind: "item", label: t("groups.addRepo", { name: groupMenu.section.name }), onSelect: () => void handleAddRepository(groupMenu.section.id!) },
            { kind: "item", label: t("groups.edit"), onSelect: () => setEditing(groups.find((g) => g.id === groupMenu.section.id) ?? null) },
            { kind: "item", label: t("groups.delete"), danger: true, onSelect: () => void handleDelete(groupMenu.section.id!, groupMenu.section.name) },
          ]}
        />
      )}
    </section>
  );
}

/** The ＋ entry point after the project tabs; opens the same popover as the chip. */
export function GroupSwitcherAddButton() {
  return (
    <button className="icon-btn group-pop-trigger" aria-label={t("groups.add")} title={t("groups.add")} onClick={(e) => useSwitcher.getState().toggle(e.currentTarget)}>＋</button>
  );
}

export function GroupSwitcher() {
  const open = useSwitcher((s) => s.open);
  const chipRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const groups = useRepos((s) => s.groups);
  const activeGroupId = useRepos((s) => s.activeGroupId);
  const activeGroup = useMemo(() => groups.find((g) => g.id === activeGroupId) ?? null, [groups, activeGroupId]);

  useEffect(() => {
    if (wasOpen.current && !open) chipRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return (
    <>
      <button
        ref={chipRef}
        className="group-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("groups.switcherLabel", { name: activeGroup?.name ?? t("groups.ungrouped") })}
        title={t("groups.switcher")}
        onClick={() => useSwitcher.getState().toggle(chipRef.current)}
      >
        <span className="group-chip-sw" aria-hidden style={{ background: activeGroup?.color ?? "var(--s3)" }} />
        <span className="group-chip-name">{activeGroup?.name ?? t("groups.ungrouped")}</span>
        <span aria-hidden>▾</span>
      </button>
    </>
  );
}
