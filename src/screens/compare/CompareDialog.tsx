import { useEffect, useMemo, useRef, useState } from "react";
import { readCompareFileDiff, readComparePatch, readCompareWorktrees, type CompareFile } from "../../ipc/compare";
import type { DiffModel } from "../../ipc/bindings";
import { t } from "../../i18n/t";
import { DiffRenderer } from "../../diff/DiffRenderer";
import { useWorktrees } from "../../state/worktrees";
import { toast } from "../../ui/toast";
import "./compare.css";

export interface CompareWorktreeOption { path: string; branch: string }

export function CompareDialog({ open, onClose, options, initialA, initialB }: {
  open: boolean; onClose(): void; options?: CompareWorktreeOption[]; initialA?: string; initialB?: string;
}) {
  const listed = useWorktrees((state) => state.worktrees);
  const choices = useMemo(() => {
    const byPath = new Map<string, CompareWorktreeOption>();
    for (const item of listed) byPath.set(item.path, { path: item.path, branch: item.branch ?? item.path });
    for (const item of options ?? []) byPath.set(item.path, item);
    return [...byPath.values()];
  }, [listed, options]);
  const [a, setA] = useState(initialA ?? "");
  const [b, setB] = useState(initialB ?? "");
  const [includeUncommitted, setIncludeUncommitted] = useState(true);
  const [files, setFiles] = useState<CompareFile[]>([]);
  const [summaryTruncated, setSummaryTruncated] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summaryRevision = useRef(0);
  const diffRevision = useRef(0);
  const first = a || choices[0]?.path || "";
  const second = b || choices.find((item) => item.path !== first)?.path || "";

  useEffect(() => {
    if (!open) return;
    setA(initialA ?? choices[0]?.path ?? "");
    setB(initialB ?? choices.find((item) => item.path !== (initialA ?? choices[0]?.path))?.path ?? "");
    setFiles([]); setSelected(null); setDiff(null); setError(null);
  }, [open, initialA, initialB]);

  useEffect(() => {
    if (!open || !first || !second || first === second) {
      setFiles([]); setDiff(null);
      if (open && first && second && first === second) setError(t("compare.invalidPair"));
      return;
    }
    const id = ++summaryRevision.current;
    setBusy(true); setError(null); setSelected(null); setDiff(null); setSummaryTruncated(false);
    void readCompareWorktrees(first, second, includeUncommitted).then((summary) => {
      if (summaryRevision.current === id) {
        setFiles(summary.files); setSummaryTruncated(summary.truncated); setSelected(summary.files[0]?.path ?? null);
      }
    }).catch((reason: unknown) => {
      if (summaryRevision.current === id) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (summaryRevision.current === id) setBusy(false); });
    return () => { summaryRevision.current++; };
  }, [open, first, second, includeUncommitted]);

  useEffect(() => {
    if (!open || !selected || !first || !second || first === second) { setDiff(null); return; }
    const id = ++diffRevision.current;
    setError(null);
    void readCompareFileDiff(first, second, selected, includeUncommitted).then((model) => {
      if (diffRevision.current === id) setDiff(model);
    }).catch((reason: unknown) => {
      if (diffRevision.current === id) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { diffRevision.current++; };
  }, [open, selected, first, second, includeUncommitted]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const copyPatch = async () => {
    try { await navigator.clipboard.writeText(await readComparePatch(first, second, includeUncommitted)); toast({ title: t("compare.patchCopied"), icon: "✓" }); }
    catch (reason) { toast({ title: reason instanceof Error ? reason.message : String(reason), icon: "⚠" }); }
  };
  const count = (status: string) => files.filter((file) => file.status === status).length;
  return <div className="dlg-backdrop compare-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dlg compare-dialog" role="dialog" aria-modal="true" aria-labelledby="compare-title">
      <header className="compare-head"><div><h3 id="compare-title">{t("compare.title")}</h3><p>{t("compare.subtitle")}</p></div><button className="btn sm" onClick={onClose} aria-label={t("compare.close")}>×</button></header>
      <div className="compare-controls">
        <label>{t("compare.worktreeA")}<select className="input" value={first} onChange={(event) => setA(event.target.value)}>{choices.map((item) => <option key={item.path} value={item.path}>{item.branch} · {item.path}</option>)}</select></label>
        <span aria-hidden>↔</span>
        <label>{t("compare.worktreeB")}<select className="input" value={second} onChange={(event) => setB(event.target.value)}>{choices.map((item) => <option key={item.path} value={item.path}>{item.branch} · {item.path}</option>)}</select></label>
        <label className="compare-toggle"><input type="checkbox" checked={includeUncommitted} onChange={(event) => setIncludeUncommitted(event.target.checked)} />{t("compare.includeUncommitted")}</label>
      </div>
      <p className="compare-note">{t("compare.untrackedNote")}</p>
      <div className="compare-summary" aria-live="polite">{t("compare.summary", { added: String(count("added")), removed: String(count("deleted")), changed: String(files.length - count("added") - count("deleted")) })}{busy ? ` · ${t("compare.loading")}` : ""}{summaryTruncated ? ` · ${t("compare.truncated")}` : ""}</div>
      <div className="compare-body">
        <nav className="compare-files" aria-label={t("compare.files")}>{files.map((file) => <button key={file.path} className={selected === file.path ? "selected" : ""} onClick={() => setSelected(file.path)}><span>{file.status === "added" ? "+" : file.status === "deleted" ? "−" : "M"}</span><code>{file.path}</code><small>+{file.additions} −{file.deletions}</small></button>)}{!busy && files.length === 0 && <p>{t("compare.empty")}</p>}</nav>
        <div className="compare-diff" aria-label={t("compare.diff")}>{error ? <p role="alert">{error}</p> : diff ? <DiffRenderer model={diff} mode="split" area="all" fileName={selected ?? undefined} /> : <p>{busy ? t("compare.loading") : t("compare.selectFile")}</p>}</div>
      </div>
      <footer className="dlg-actions"><button className="btn" onClick={onClose}>{t("compare.close")}</button><button className="btn p" disabled={!files.length || busy || first === second} onClick={() => void copyPatch()}>{t("compare.copyPatch")}</button></footer>
    </section>
  </div>;
}
