import { create } from "zustand";
import type { GraphCommit } from "../../ipc/graph";

export type GraphFilter = "all" | "worktrees" | "mine";
export type GraphSelection = { kind: "wip" } | { kind: "commit"; sha: string };

interface GraphUiState {
  filter: GraphFilter;
  selection: GraphSelection;
  selectedCommit: GraphCommit | null;
  setFilter(filter: GraphFilter): void;
  select(selection: GraphSelection): void;
  setSelectedCommit(commit: GraphCommit | null): void;
}

export const useGraphUi = create<GraphUiState>((set) => ({
  filter: "all",
  selection: { kind: "wip" },
  selectedCommit: null,
  setFilter: (filter) => set({ filter }),
  select: (selection) => set({ selection }),
  setSelectedCommit: (selectedCommit) => set({ selectedCommit }),
}));
