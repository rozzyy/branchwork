import { commands, type CommitOptions, type DiffArea } from "./bindings";

export type { CommitOptions };

export function commit(worktreePath: string, options: CommitOptions): Promise<void> {
  return commands.commit(worktreePath, options).then(() => undefined);
}

export function commitAndPush(worktreePath: string, options: CommitOptions): Promise<void> {
  return commands.commitAndPush(worktreePath, options).then(() => undefined);
}

export function commitAndSync(worktreePath: string, options: CommitOptions): Promise<void> {
  return commands.commitAndSync(worktreePath, options).then(() => undefined);
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
): Promise<void> {
  return commands.discardPaths(worktreePath, paths, discardUntracked).then(() => undefined);
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
