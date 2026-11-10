import { create } from "zustand";
import { loadSetting, saveSetting } from "../ipc/settings";

interface SidebarStore {
  collapsed: boolean;
  projectRailOpen: boolean;
  toggle(): void;
  toggleProjectRail(): void;
  load(): Promise<void>;
}

let revision = 0;

export const useSidebar = create<SidebarStore>((set, get) => ({
  collapsed: false,
  projectRailOpen: true,
  toggle() {
    revision++;
    const collapsed = !get().collapsed;
    set({ collapsed });
    void saveSetting("sidebar", { collapsed, projectRailOpen: get().projectRailOpen });
  },
  toggleProjectRail() {
    revision++;
    const projectRailOpen = !get().projectRailOpen;
    set({ projectRailOpen });
    void saveSetting("sidebar", { collapsed: get().collapsed, projectRailOpen });
  },
  async load() {
    const loadedAtRevision = revision;
    const s = await loadSetting<{ collapsed?: boolean; projectRailOpen?: boolean }>("sidebar");
    if (revision === loadedAtRevision) {
      set({ collapsed: s?.collapsed === true, projectRailOpen: s?.projectRailOpen !== false });
    }
  },
}));
