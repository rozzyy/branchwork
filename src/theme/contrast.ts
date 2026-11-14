// OKLCH -> linear sRGB -> WCAG relative luminance -> contrast ratio.
// Conversion matrices are Björn Ottosson's OKLab <-> linear sRGB constants
// (https://bottosson.github.io/posts/oklab/), which is what CSS `oklch()`
// colors are defined in terms of.

interface Oklch {
  l: number;
  c: number;
  h: number;
}

const OKLCH_RE = /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([-\d.]+)(?:\s*\/\s*[\d.]+%?)?\s*\)$/i;

/**
 * Parses an `oklch(L C H)` (optionally `oklch(L C H / A)`) color string.
 * `var(--ah)` / `var(--bh)` hue references must already be substituted
 * with numeric values by the caller — this function only understands
 * literal numbers.
 */
function parseOklch(input: string): Oklch {
  const m = OKLCH_RE.exec(input.trim());
  if (!m) throw new Error(`contrastRatio: not an oklch() color: "${input}"`);
  const l = m[1].endsWith("%") ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
  const c = m[2].endsWith("%") ? (parseFloat(m[2]) / 100) * 0.4 : parseFloat(m[2]);
  const h = parseFloat(m[3]);
  return { l, c, h };
}

function oklchToLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;

  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;

  return [r, g, bl];
}

function relativeLuminance(color: Oklch): number {
  const [r, g, b] = oklchToLinearSrgb(color);
  // Out-of-gamut oklch() values can produce slightly negative or >1
  // linear components; clamp so luminance stays in a sane range.
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

/**
 * WCAG 2.x contrast ratio between two `oklch(L C H)` color strings
 * (1 = identical luminance, 21 = black vs. white).
 */
export function contrastRatio(a: string, b: string): number {
  const lumA = relativeLuminance(parseOklch(a));
  const lumB = relativeLuminance(parseOklch(b));
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}
