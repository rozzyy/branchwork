import { create } from "zustand";
import { loadSetting, saveSetting } from "../ipc/settings";

interface SidebarStore {
  collapsed: boolean;
  toggle(): void;
  load(): Promise<void>;
}

let revision = 0;

export const useSidebar = create<SidebarStore>((set, get) => ({
  collapsed: false,
  toggle() {
    revision++;
    const collapsed = !get().collapsed;
    set({ collapsed });
    void saveSetting("sidebar", { collapsed });
  },
  async load() {
    const loadedAtRevision = revision;
    const s = await loadSetting<{ collapsed?: boolean }>("sidebar");
    if (revision === loadedAtRevision) {
      set({ collapsed: s?.collapsed === true });
    }
  },
}));
