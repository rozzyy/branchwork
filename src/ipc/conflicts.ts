import {
  commands,
  type ConflictFile_Serialize,
  type ConflictKind,
  type ConflictList,
  type ConflictOperation,
  type ConflictRegion,
  type ConflictResolution,
  type ConflictSummaryReason,
  type RegionChoice,
} from "./bindings";

export type ConflictFile = ConflictFile_Serialize;
export type { ConflictKind, ConflictList, ConflictOperation, ConflictRegion, ConflictResolution, ConflictSummaryReason, RegionChoice };

export function conflictList(worktreePath: string): Promise<ConflictList> {
  return commands.conflictList(worktreePath);
}

export function conflictRead(worktreePath: string, path: string): Promise<ConflictFile> {
  return commands.conflictRead(worktreePath, path);
}

export function conflictResolve(worktreePath: string, path: string, stamp: string, resolution: ConflictResolution): Promise<void> {
  return commands.conflictResolve(worktreePath, path, stamp, resolution).then(() => undefined);
}

export function conflictAbort(worktreePath: string): Promise<void> {
  return commands.conflictAbort(worktreePath).then(() => undefined);
}

export function conflictContinue(worktreePath: string): Promise<void> {
  return commands.conflictContinue(worktreePath).then(() => undefined);
}
