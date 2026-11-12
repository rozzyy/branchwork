import { create } from "zustand";

interface LaunchpadUiState {
  allGroups: boolean;
  refreshRequest: number;
  creatingWorktree: boolean;
  setAllGroups(value: boolean): void;
  requestRefresh(): void;
  setCreatingWorktree(value: boolean): void;
}

export const useLaunchpadUi = create<LaunchpadUiState>((set) => ({
  allGroups: false,
  refreshRequest: 0,
  creatingWorktree: false,
  setAllGroups: (allGroups) => set({ allGroups }),
  requestRefresh: () => set((state) => ({ refreshRequest: state.refreshRequest + 1 })),
  setCreatingWorktree: (creatingWorktree) => set({ creatingWorktree }),
}));
