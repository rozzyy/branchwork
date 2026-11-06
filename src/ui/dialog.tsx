import { useEffect, useRef } from "react";
import { create } from "zustand";
import { t } from "../i18n/t";

export interface AskOptions {
  title: string;
  body?: string;
  ok?: string;
  danger?: boolean;
  icon?: string;
  input?: string; // when set, the dialog shows a text field prefilled with this value
  placeholder?: string;
  meta?: string; // monospace detail block, e.g. list of files
}

export type AskResult = string | true | null;

interface DialogStore {
  current: (AskOptions & { resolve(v: AskResult): void }) | null;
}

export const useDialog = create<DialogStore>(() => ({ current: null }));

/** App-styled replacement for confirm()/prompt(). Resolves true (confirm), the input string, or null (cancel). */
export function ask(o: AskOptions): Promise<AskResult> {
  useDialog.getState().current?.resolve(null);
  return new Promise((resolve) => useDialog.setState({ current: { ...o, resolve } }));
}

function finish(v: AskResult) {
  const c = useDialog.getState().current;
  if (!c) return;
  useDialog.setState({ current: null });
  c.resolve(v);
}

export function DialogHost() {
  const c = useDialog((s) => s.current);
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!c) return;
    if (c.input !== undefined) { inputRef.current?.focus(); inputRef.current?.select(); }
    else okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); finish(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [c]);

  if (!c) return null;
  const confirm = () => finish(c.input !== undefined ? inputRef.current?.value.trim() || null : true);

  return (
    <div className="dlg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) finish(null); }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <div className={"dlg-ic" + (c.danger ? " danger" : "")} aria-hidden>{c.icon ?? (c.danger ? "⚠" : "?")}</div>
        <h3 id="dlg-title">{c.title}</h3>
        {c.body && <p>{c.body}</p>}
        {c.meta && <pre className="dlg-meta">{c.meta}</pre>}
        {c.input !== undefined && (
          <input
            ref={inputRef}
            className="input"
            defaultValue={c.input}
            placeholder={c.placeholder}
            onKeyDown={(e) => { if (e.key === "Enter") confirm(); }}
          />
        )}
        <div className="dlg-actions">
          <button className="btn" onClick={() => finish(null)}>{t("dialog.cancel")}</button>
          <button ref={okRef} className={"btn " + (c.danger ? "danger" : "primary")} onClick={confirm}>{c.ok ?? t("dialog.ok")}</button>
        </div>
      </div>
    </div>
  );
}
