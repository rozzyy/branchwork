import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemeMode } from "./theme";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Make the native window appearance (and its vibrancy material) follow the app theme. "system" = follow macOS. */
export async function syncNativeTheme(mode: ThemeMode): Promise<void> {
  if (!inTauri()) return;
  try {
    await getCurrentWindow().setTheme(mode === "system" ? null : mode);
  } catch {
    // Best-effort: a missing window handle (e.g. a mocked IPC in browser tests)
    // only skips the native appearance; the in-app theme is already applied.
  }
}
