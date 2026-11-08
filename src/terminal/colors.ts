// oklch() → sRGB conversion for xterm.js, which cannot parse oklch() theme
// colors itself (black pane, invisible text in light mode, while dark values
// happen to look right). Pure math, no DOM dependency, so it behaves
// identically in every engine and is unit-testable.

function parseComponent(text: string, scale: number): number | null {
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(%|deg|rad|turn)?$/.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2] ?? "";
  if (!Number.isFinite(value)) return null;
  if (unit === "%") return (value / 100) * scale;
  if (unit === "rad") return value * (180 / Math.PI);
  if (unit === "turn") return value * 360;
  return value; // plain number or degrees
}

/** Convert `oklch(L C H [/ A])` to an `rgb()`/`rgba()` string. Null when not parseable. */
export function oklchToRgb(input: string): string | null {
  const match = /^\s*oklch\(\s*([^)]+?)\s*\)\s*$/.exec(input);
  if (!match) return null;
  const [colorPart, alphaPart] = match[1].split("/");
  if (alphaPart !== undefined && colorPart === undefined) return null;
  const parts = colorPart.trim().split(/\s+/);
  if (parts.length !== 3 || parts.some((part) => part.toLowerCase() === "none")) return null;
  const [lText, cText, hText] = parts;
  // Percentages are defined only for lightness and alpha here; chroma
  // percentages are deliberately rejected so a wrong scale can never silently
  // turn a bright color black (or vice versa).
  const l = parseComponent(lText, 1);
  const c = cText.includes("%") ? null : parseComponent(cText, 1);
  const h = parseComponent(hText, 1);
  const alpha = alphaPart === undefined ? 1 : parseComponent(alphaPart, 1);
  if (l === null || c === null || h === null || alpha === null) return null;

  // oklch → oklab → linear sRGB (CSS Color 4 matrices).
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);
  const lCube = Math.pow(l + 0.3963377774 * a + 0.2158037573 * b, 3);
  const mCube = Math.pow(l - 0.1055613458 * a - 0.0638541728 * b, 3);
  const sCube = Math.pow(l - 0.0894841775 * a - 1.291485548 * b, 3);
  const toGamma = (v: number): number => {
    const clamped = Math.min(1, Math.max(0, v));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  };
  const r = Math.round(toGamma(4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube) * 255);
  const g = Math.round(toGamma(-1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube) * 255);
  const blue = Math.round(
    toGamma(-0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube) * 255,
  );
  if (alpha >= 1) return `rgb(${r}, ${g}, ${blue})`;
  return `rgba(${r}, ${g}, ${blue}, ${Math.round(alpha * 100) / 100})`;
}

/** Pass oklch() theme colors through the converter; everything else goes to xterm untouched. */
export function resolveThemeColor(value: string): string {
  if (!value) return value;
  return oklchToRgb(value) ?? value;
}
