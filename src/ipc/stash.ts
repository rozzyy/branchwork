import { commands, type StashEntry, type StashPushOptions } from "./bindings";

export type { StashEntry, StashPushOptions };

export function stashList(worktreePath: string): Promise<StashEntry[]> {
  return commands.stashList(worktreePath);
}

export function stashPush(worktreePath: string, options: StashPushOptions): Promise<void> {
  return commands.stashPush(worktreePath, options).then(() => undefined);
}

export function stashApply(worktreePath: string, index: number): Promise<void> {
  return commands.stashApply(worktreePath, index).then(() => undefined);
}

export function stashPop(worktreePath: string, index: number): Promise<void> {
  return commands.stashPop(worktreePath, index).then(() => undefined);
}

export function stashDrop(worktreePath: string, index: number): Promise<boolean> {
  return commands.stashDrop(worktreePath, index);
}
