import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  commands,
  type RebaseOutcome_Serialize,
  type RebasePlan_Serialize,
  type RebaseProgress,
  type RebaseRequest,
} from "./bindings";

export type RebasePlan = RebasePlan_Serialize;
export type RebaseOutcome = RebaseOutcome_Serialize;
export type { RebaseProgress, RebaseRequest };

export function rebasePlan(worktreePath: string, base: string): Promise<RebasePlan> {
  return commands.rebasePlan(worktreePath, base);
}

export function rebaseInteractive(worktreePath: string, request: RebaseRequest): Promise<RebaseOutcome> {
  return commands.rebaseInteractive(worktreePath, request);
}

export function rebaseContinue(worktreePath: string): Promise<RebaseOutcome> {
  return commands.rebaseContinue(worktreePath);
}

export function rebaseAbort(worktreePath: string): Promise<void> {
  return commands.rebaseAbort(worktreePath).then(() => undefined);
}

export function gitPushForceWithLease(worktreePath: string): Promise<void> {
  return commands.gitPushForceWithLease(worktreePath).then(() => undefined);
}

export function onRebaseProgress(callback: (event: RebaseProgress) => void): Promise<UnlistenFn> {
  return listen<RebaseProgress>("rebase:progress", (event) => callback(event.payload));
}
