import { applyTheme, DEFAULT_THEME, resolveMode } from "./theme";
import { useSettings } from "../state/settings";

describe("resolveMode", () => {
  it("follows the system for 'system'", () => {
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
  });
  it("keeps explicit modes", () => {
    expect(resolveMode("light", true)).toBe("light");
  });
});

describe("applyTheme", () => {
  it("writes theme attributes and token inputs to the root element", () => {
    const root = document.createElement("div");
    applyTheme({ ...DEFAULT_THEME, mode: "light", accentHue: 25, density: "compact" }, root, true);
    expect(root.dataset.theme).toBe("light");
    expect(root.style.getPropertyValue("--ah")).toBe("25");
    expect(root.dataset.density).toBe("compact");
  });

  it("applies large text size", () => {
    const root = document.createElement("div");
    applyTheme({ ...DEFAULT_THEME, textSize: "large" }, root, true);
    expect(root.dataset.text).toBe("large");
  });

  it("removes the large text size attribute for the default size", () => {
    const root = document.createElement("div");
    root.dataset.text = "large";
    applyTheme({ ...DEFAULT_THEME, textSize: "default" }, root, true);
    expect(root.dataset.text).toBeUndefined();
  });

  it("ignores legacy contrast and transparency settings", async () => {
    localStorage.clear();
    localStorage.setItem("bw:theme", JSON.stringify({ contrast: 1.4, reduceTransparency: true }));
    useSettings.setState({ theme: DEFAULT_THEME, loaded: false });
    await useSettings.getState().load();
    const theme = useSettings.getState().theme;
    expect(theme).not.toHaveProperty("contrast");
    expect(theme).not.toHaveProperty("reduceTransparency");
    expect(theme.textSize).toBe("default");
    expect(document.documentElement.hasAttribute("data-solid")).toBe(false);
  });
});
