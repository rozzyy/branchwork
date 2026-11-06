import { create } from "zustand";

export interface ToastAction { label: string; run(): void; }
export interface Toast { id: number; title: string; detail?: string; icon?: string; action?: ToastAction; }

interface ToastStore {
  toasts: Toast[];
  push(t: Omit<Toast, "id">): number;
  dismiss(id: number): void;
}

let seq = 0;

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  push(t) {
    const id = ++seq;
    set({ toasts: [...get().toasts, { ...t, id }] });
    setTimeout(() => get().dismiss(id), 4200);
    return id;
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((x) => x.id !== id) });
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
            <button className="btn sm" onClick={() => { x.action!.run(); dismiss(x.id); }}>{x.action.label}</button>
          )}
        </div>
      ))}
    </div>
  );
}
