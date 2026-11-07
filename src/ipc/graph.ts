import { invoke } from "@tauri-apps/api/core";

export type GraphRefKind = "localBranch" | "remoteBranch" | "tag";

export interface GraphRef {
  name: string;
  kind: GraphRefKind;
}

export interface GraphNode {
  lane: number;
}

export interface GraphEdge {
  fromLane: number;
  toLane: number;
  parentIndex: number;
}

export interface GraphWorktreeHead {
  path: string;
  branch: string | null;
}

export interface GraphCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  lane: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  parentLanes: number[];
  refs: GraphRef[];
  worktreeHeads: GraphWorktreeHead[];
  authorName: string | null;
  authorEmail: string | null;
  message: string;
  timestamp: number;
  timezoneOffsetMinutes: number;
}

export interface WipSummary {
  worktreePath: string;
  head: string | null;
  branch: string | null;
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  conflictedFiles: string[];
}

export interface GraphPage {
  page: number;
  pageSize: number;
  totalCommits: number | null;
  hasMore: boolean;
  commits: GraphCommit[];
  wip: WipSummary;
  userEmail: string | null;
}

export interface GraphCommitDetail {
  sha: string;
  changedPaths: string[];
}

export function readGraphPage(
  projectId: string,
  worktreePath: string,
  page: number,
): Promise<GraphPage> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Reading the commit graph requires the desktop app"));
  }
  return invoke("log_graph", { projectId, worktreePath, page });
}

export function readGraphCommitDetail(
  projectId: string,
  worktreePath: string,
  sha: string,
): Promise<GraphCommitDetail> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Reading commit details requires the desktop app"));
  }
  return invoke("graph_commit_detail", { projectId, worktreePath, sha });
}
