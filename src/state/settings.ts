import { create } from "zustand";
import { applyTheme, DEFAULT_THEME, type ThemeSettings } from "../theme/theme";
import { loadSetting, saveSetting } from "../ipc/settings";
import { syncNativeTheme } from "../theme/native";

interface SettingsStore {
  theme: ThemeSettings;
  loaded: boolean;
  setTheme(patch: Partial<ThemeSettings>): void;
  load(): Promise<void>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  theme: DEFAULT_THEME,
  loaded: false,
  setTheme(patch) {
    const theme = { ...get().theme, ...patch };
    set({ theme });
    applyTheme(theme);
    void saveSetting("theme", theme);
    void syncNativeTheme(theme.mode);
  },
  async load() {
    const saved = await loadSetting<Partial<ThemeSettings>>("theme");
    const theme = { ...DEFAULT_THEME, ...(saved ?? {}) };
    set({ theme, loaded: true });
    applyTheme(theme);
    void syncNativeTheme(theme.mode);
  },
}));
