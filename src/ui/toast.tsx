import type { ReactNode } from "react";
import { create } from "zustand";
import { t } from "../i18n/t";

export interface ToastAction { label: string; run(): void; enabled?: boolean; undo?: boolean; }
/** `details` is long diagnostic text (e.g. git stderr) behind a "Show details" disclosure. */
export interface Toast { id: number; title: string; detail?: string; details?: string; icon?: ReactNode; action?: ToastAction; }

interface ToastStore {
  toasts: Toast[];
  lastUndoable: boolean | null;
  push(t: Omit<Toast, "id">): number;
  dismiss(id: number): void;
  setUndoable(undoable: boolean): void;
}

let seq = 0;
const TOAST_MS = 4200;
// Toasts with expandable details stay longer so there is time to open and read them.
const DETAILS_TOAST_MS = 12000;

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  lastUndoable: null,
  push(input) {
    const id = ++seq;
    const state = get();
    const action = input.action?.undo && input.action.enabled === undefined && state.lastUndoable !== null
      ? { ...input.action, enabled: state.lastUndoable }
      : input.action;
    set({ toasts: [...state.toasts, { ...input, action, id }] });
    setTimeout(() => get().dismiss(id), input.details ? DETAILS_TOAST_MS : TOAST_MS);
    return id;
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((x) => x.id !== id) });
  },
  setUndoable(undoable) {
    const toasts = get().toasts.map((item) =>
      item.action?.undo
        ? { ...item, action: { ...item.action, enabled: undoable } }
        : item,
    );
    set({ toasts, lastUndoable: undoable });
  },
}));

export const toast = (input: Omit<Toast, "id">): number => useToasts.getState().push(input);

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className="toast" role="status">
          <div className="toast-ic" aria-hidden>{x.icon ?? "✓"}</div>
          <div className="toast-body">
            <div>{x.title}</div>
            {x.detail && <small>{x.detail}</small>}
            {x.details && (
              <details className="toast-details">
                <summary>{t("toast.showDetails")}</summary>
                <pre>{x.details}</pre>
              </details>
            )}
          </div>
          {x.action && (
            <button className="btn sm" disabled={x.action.enabled === false} onClick={() => { x.action!.run(); dismiss(x.id); }}>{x.action.label}</button>
          )}
        </div>
      ))}
    </div>
  );
}
