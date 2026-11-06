import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type WorktreeState = "clean" | "dirty" | "conflict" | "rebasing";

export interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  state: WorktreeState;
}

export interface GitChanged {
  worktree: string;
}

export function listWorktrees(projectId: string): Promise<Worktree[]> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Reading worktrees requires the desktop app"));
  }
  return invoke("worktree_list", { projectId });
}

export function createWorktree(
  projectId: string,
  destination: string,
  branch: string,
): Promise<Worktree> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Creating worktrees requires the desktop app"));
  }
  return invoke("worktree_create", { projectId, destination, branch });
}

export function removeWorktree(projectId: string, path: string): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Removing worktrees requires the desktop app"));
  }
  return invoke("worktree_remove", { projectId, path });
}

export function pruneWorktrees(projectId: string): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Pruning worktrees requires the desktop app"));
  }
  return invoke("worktree_prune", { projectId });
}

export function onGitChanged(callback: (event: GitChanged) => void): Promise<UnlistenFn> {
  return listen<GitChanged>("git:changed", (event) => callback(event.payload));
}
