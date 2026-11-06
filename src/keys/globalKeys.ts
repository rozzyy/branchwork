import { useEffect } from "react";
import { useStage } from "../state/stage";
import { usePalette } from "../palette/store";
import { useDialog } from "../ui/dialog";
import { NUMBER_KEYS } from "../screens/registry";
import { useSidebar } from "../state/sidebar";

export function isTyping(el: Element | null): boolean {
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el as HTMLElement).isContentEditable);
}

/** Returns true when the key was handled (caller should preventDefault). Spec §6.1.6. */
export function handleGlobalKey(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === "k") { usePalette.getState().toggle(); return true; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === "b") { useSidebar.getState().toggle(); return true; }
  if (mod && e.code === "Backslash") { useStage.getState().toggleSplit(e.shiftKey ? "bottom" : "right"); return true; }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "g") { useStage.getState().go("changes"); return true; }
  if (mod || e.altKey || isTyping(document.activeElement)) return false;
  if (usePalette.getState().open || useDialog.getState().current) return false;
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) { useStage.getState().go(NUMBER_KEYS[n - 1]); return true; }
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
