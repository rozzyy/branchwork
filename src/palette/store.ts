import { create } from "zustand";

interface PaletteStore {
  open: boolean;
  query: string;
  show(query?: string): void;
  hide(): void;
  toggle(): void;
  setQuery(q: string): void;
}

export const usePalette = create<PaletteStore>((set, get) => ({
  open: false,
  query: "",
  show: (query = "") => set({ open: true, query }),
  hide: () => set({ open: false, query: "" }),
  toggle: () => (get().open ? get().hide() : get().show()),
  setQuery: (query) => set({ query }),
}));
