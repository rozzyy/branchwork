import {
  commands,
  type CompareSummary_Serialize,
  type DiffModel,
} from "./bindings";

export type CompareSummary = CompareSummary_Serialize;
export type CompareFile = CompareSummary["files"][number];

export function readCompareWorktrees(
  a: string,
  b: string,
  includeUncommitted: boolean,
): Promise<CompareSummary> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Comparing worktrees requires the desktop app"));
  }
  return commands.compareWorktrees(a, b, includeUncommitted);
}

export function readCompareFileDiff(
  a: string,
  b: string,
  path: string,
  includeUncommitted: boolean,
): Promise<DiffModel> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Comparing worktrees requires the desktop app"));
  }
  return commands.compareFileDiff(a, b, path, includeUncommitted);
}

export function readComparePatch(
  a: string,
  b: string,
  includeUncommitted: boolean,
): Promise<string> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Comparing worktrees requires the desktop app"));
  }
  return commands.comparePatch(a, b, includeUncommitted);
}

