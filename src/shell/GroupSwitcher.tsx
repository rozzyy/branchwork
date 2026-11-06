import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { t } from "../i18n/t";
import { ask, useDialog } from "../ui/dialog";
import { toast } from "../ui/toast";
import { Menu, type MenuItem } from "../ui/Menu";
import { byName, projectsForGroup, useRepos } from "../state/repos";
import { isRepository, pickFolder, type Group, type Project } from "../ipc/catalog";

const SWATCH_HUES = [250, 300, 350, 25, 60, 155, 200];
const swatchColor = (hue: number) => `oklch(.68 .19 ${hue})`;
const DEFAULT_CLONE_TEMPLATE = "~/clients/{repo}";
const REPO_SUFFIX = "/{repo}";

const projectLabel = (p: Project) => (p.owner ? `${p.owner}/${p.name}` : p.name);

/** Drops the trailing `/{repo}` from a clone path template to get the folder to show the user. */
const folderFromTemplate = (template: string): string =>
  template.endsWith(REPO_SUFFIX) ? template.slice(0, -REPO_SUFFIX.length) : template;

/** Strips trailing slashes and `.git`, then takes the last path segment, to derive a repo name from a clone URL. */
export const repoNameFromUrl = (url: string): string => {
  const trimmed = url.trim().replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? trimmed;
  return last.replace(/\.git$/i, "");
};

interface SwitcherState {
  open: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
}

// ponytail: local popover-open store, same pattern as usePalette/useDialog — lets the chip and
// the "+" entry point (rendered elsewhere in TitleBar) share one popover instance.
export const useSwitcher = create<SwitcherState>((set, get) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  toggle: () => set({ open: !get().open }),
}));

interface Section {
  id: string | null;
  name: string;
  color: string | null;
  projects: Project[];
}

function buildSections(groups: Group[], projects: Project[], query: string): Section[] {
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

function GroupSwitcherPopover({ anchorEl }: { anchorEl: HTMLElement | null }) {
  const groups = useRepos((s) => s.groups);
  const projects = useRepos((s) => s.projects);
  const activeGroupId = useRepos((s) => s.activeGroupId);
  const collapsedGroupIds = useRepos((s) => s.collapsedGroupIds);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number; project: Project } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [pos] = useState(() => {
    const r = anchorEl?.getBoundingClientRect();
    return r ? { left: r.left, top: r.bottom + 6 } : { left: 12, top: 46 };
  });

  const sections = useMemo(() => buildSections(groups, projects, query), [groups, projects, query]);

  useEffect(() => searchRef.current?.focus(), []);

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
      useSwitcher.getState().hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || useDialog.getState().current || moveMenu) return;
      e.preventDefault();
      useSwitcher.getState().hide();
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
    useRepos.getState().selectProject(id);
    useSwitcher.getState().hide();
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
                      <span className="group-sec-chevron" aria-hidden>{collapsed ? "▸" : "▾"}</span>
                      <span className="group-sec-sw" aria-hidden style={{ background: section.color ?? "var(--s3)" }} />
                      <span className="group-sec-name">{section.name}{collapsed ? ` · ${section.projects.length}` : ""}</span>
                    </button>
                    {section.id && (
                      <>
                        <button className="icon-btn" aria-label={t("groups.addRepo", { name: section.name })} title={t("groups.addRepo", { name: section.name })} onClick={() => void handleAddRepository(section.id!)}>＋</button>
                        <button className="icon-btn" aria-label={t("groups.edit")} title={t("groups.edit")} onClick={() => setEditing(groups.find((g) => g.id === section.id) ?? null)}>✎</button>
                        <button className="icon-btn" aria-label={t("groups.delete")} title={t("groups.delete")} onClick={() => void handleDelete(section.id!, section.name)}>🗑</button>
                      </>
                    )}
                  </div>
                  <div id={listId}>
                    {!collapsed && section.projects.map((p) => (
                      <div key={p.id} className="group-row">
                        <button className="group-row-main" onClick={() => selectProject(p.id)}>
                          <span className="group-row-name">{projectLabel(p)}</span>
                          <span className="group-row-path">{p.localPath}</span>
                        </button>
                        <button
                          className="icon-btn"
                          aria-label={t("groups.moveTo")}
                          title={t("groups.moveTo")}
                          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMoveMenu({ x: r.left, y: r.bottom + 4, project: p }); }}
                        >
                          ⇄
                        </button>
                      </div>
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

/** The ＋ entry point after the project tabs; opens the same popover as the chip. */
export function GroupSwitcherAddButton() {
  return (
    <button className="icon-btn group-pop-trigger" aria-label={t("groups.add")} title={t("groups.add")} onClick={() => useSwitcher.getState().toggle()}>＋</button>
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
        onClick={() => useSwitcher.getState().toggle()}
      >
        <span className="group-chip-sw" aria-hidden style={{ background: activeGroup?.color ?? "var(--s3)" }} />
        <span className="group-chip-name">{activeGroup?.name ?? t("groups.ungrouped")}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && <GroupSwitcherPopover anchorEl={chipRef.current} />}
    </>
  );
}
