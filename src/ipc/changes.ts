import { commands, type CommitOptions, type DiffArea } from "./bindings";

export type { CommitOptions };

export function commit(worktreePath: string, options: CommitOptions): Promise<boolean> {
  return commands.commit(worktreePath, options);
}

export function commitAndPush(worktreePath: string, options: CommitOptions): Promise<boolean> {
  return commands.commitAndPush(worktreePath, options);
}

export function commitAndSync(worktreePath: string, options: CommitOptions): Promise<boolean> {
  return commands.commitAndSync(worktreePath, options);
}

export function stagePaths(worktreePath: string, paths: string[]): Promise<void> {
  return commands.stagePaths(worktreePath, paths).then(() => undefined);
}

export function unstagePaths(worktreePath: string, paths: string[]): Promise<void> {
  return commands.unstagePaths(worktreePath, paths).then(() => undefined);
}

export function discardPaths(
  worktreePath: string,
  paths: string[],
  discardUntracked: boolean,
): Promise<boolean> {
  return commands.discardPaths(worktreePath, paths, discardUntracked);
}

export function stageHunks(
  worktreePath: string,
  path: string,
  hunkIndices: number[],
  area: DiffArea,
): Promise<void> {
  return commands.stageHunks(worktreePath, path, hunkIndices, area).then(() => undefined);
}

export function unstageHunks(
  worktreePath: string,
  path: string,
  hunkIndices: number[],
): Promise<void> {
  return commands.unstageHunks(worktreePath, path, hunkIndices).then(() => undefined);
}

export function stageLines(
  worktreePath: string,
  path: string,
  lineIds: string[],
  area: DiffArea,
): Promise<void> {
  return commands.stageLines(worktreePath, path, lineIds, area).then(() => undefined);
}

export function revertHunk(
  worktreePath: string,
  path: string,
  hunkIndex: number,
): Promise<void> {
  return commands.revertHunk(worktreePath, path, hunkIndex).then(() => undefined);
}
