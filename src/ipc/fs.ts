import {
  commands,
  type FsEntryKind,
  type FsReadResult,
  type FsTree,
  type FsTreeOptions,
} from "./bindings";

export type {
  FsEncoding,
  FsEntry,
  FsEntryKind,
  FsEol,
  FsReadResult,
  FsTree,
  FsTreeOptions,
} from "./bindings";

export function fsTree(worktreePath: string, options: FsTreeOptions): Promise<FsTree> {
  return commands.fsTree(worktreePath, options);
}

export function fsRead(worktreePath: string, path: string): Promise<FsReadResult> {
  return commands.fsRead(worktreePath, path);
}

export function fsWrite(
  worktreePath: string,
  path: string,
  bytes: number[],
  expectedMtime: number,
): Promise<number> {
  return commands.fsWrite(worktreePath, path, bytes, expectedMtime);
}

export function fsCreate(worktreePath: string, path: string, kind: FsEntryKind): Promise<void> {
  return commands.fsCreate(worktreePath, path, kind).then(() => undefined);
}

export function fsRename(worktreePath: string, from: string, to: string): Promise<void> {
  return commands.fsRename(worktreePath, from, to).then(() => undefined);
}

export function fsDelete(worktreePath: string, path: string): Promise<boolean> {
  return commands.fsDelete(worktreePath, path);
}

export function revealInFinder(worktreePath: string, path: string): Promise<void> {
  return commands.revealInFinder(worktreePath, path).then(() => undefined);
}
