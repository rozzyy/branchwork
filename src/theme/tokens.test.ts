import css from "./tokens.css?raw";
import { contrastRatio } from "./contrast";

// Pull the (first) `<selector> { ... }` block out of the raw CSS text.
// Declarations inside tokens.css never contain literal `{`/`}`, so a plain
// brace match is enough.
function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`tokens.css: selector not found: ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

// Resolve a custom property's value within a block, substituting the
// user-settable hue variables with the defaults the spec's contrast table
// was measured against (accent hue 250, neutral tint 265).
function tokenValue(cssBlock: string, name: string): string {
  const re = new RegExp(`--${name}\\s*:\\s*([^;]+);`);
  const m = re.exec(cssBlock);
  if (!m) throw new Error(`token --${name} not found`);
  return m[1].trim().replace(/var\(--ah\)/g, "250").replace(/var\(--bh\)/g, "265");
}

const TEXT_ROLES = ["text", "text-2", "text-3", "accent", "success", "warning", "danger", "info", "agent"];

describe("tokens.css", () => {
  const dark = block(":root {");
  const light = block(':root[data-theme="light"] {');

  it("text roles pass AA in both themes", () => {
    for (const role of TEXT_ROLES) {
      const darkSurface = tokenValue(dark, "surface");
      const darkRatio = contrastRatio(tokenValue(dark, role), darkSurface);
      expect(darkRatio, `dark --${role} vs --surface`).toBeGreaterThanOrEqual(4.5);

      const lightSurface = tokenValue(light, "surface");
      const lightRatio = contrastRatio(tokenValue(light, role), lightSurface);
      expect(lightRatio, `light --${role} vs --surface`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("no blanket square corners or hidden scrollbars", () => {
    expect(css).not.toContain("border-radius: 0 !important");
    expect(css).not.toContain("scrollbar-width: none");
    expect(css).not.toContain("::-webkit-scrollbar { display: none");
  });

  it("focus ring is defined", () => {
    expect(css).toContain(":focus-visible");
    expect(css).toContain("--focus");
  });

  it("diff tints are re-themed under light, not left at dark values", () => {
    const darkAdd = tokenValue(dark, "diff-add");
    const darkDel = tokenValue(dark, "diff-del");
    // tokenValue throws if the token is missing from the block, so these
    // two calls alone assert --diff-add/--diff-del are declared under
    // :root[data-theme="light"] (not just inherited from the dark block).
    const lightAdd = tokenValue(light, "diff-add");
    const lightDel = tokenValue(light, "diff-del");
    expect(lightAdd).not.toBe(darkAdd);
    expect(lightDel).not.toBe(darkDel);
  });
});

describe("contrastRatio", () => {
  it("white on black is ~21:1", () => {
    expect(contrastRatio("oklch(1 0 0)", "oklch(0 0 0)")).toBeCloseTo(21, 0);
    expect(Math.abs(contrastRatio("oklch(1 0 0)", "oklch(0 0 0)") - 21)).toBeLessThanOrEqual(0.1);
  });

  it("equal colors have a ratio of 1", () => {
    expect(contrastRatio("oklch(.5 .1 200)", "oklch(.5 .1 200)")).toBeCloseTo(1, 5);
  });
});
