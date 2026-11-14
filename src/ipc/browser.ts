// Typed wrappers for the Browser screen's native tab webviews (M11).
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "./bindings";

export const browserAvailable = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserStateEvent {
  tabId: string;
  url: string;
  title: string | null;
  loading: boolean | null;
}

export const browserOpen = (tabId: string, url: string, b: Bounds) =>
  commands.browserOpen(tabId, url, b.x, b.y, b.width, b.height);
export const browserSetBounds = (tabId: string, b: Bounds) =>
  commands.browserSetBounds(tabId, b.x, b.y, b.width, b.height);
export const browserShow = (tabId: string, visible: boolean) => commands.browserShow(tabId, visible);
export const browserNavigate = (tabId: string, url: string) => commands.browserNavigate(tabId, url);
export const browserGo = (tabId: string, action: "back" | "forward" | "reload") => commands.browserGo(tabId, action);
export const browserClose = (tabId: string) => commands.browserClose(tabId);
/** Close every browser webview of this window (stale after an app reload). */
export const browserCloseAll = () => commands.browserCloseAll();

/**
 * Page load / title updates for this window's browser tabs. Listening on the
 * current window (not the global target) receives only events Rust sent to
 * this window, never another window's tab URLs.
 */
export function onBrowserState(callback: (event: BrowserStateEvent) => void): Promise<UnlistenFn> {
  return getCurrentWindow().listen<BrowserStateEvent>("browser:state", (event) => callback(event.payload));
}
