// Browser tabs (M11), persisted per window (`browserTabs` is window-scoped).
import { create } from "zustand";
import { loadSetting, saveSetting } from "../ipc/settings";

export interface BrowserTab {
  id: string;
  /** Current URL; "" for a new tab that has not loaded anything yet. */
  url: string;
  title: string;
  loading: boolean;
}

interface PersistedTabs {
  tabs?: Array<{ id?: unknown; url?: unknown; title?: unknown }>;
  activeId?: unknown;
}

interface BrowserStore {
  tabs: BrowserTab[];
  activeId: string | null;
  loaded: boolean;
  load(): Promise<void>;
  newTab(url?: string): string;
  closeTab(id: string): void;
  select(id: string): void;
  /** Set a tab's URL (after the address bar resolved it). */
  setUrl(id: string, url: string): void;
  /** Apply a `browser:state` event from the tab's webview. */
  applyState(state: { tabId: string; url: string; title?: string | null; loading?: boolean | null }): void;
}

const MAX_TABS = 20;
let counter = 0;
const nextId = () => `tab-${Date.now().toString(36)}-${(counter += 1)}`;
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9-]{1,40}$/.test(id);
const httpUrl = (url: unknown): url is string => typeof url === "string" && /^https?:\/\//i.test(url) && url.length <= 2048;

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useBrowser = create<BrowserStore>((set, get) => {
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { tabs, activeId } = get();
      void saveSetting("browserTabs", { tabs: tabs.map(({ id, url, title }) => ({ id, url, title })), activeId });
    }, 300);
  };
  const patch = (id: string, change: Partial<BrowserTab>) =>
    set({ tabs: get().tabs.map((tab) => (tab.id === id ? { ...tab, ...change } : tab)) });

  return {
    tabs: [],
    activeId: null,
    loaded: false,
    async load() {
      if (get().loaded) return;
      const saved = await loadSetting<PersistedTabs>("browserTabs");
      const tabs = (Array.isArray(saved?.tabs) ? saved.tabs : [])
        .filter((tab) => validId(tab.id))
        .slice(0, MAX_TABS)
        .map((tab) => ({
          id: tab.id as string,
          url: httpUrl(tab.url) ? tab.url : "",
          title: typeof tab.title === "string" ? tab.title.slice(0, 300) : "",
          loading: false,
        }));
      const activeId = tabs.find((tab) => tab.id === saved?.activeId)?.id ?? tabs[0]?.id ?? null;
      set({ tabs, activeId, loaded: true });
    },
    newTab(url = "") {
      if (get().tabs.length >= MAX_TABS) return get().activeId ?? "";
      const tab: BrowserTab = { id: nextId(), url, title: "", loading: false };
      set({ tabs: [...get().tabs, tab], activeId: tab.id });
      persist();
      return tab.id;
    },
    closeTab(id) {
      const { tabs, activeId } = get();
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;
      const rest = tabs.filter((tab) => tab.id !== id);
      const nextActive = activeId === id ? (rest[index] ?? rest[index - 1])?.id ?? null : activeId;
      set({ tabs: rest, activeId: nextActive });
      persist();
    },
    select(id) {
      if (get().activeId === id || !get().tabs.some((tab) => tab.id === id)) return;
      set({ activeId: id });
      persist();
    },
    setUrl(id, url) {
      if (!httpUrl(url)) return;
      patch(id, { url, loading: true });
      persist();
    },
    applyState({ tabId, url, title, loading }) {
      const tab = get().tabs.find((item) => item.id === tabId);
      if (!tab) return;
      patch(tabId, {
        ...(httpUrl(url) ? { url } : {}),
        ...(typeof title === "string" ? { title: title.slice(0, 300) } : {}),
        ...(typeof loading === "boolean" ? { loading } : {}),
      });
      persist();
    },
  };
});
