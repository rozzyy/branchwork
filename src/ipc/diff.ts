import { commands, type DiffArea, type DiffModel } from "./bindings";

export type {
  DiffArea,
  DiffLine,
  DiffLineKind,
  DiffModel,
  Hunk,
  IntraKind,
  IntraSpan,
} from "./bindings";

export function readDiff(
  worktreePath: string,
  path: string,
  area: DiffArea,
): Promise<DiffModel> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Reading file diffs requires the desktop app"));
  }
  return commands.diffFile(worktreePath, path, area);
}
