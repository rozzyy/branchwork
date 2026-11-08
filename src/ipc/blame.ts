import {
  commands,
  type BlameRequest,
  type BlameResult,
  type FileHistoryEntry,
  type FileHistoryRequest,
} from "./bindings";

export type {
  AgeBucket,
  BlameGroup,
  BlameLine,
  BlameRequest,
  BlameResult,
  FileHistoryEntry,
  FileHistoryRequest,
} from "./bindings";

export function readBlame(
  worktreePath: string,
  path: string,
  options: BlameRequest = { followRenames: false },
): Promise<BlameResult> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Reading blame requires the desktop app"));
  }
  return commands.blame(worktreePath, path, options);
}

export function readFileHistory(
  worktreePath: string,
  path: string,
  options: FileHistoryRequest,
): Promise<FileHistoryEntry[]> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Reading file history requires the desktop app"));
  }
  return commands.fileHistory(worktreePath, path, options);
}
