const styles = Object.entries(import.meta.glob("/src/**/*.css", { eager: true, query: "?raw", import: "default" }))
  .map(([path, value]) => [path, String(value)] as const);

describe("global CSS constraints", () => {
  it("keeps all CSS font sizes at or above 12px", () => {
    for (const [path, css] of styles) {
      for (const match of css.matchAll(/font-size\s*:\s*([\d.]+)px/gi)) {
        expect(Number(match[1]), `${path}: ${match[0]}`).toBeGreaterThanOrEqual(12);
      }
      for (const match of css.matchAll(/font\s*:\s*([\d.]+)px(?:\/[^\s]+)?/gi)) {
        expect(Number(match[1]), `${path}: ${match[0]}`).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it("does not hide scrollbars", () => {
    for (const [path, css] of styles) {
      expect(css, path).not.toMatch(/scrollbar-width\s*:\s*none/i);
      expect(css, path).not.toMatch(/::-webkit-scrollbar\s*\{[^}]*display\s*:\s*none/i);
    }
  });

  it("keeps stage and agent panes square", () => {
    const stage = styles.find(([path]) => path.endsWith("/stage/stage.css"))?.[1] ?? "";
    const agents = styles.find(([path]) => path.endsWith("/screens/agents/agents.css"))?.[1] ?? "";
    expect(stage).toMatch(/\.pane\s*\{[^}]*border-radius:\s*0/);
    expect(agents).toMatch(/\.agent-pane\s*\{[^}]*border-radius:\s*0/);
  });
});
