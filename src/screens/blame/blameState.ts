import { create } from "zustand";

interface BlameUiState {
  selectedLine: number | null;
  selectLine(line: number | null): void;
}

export const useBlameUi = create<BlameUiState>((set) => ({
  selectedLine: null,
  selectLine: (selectedLine) => set({ selectedLine }),
}));
