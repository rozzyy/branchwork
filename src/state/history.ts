import { create } from "zustand";
import type { HistoryMode } from "../screens/registry";
import { useStage } from "./stage";
import { useFiles } from "./files";

interface HistoryStore {
  mode: HistoryMode;
  file: { path: string; line?: number } | null;
  setMode(mode: HistoryMode): void;
}

export const useHistory = create<HistoryStore>((set) => ({
  mode: "graph",
  file: null,
  setMode: (mode) => set({ mode }),
}));

export function openHistory(mode: HistoryMode, file?: { path: string; line?: number }): void {
  if (file) useFiles.getState().openFile(file.path);
  useHistory.setState({ mode, file: file ?? null });
  useStage.getState().go("history");
}
