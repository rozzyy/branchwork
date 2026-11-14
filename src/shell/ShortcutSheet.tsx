import { create } from "zustand";
import { useEffect, useRef } from "react";
import { t } from "../i18n/t";

interface SheetState { open: boolean; show(): void; hide(): void }
export const useShortcutSheet = create<SheetState>((set) => ({ open:false, show:() => set({open:true}), hide:() => set({open:false}) }));

export function ShortcutSheet() {
  const open = useShortcutSheet((s) => s.open);
  const hide = useShortcutSheet((s) => s.hide);
  const closeRef = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    trigger.current = document.activeElement as HTMLElement;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); hide(); trigger.current?.focus(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, hide]);
  if (!open) return null;
  return <div className="shortcut-backdrop" onMouseDown={(e) => { if(e.target===e.currentTarget){hide();trigger.current?.focus();} }}>
    <section className="shortcut-sheet" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
      <header><h2 id="shortcut-title">{t("shortcuts.title")}</h2><button ref={closeRef} className="icon-btn" aria-label={t("dialog.cancel")} onClick={() => {hide();trigger.current?.focus();}}>×</button></header>
      <dl>{([["⌘1–⌘7", "shortcuts.screens"],["⌘K","shortcuts.palette"],["⌘B","shortcuts.sidebar"],["⌘\\ · ⌘⇧\\","shortcuts.split"],["⌘⌥\\","shortcuts.closePane"],["⌘⌥←↑→↓","shortcuts.paneFocus"],["Ctrl+⇧G","shortcuts.changes"],["Ctrl+`","shortcuts.terminal"],["?","shortcuts.help"]] as const).map(([key,label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{t(label)}</dd></div>)}</dl>
    </section>
  </div>;
}
