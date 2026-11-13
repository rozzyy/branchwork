import { commands, type PublishOwner, type PublishRequest, type PublishResult_Serialize } from "./bindings";

export type { PublishOwner, PublishRequest };
export type PublishResult = PublishResult_Serialize;

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Whether the worktree has an `origin` remote of any host. */
export function gitHasOrigin(worktreePath: string): Promise<boolean> {
  if (!inTauri()) return Promise.resolve(true);
  return commands.gitHasOrigin(worktreePath);
}

/** The account's login and organizations it can create repositories in. */
export function ghPublishOwners(account: string): Promise<PublishOwner[]> {
  if (!inTauri()) return Promise.reject(new Error("Publishing requires the desktop app"));
  return commands.ghPublishOwners(account);
}

/** Creates the GitHub repository, sets `origin`, and pushes the current branch. */
export function ghRepoPublish(worktreePath: string, request: PublishRequest): Promise<PublishResult> {
  if (!inTauri()) return Promise.reject(new Error("Publishing requires the desktop app"));
  return commands.ghRepoPublish(worktreePath, request);
}
