import { commands, type CheckoutTarget } from "./bindings";

export type { CheckoutTarget };

/** Each undoable write resolves to whether its oplog entry can be undone. */
export function gitCheckout(worktreePath: string, target: CheckoutTarget): Promise<boolean> {
  return commands.gitCheckout(worktreePath, target);
}

export function gitBranchCreate(worktreePath: string, name: string, startSha: string, checkout: boolean): Promise<void> {
  return commands.gitBranchCreate(worktreePath, name, startSha, checkout).then(() => undefined);
}

export function gitCherryPick(worktreePath: string, sha: string): Promise<boolean> {
  return commands.gitCherryPick(worktreePath, sha);
}

export function gitRevert(worktreePath: string, sha: string): Promise<boolean> {
  return commands.gitRevert(worktreePath, sha);
}
