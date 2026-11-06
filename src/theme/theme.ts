export type ThemeMode = "system" | "light" | "dark";
export type Density = "compact" | "default" | "comfy";

export interface ThemeSettings {
  mode: ThemeMode;
  accentHue: number;
  baseHue: number;
  contrast: number;
  reduceTransparency: boolean;
  density: Density;
}

export const DEFAULT_THEME: ThemeSettings = {
  mode: "dark",
  accentHue: 250,
  baseHue: 265,
  contrast: 1,
  reduceTransparency: false,
  density: "default",
};

export const prefersDark = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

export function resolveMode(mode: ThemeMode, systemDark: boolean): "light" | "dark" {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}

export function applyTheme(s: ThemeSettings, root: HTMLElement = document.documentElement, systemDark = prefersDark()): void {
  root.dataset.theme = resolveMode(s.mode, systemDark);
  root.style.setProperty("--ah", String(s.accentHue));
  root.style.setProperty("--bh", String(s.baseHue));
  root.style.setProperty("--k", String(s.contrast));
  root.dataset.density = s.density;
  root.toggleAttribute("data-solid", s.reduceTransparency);
}
