import { applyTheme, DEFAULT_THEME, resolveMode } from "./theme";

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
    applyTheme({ ...DEFAULT_THEME, mode: "light", accentHue: 25, contrast: 1.4, reduceTransparency: true, density: "compact" }, root, true);
    expect(root.dataset.theme).toBe("light");
    expect(root.style.getPropertyValue("--ah")).toBe("25");
    expect(root.style.getPropertyValue("--k")).toBe("1.4");
    expect(root.dataset.density).toBe("compact");
    expect(root.hasAttribute("data-solid")).toBe(true);
  });
});
