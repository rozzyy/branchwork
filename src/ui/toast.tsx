import { create } from "zustand";

export interface ToastAction { label: string; run(): void; enabled?: boolean; undo?: boolean; }
export interface Toast { id: number; title: string; detail?: string; icon?: string; action?: ToastAction; }

interface ToastStore {
  toasts: Toast[];
  lastUndoable: boolean | null;
  push(t: Omit<Toast, "id">): number;
  dismiss(id: number): void;
  setUndoable(undoable: boolean): void;
}

let seq = 0;

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  lastUndoable: null,
  push(t) {
    const id = ++seq;
    const state = get();
    const action = t.action?.undo && t.action.enabled === undefined && state.lastUndoable !== null
      ? { ...t.action, enabled: state.lastUndoable }
      : t.action;
    set({ toasts: [...state.toasts, { ...t, action, id }] });
    setTimeout(() => get().dismiss(id), 4200);
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

export const toast = (t: Omit<Toast, "id">): number => useToasts.getState().push(t);

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
          </div>
          {x.action && (
            <button className="btn sm" disabled={x.action.enabled === false} onClick={() => { x.action!.run(); dismiss(x.id); }}>{x.action.label}</button>
          )}
        </div>
      ))}
    </div>
  );
}
