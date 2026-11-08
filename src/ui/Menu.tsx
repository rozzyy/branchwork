import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | { kind: "item"; label: string; icon?: string; kbd?: string; danger?: boolean; disabled?: boolean; title?: string; onSelect(): void; extra?: ReactNode }
  | { kind: "separator" }
  | { kind: "header"; label: string }
  | { kind: "note"; label: string };

/** Fires to close any open Menu (used by nested controls that stop propagation). */
export const closeMenus = () => window.dispatchEvent(new Event("bw:menu-close"));

export function Menu({ x, y, items, onClose, width = 240 }: { x: number; y: number; items: MenuItem[]; onClose(): void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const timer = setTimeout(() => window.addEventListener("mousedown", down)); // skip the opening click
    window.addEventListener("keydown", key);
    window.addEventListener("bw:menu-close", onClose);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
      window.removeEventListener("bw:menu-close", onClose);
    };
  }, [onClose]);
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - 30 * items.length - 16));
  return createPortal(
    <div ref={ref} className="menu" role="menu" style={{ left, top, minWidth: width }}>
      {items.map((it, i) =>
        it.kind === "separator" ? <hr key={i} /> :
        it.kind === "header" ? <div key={i} className="menu-h">{it.label}</div> :
        it.kind === "note" ? <div key={i} className="menu-note">{it.label}</div> : (
          <button
            key={i}
            role="menuitem"
            className={"menu-item" + (it.danger ? " danger" : "")}
            disabled={it.disabled}
            title={it.title}
            onClick={() => { onClose(); it.onSelect(); }}
          >
            {it.icon && <span className="menu-ic" aria-hidden>{it.icon}</span>}
            <span className="menu-label">{it.label}</span>
            {it.extra}
            {it.kbd && <kbd className="kbd">{it.kbd}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
