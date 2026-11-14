import css from "./ui.css?raw";
import shellCss from "../shell/shell.css?raw";
import stageCss from "../stage/stage.css?raw";
import changesCss from "../screens/changes/changes.css?raw";
import settingsCss from "../screens/settings/settings.css?raw";

describe("ui.css", () => {
  it("has no text below the spec's 12px floor ('no text below 12px anywhere')", () => {
    // Scans every `font-size: …px` and `font: … Npx …` (shorthand) declaration
    // for a literal px size below 12. Sizes expressed via a design token
    // (e.g. `font-size: var(--fs-meta)`) don't match `\dpx` here at all —
    // tokens.test.ts is what guarantees those resolve to >=12px — so this
    // only catches literal px regressions like the prototype's `.count`
    // (11px) or `.kbd` (11px), which the spec overrides.
    const sizeRe = /font(?:-size)?\s*:\s*[^;]*?(\d+(?:\.\d+)?)px/g;
    const tooSmall: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = sizeRe.exec(css))) {
      if (parseFloat(m[1]) < 12) tooSmall.push(m[0].trim());
    }
    expect(tooSmall).toEqual([]);
  });

  it("uses scalable type tokens in the sidebar, pane headers, Changes, and Settings", () => {
    expect(shellCss).toContain(".worktree-row-meta");
    expect(shellCss).toMatch(/\.worktree-row-meta\s*\{[^}]*font-size:\s*var\(--fs-meta\)/);
    expect(stageCss).toMatch(/\.pane-title\s*\{[^}]*font-size:\s*var\(--fs-title\)/);
    expect(changesCss).toMatch(/\.changes-file-row\s*\{[^}]*font-size:\s*var\(--fs-body\)/);
    expect(settingsCss).toMatch(/\.settings h3\s*\{[^}]*font-size:\s*var\(--fs-meta\)/);
  });

  it("keeps the global double focus ring on keyboard-focused inputs", () => {
    expect(css).toMatch(/\.input\s*\{[^}]*border-radius:\s*var\(--r-control\)/);
    expect(css).toMatch(/\.input\s*\{[^}]*border:\s*1px solid var\(--border-strong\)/);
    expect(css).toMatch(/\.input\s*\{[^}]*background:\s*var\(--bg\)/);
    expect(css).toMatch(/\.input:focus-visible\s*\{[^}]*var\(--focus\)/);
    expect(shellCss).toMatch(/\.group-chip:focus-visible\s*\{[^}]*var\(--focus\)/);
    expect(shellCss).toMatch(/\.search:focus-visible\s*\{[^}]*var\(--focus\)/);
    expect(shellCss).toMatch(/\.dock-toggle:focus-visible[\s\S]*?var\(--focus\)/);
    expect(settingsCss).toMatch(/\.swatch(?:\.on)?:focus-visible\s*\{[^}]*var\(--focus\)/);
  });
});
