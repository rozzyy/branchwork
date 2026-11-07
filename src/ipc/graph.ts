import {
  commands,
  type GraphCommitDetail,
  type GraphCommit_Serialize,
  type GraphWorktreeHead_Serialize,
  type WipSummary_Serialize,
  type GraphPage_Serialize,
} from "./bindings";

export type { GraphRef, GraphRefKind, GraphNode, GraphEdge, GraphCommitDetail } from "./bindings";
export type GraphWorktreeHead = GraphWorktreeHead_Serialize;
export type GraphCommit = GraphCommit_Serialize;
export type WipSummary = WipSummary_Serialize;
export type GraphPage = GraphPage_Serialize;

export function readGraphPage(
  projectId: string,
  worktreePath: string,
  page: number,
): Promise<GraphPage> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Reading the commit graph requires the desktop app"));
  }
  return commands.logGraph(projectId, worktreePath, page);
}

export function readGraphCommitDetail(
  projectId: string,
  worktreePath: string,
  sha: string,
): Promise<GraphCommitDetail> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Reading commit details requires the desktop app"));
  }
  return commands.graphCommitDetail(projectId, worktreePath, sha);
}
