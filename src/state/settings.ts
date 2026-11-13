import { create } from "zustand";
import { applyTheme, DEFAULT_THEME, prefersDark, resolveMode, type ThemeSettings } from "../theme/theme";
import { loadSetting, saveSetting } from "../ipc/settings";
import { syncNativeTheme } from "../theme/native";

interface SettingsStore {
  theme: ThemeSettings;
  /** Switch to the next profile without asking when a usage limit hits. */
  agentAutoSwitch: boolean;
  /** Token-saving methods for new agent sessions (on by default). */
  agentTokenSaver: boolean;
  /** Commands the RTK-style saver never rewrites (`git diff`, `pytest`, …). */
  agentSaverProtected: string[];
  loaded: boolean;
  setTheme(patch: Partial<ThemeSettings>): void;
  /** Flip between dark and light, resolving `system` against the OS preference. */
  toggleTheme(): void;
  setAgentAutoSwitch(on: boolean): void;
  setAgentTokenSaver(on: boolean): void;
  setAgentSaverProtected(list: string[]): void;
  load(): Promise<void>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  theme: DEFAULT_THEME,
  agentAutoSwitch: true,
  agentTokenSaver: true,
  agentSaverProtected: [],
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
  setAgentTokenSaver(on) {
    if (get().agentTokenSaver === on) return;
    set({ agentTokenSaver: on });
    void saveSetting("agentTokenSaver", on);
  },
  setAgentSaverProtected(list) {
    const clean = [...new Set(list.map((entry) => entry.trim()).filter(Boolean))];
    if (clean.join(",") === get().agentSaverProtected.join(",")) return;
    set({ agentSaverProtected: clean });
    void saveSetting("agentSaverProtected", clean);
  },
  async load() {
    const [savedTheme, savedAutoSwitch, savedSaver, savedProtected] = await Promise.all([
      loadSetting<Partial<ThemeSettings>>("theme"),
      loadSetting<boolean>("agentAutoSwitch"),
      loadSetting<boolean>("agentTokenSaver"),
      loadSetting<unknown>("agentSaverProtected"),
    ]);
    const theme = { ...DEFAULT_THEME, ...(savedTheme ?? {}) };
    const protectedList = Array.isArray(savedProtected)
      ? savedProtected.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      : [];
    set({
      theme,
      agentAutoSwitch: savedAutoSwitch ?? true,
      agentTokenSaver: typeof savedSaver === "boolean" ? savedSaver : true,
      agentSaverProtected: protectedList,
      loaded: true,
    });
    applyTheme(theme);
    void syncNativeTheme(theme.mode);
  },
}));
