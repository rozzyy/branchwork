import { invoke } from "@tauri-apps/api/core";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function loadSetting<T>(key: string): Promise<T | null> {
  try {
    const raw = inTauri() ? await invoke<string | null>("settings_get", { key }) : localStorage.getItem("bw:" + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // corrupt or unreadable settings fall back to defaults
  }
}

export async function saveSetting(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  if (inTauri()) await invoke("settings_set", { key, value: json });
  else localStorage.setItem("bw:" + key, json);
}
