import { commands } from "./bindings";

export function gitFetch(worktreePath: string): Promise<void> {
  return commands.gitFetch(worktreePath).then(() => undefined);
}

/** Resolves to whether the pull can be undone (false when already up to date). */
export function gitPull(worktreePath: string): Promise<boolean> {
  return commands.gitPull(worktreePath);
}

export function gitPush(worktreePath: string): Promise<void> {
  return commands.gitPush(worktreePath).then(() => undefined);
}
