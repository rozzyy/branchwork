import { useEffect } from "react";
import { useStage } from "../state/stage";
import { usePalette } from "../palette/store";
import { useDialog } from "../ui/dialog";
import { useSidebar } from "../state/sidebar";
import { useDock } from "../terminal/dock";
import { useSettings } from "../state/settings";
import { useShortcutSheet } from "../shell/ShortcutSheet";
import { NAV_SCREENS } from "../screens/registry";
import type { FocusDir } from "../stage/stageModel";
import { openNewWindow } from "../state/windows";

const ARROW_DIRS: Record<string, FocusDir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

export function isTyping(el: Element | null): boolean {
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el as HTMLElement).isContentEditable);
}

/** Returns true when the key was handled (caller should preventDefault). Spec §6.1.6. */
export function handleGlobalKey(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey && !e.shiftKey && /^[1-7]$/.test(e.key)) { useStage.getState().go(NAV_SCREENS[Number(e.key) - 1]); return true; }
  if (mod && e.shiftKey && !e.altKey && e.code === "KeyN") { if (!e.repeat) void openNewWindow(); return true; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === "k") { usePalette.getState().toggle(); return true; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === "b") { useSidebar.getState().toggle(); return true; }
  // M9 split keys: ⌘\ right, ⌘⇧\ below, ⌘⌥\ close the focused pane.
  if (mod && e.code === "Backslash") {
    const stage = useStage.getState();
    if (e.altKey) stage.closeFocused();
    else stage.splitFocused(e.shiftKey ? "bottom" : "right");
    return true;
  }
  // ⌘⌥ arrows move focus between stage panes. While the keyboard is inside
  // the Terminal screen, its own handler moves between terminal panes (it
  // listens for events from inside `.term-screen` only), so exactly one acts.
  if (mod && e.altKey && !e.shiftKey && e.key in ARROW_DIRS) {
    const stage = useStage.getState();
    if (stage.panes.length < 2 || document.activeElement?.closest(".term-screen")) return false;
    stage.moveFocus(ARROW_DIRS[e.key]);
    return true;
  }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "g") { useStage.getState().go("changes"); return true; }
  if (e.ctrlKey && !e.metaKey && e.code === "Backquote") { useDock.getState().toggle(); return true; }
  if (mod || e.altKey || isTyping(document.activeElement)) return false;
  if (usePalette.getState().open || useDialog.getState().current) return false;
  if (e.key === "?" ) { useShortcutSheet.getState().show(); return true; }
  const n = Number(e.key);
  if (useSettings.getState().singleKeyShortcuts && Number.isInteger(n) && n >= 1 && n <= 7) { useStage.getState().go(NAV_SCREENS[n - 1]); return true; }
  return false;
}

export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (handleGlobalKey(e)) e.preventDefault(); };
    const onPalette = () => usePalette.getState().show();
    window.addEventListener("keydown", onKey);
    window.addEventListener("bw:palette", onPalette);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("bw:palette", onPalette);
    };
  }, []);
}
