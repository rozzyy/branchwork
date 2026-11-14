import { commands } from "./bindings";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Settings that belong to one workspace window (M10). In `main` they keep
 * their plain key (existing data); in a secondary window `ws-<n>` they are
 * stored as `ws-<n>:<key>`. Every other setting is app-wide.
 */
const WINDOW_SCOPED_KEYS = new Set([
  "repos",
  "activeWorktrees",
  "stage",
  "agentSessions",
  "terminalDock",
  "terminalScreen",
  "sidebar",
  "browserTabs",
]);

let label: string | undefined;
/** This webview's window label; "main" outside the desktop app. */
export function windowLabel(): string {
  if (label === undefined) {
    try {
      const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
        .__TAURI_INTERNALS__;
      label = internals?.metadata?.currentWindow?.label ?? "main";
    } catch {
      label = "main";
    }
  }
  return label;
}

/** Storage key for `key` in window `forLabel` (default: this window). */
export function scopedKey(key: string, forLabel = windowLabel()): string {
  return forLabel === "main" || !WINDOW_SCOPED_KEYS.has(key) ? key : `${forLabel}:${key}`;
}

export const isWindowScoped = (key: string) => WINDOW_SCOPED_KEYS.has(key);

type ChangeListener = (key: string) => void;
let notifyChange: ChangeListener | null = null;
/** Hook for windows.ts: called after an app-wide setting is saved here. */
export function onGlobalSettingSaved(listener: ChangeListener | null): void {
  notifyChange = listener;
}

export async function loadSetting<T>(key: string): Promise<T | null> {
  try {
    const stored = scopedKey(key);
    const raw = inTauri() ? await commands.settingsGet(stored) : localStorage.getItem("bw:" + stored);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // corrupt or unreadable settings fall back to defaults
  }
}

export async function saveSetting(key: string, value: unknown, forLabel?: string): Promise<void> {
  const json = JSON.stringify(value);
  const stored = scopedKey(key, forLabel);
  if (inTauri()) await commands.settingsSet(stored, json);
  else localStorage.setItem("bw:" + stored, json);
  if (!WINDOW_SCOPED_KEYS.has(key)) notifyChange?.(key);
}
