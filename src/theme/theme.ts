export type ThemeMode = "system" | "light" | "dark";
export type Density = "compact" | "default" | "comfy";
export type TextSize = "default" | "large";

export interface ThemeSettings {
  mode: ThemeMode;
  accentHue: number;
  baseHue: number;
  textSize: TextSize;
  density: Density;
}

export const DEFAULT_THEME: ThemeSettings = {
  mode: "dark",
  accentHue: 250,
  baseHue: 265,
  textSize: "default",
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
  root.dataset.density = s.density;
  if (s.textSize === "large") root.dataset.text = "large";
  else delete root.dataset.text;
}
