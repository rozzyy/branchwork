import { create } from "zustand";
import { applyTheme, DEFAULT_THEME, prefersDark, resolveMode, type ThemeSettings } from "../theme/theme";
import { loadSetting, saveSetting } from "../ipc/settings";
import { syncNativeTheme } from "../theme/native";

interface SettingsStore {
  theme: ThemeSettings;
  /** Switch to the next profile without asking when a usage limit hits. */
  agentAutoSwitch: boolean;
  loaded: boolean;
  setTheme(patch: Partial<ThemeSettings>): void;
  /** Flip between dark and light, resolving `system` against the OS preference. */
  toggleTheme(): void;
  setAgentAutoSwitch(on: boolean): void;
  load(): Promise<void>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  theme: DEFAULT_THEME,
  agentAutoSwitch: true,
  loaded: false,
  setTheme(patch) {
    const theme = { ...get().theme, ...patch };
    set({ theme });
    applyTheme(theme);
    void saveSetting("theme", theme);
    void syncNativeTheme(theme.mode);
  },
  toggleTheme() {
    const { theme } = get();
    get().setTheme({ mode: resolveMode(theme.mode, prefersDark()) === "dark" ? "light" : "dark" });
  },
  setAgentAutoSwitch(on) {
    if (get().agentAutoSwitch === on) return;
    set({ agentAutoSwitch: on });
    void saveSetting("agentAutoSwitch", on);
  },
  async load() {
    const [savedTheme, savedAutoSwitch] = await Promise.all([
      loadSetting<Partial<ThemeSettings>>("theme"),
      loadSetting<boolean>("agentAutoSwitch"),
    ]);
    const theme = { ...DEFAULT_THEME, ...(savedTheme ?? {}) };
    set({ theme, agentAutoSwitch: savedAutoSwitch ?? true, loaded: true });
    applyTheme(theme);
    void syncNativeTheme(theme.mode);
  },
}));
