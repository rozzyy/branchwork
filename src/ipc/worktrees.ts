import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands, type Worktree_Serialize, type WorktreeChanged } from "./bindings";

export type { WorktreeState } from "./bindings";
export type Worktree = Worktree_Serialize;
export type GitChanged = WorktreeChanged;

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function listWorktrees(projectId: string): Promise<Worktree[]> {
  if (!inTauri()) {
    return Promise.reject(new Error("Reading worktrees requires the desktop app"));
  }
  return commands.worktreeList(projectId);
}

export function createWorktree(
  projectId: string,
  destination: string,
  branch: string,
): Promise<Worktree> {
  if (!inTauri()) {
    return Promise.reject(new Error("Creating worktrees requires the desktop app"));
  }
  return commands.worktreeCreate(projectId, destination, branch);
}

export function createWorktreeAtCommit(
  projectId: string,
  destination: string,
  branch: string,
  commit: string,
): Promise<Worktree> {
  if (!inTauri()) {
    return Promise.reject(new Error("Creating worktrees requires the desktop app"));
  }
  return commands.worktreeCreateAtCommit(projectId, destination, branch, commit);
}

export function removeWorktree(projectId: string, path: string): Promise<void> {
  if (!inTauri()) {
    return Promise.reject(new Error("Removing worktrees requires the desktop app"));
  }
  return commands.worktreeRemove(projectId, path).then(() => undefined);
}

export function pruneWorktrees(projectId: string): Promise<void> {
  if (!inTauri()) {
    return Promise.reject(new Error("Pruning worktrees requires the desktop app"));
  }
  return commands.worktreePrune(projectId).then(() => undefined);
}

export function onGitChanged(callback: (event: GitChanged) => void): Promise<UnlistenFn> {
  return listen<GitChanged>("git:changed", (event) => callback(event.payload));
}
