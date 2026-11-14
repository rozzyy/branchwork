import type { GraphCommit } from "../../ipc/graph";

/** Returns the loaded commit ancestors for the chosen worktree HEAD. */
export function graphAncestry(commits: GraphCommit[], headSha: string | null): Set<string> | null {
  if (!headSha) return null;
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const ancestry = new Set<string>();
  const stack = [headSha];
  while (stack.length > 0) {
    const sha = stack.pop();
    if (!sha || ancestry.has(sha)) continue;
    ancestry.add(sha);
    stack.push(...(bySha.get(sha)?.parents ?? []));
  }
  return ancestry;
}
