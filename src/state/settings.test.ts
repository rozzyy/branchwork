import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { useSettings } from "./settings";
import { DEFAULT_THEME } from "../theme/theme";

beforeEach(() => {
  localStorage.clear();
  useSettings.setState({ theme: DEFAULT_THEME, loaded: false });
});

afterEach(() => {
  clearMocks();
});

it("flips between dark and light", () => {
  useSettings.setState({ theme: { ...DEFAULT_THEME, mode: "dark" } });
  useSettings.getState().toggleTheme();
  expect(useSettings.getState().theme.mode).toBe("light");
  useSettings.getState().toggleTheme();
  expect(useSettings.getState().theme.mode).toBe("dark");
});

it("persists theme changes and restores them on load", async () => {
  useSettings.getState().setTheme({ mode: "light", accentHue: 25 });
  expect(document.documentElement.dataset.theme).toBe("light");
  await new Promise((r) => setTimeout(r, 0));
  useSettings.setState({ theme: DEFAULT_THEME, loaded: false });
  await useSettings.getState().load();
  expect(useSettings.getState().theme.accentHue).toBe(25);
  expect(useSettings.getState().loaded).toBe(true);
});

it("fills missing fields from defaults when loading older settings", async () => {
  localStorage.setItem("bw:theme", JSON.stringify({ mode: "light" }));
  await useSettings.getState().load();
  expect(useSettings.getState().theme).toEqual({ ...DEFAULT_THEME, mode: "light" });
});

it("defaults auto-switch on and persists the toggle", async () => {
  useSettings.setState({ agentAutoSwitch: true });
  expect(useSettings.getState().agentAutoSwitch).toBe(true);
  useSettings.getState().setAgentAutoSwitch(false);
  expect(useSettings.getState().agentAutoSwitch).toBe(false);
  expect(localStorage.getItem("bw:agentAutoSwitch")).toBe("false");
  useSettings.setState({ agentAutoSwitch: true, loaded: false });
  await useSettings.getState().load();
  expect(useSettings.getState().agentAutoSwitch).toBe(false);
});

// Runs last: mockWindows/mockIPC leave window.__TAURI_INTERNALS__ present for the
// rest of this file's jsdom instance even after clearMocks (it only deletes the
// properties on it), which would make earlier tests take the Tauri branch too.
it("round-trips theme through the Tauri invoke branch", async () => {
  mockWindows("main");
  const store = new Map<string, string>();
  const calls: Array<{ cmd: string; payload: unknown }> = [];
  mockIPC((cmd, payload) => {
    calls.push({ cmd, payload });
    if (cmd === "settings_set") {
      const { key, value } = payload as { key: string; value: string };
      store.set(key, value);
      return null;
    }
    if (cmd === "settings_get") {
      const { key } = payload as { key: string };
      return store.get(key) ?? null;
    }
    return null; // e.g. plugin:window|set_theme
  });

  useSettings.getState().setTheme({ mode: "light" });
  expect(calls).toContainEqual({
    cmd: "settings_set",
    payload: { key: "theme", value: JSON.stringify({ ...DEFAULT_THEME, mode: "light" }) },
  });
  await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget syncNativeTheme settle

  useSettings.setState({ theme: DEFAULT_THEME, loaded: false });
  await useSettings.getState().load();
  await new Promise((r) => setTimeout(r, 0));
  expect(useSettings.getState().theme.mode).toBe("light");
});
