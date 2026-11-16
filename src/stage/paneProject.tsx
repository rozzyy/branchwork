import type { ReactNode } from "react";
import { useRepos } from "../state/repos";
import { useWorktrees } from "../state/worktrees";
import type { Worktree } from "../ipc/worktrees";
import type { Project } from "../ipc/catalog";

/** Kept for call-site compatibility; pane project pins were removed, so
 *  panes always follow the global project. */
export function PaneProjectProvider({ children }: { projectId?: string | null; children: ReactNode }) {
  return <>{children}</>;
}

/** Raw pin for this pane; pins were removed, always null. */
export function usePanePin(): string | null {
  return null;
}

/** Effective project id for this pane: the global project. */
export function usePaneProjectId(): string | null {
  return useRepos((s) => s.activeProjectId);
}

/** Effective project record for this pane, or null when no project is active. */
export function usePaneProject() {
  const id = usePaneProjectId();
  return useRepos((s) => s.projects.find((p) => p.id === id) ?? null);
}

export interface PaneWorktrees {
  /** Effective project (pinned or global), or null when none is active. */
  project: Project | null;
  /** Its id, for convenience. */
  projectId: string | null;
  /** Which project the returned worktrees belong to (cache coherence for guards). */
  worktreesProjectId: string | null;
  worktrees: Worktree[];
  activePath: string | null;
  /** Switch worktree: global select() unpinned, cached select when showing another project. */
  select(path: string): void;
}

/** Worktree state for this pane: always the live global data. */
export function usePaneWorktrees(): PaneWorktrees {
  const paneProject = usePaneProject();
  const globalPid = useWorktrees((s) => s.projectId);
  const globalWorktrees = useWorktrees((s) => s.worktrees);
  const globalActivePath = useWorktrees((s) => s.activePath);
  const select = (path: string) => useWorktrees.getState().select(path);
  return {
    project: paneProject,
    projectId: paneProject?.id ?? null,
    worktreesProjectId: globalPid,
    worktrees: globalWorktrees,
    activePath: globalActivePath,
    select,
  };
}
