import type { ThemeMode } from "./theme";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Make the native window appearance (and its vibrancy material) follow the app theme. "system" = follow macOS. */
export async function syncNativeTheme(mode: ThemeMode): Promise<void> {
  if (!inTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTheme(mode === "system" ? null : mode);
}
