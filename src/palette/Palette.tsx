import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { usePalette } from "./store";
import { askClaudeCommand, buildCommands, type Command } from "./commands";
import { rank } from "./fuzzy";
import { t } from "../i18n/t";

export function Palette() {
  const open = usePalette((s) => s.open);
  const query = usePalette((s) => s.query);
  const { setQuery, hide } = usePalette.getState();
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    if (!open) return [];
    const q = query.trim();
    if (q.endsWith("?")) return [askClaudeCommand(q)];
    return rank(buildCommands(), q, (c) => c.title + " " + t(c.group));
  }, [open, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { document.querySelector(".pal-item.on")?.scrollIntoView?.({ block: "nearest" }); }, [index]);

  if (!open) return null;

  const run = (c?: Command) => { if (!c) return; hide(); c.run(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); run(results[index]); }
    else if (e.key === "Escape") { e.preventDefault(); hide(); }
    else if (e.key === "Tab") { e.preventDefault(); inputRef.current?.focus(); }
  };

  return (
    <>
      <div className="pal-scrim" onMouseDown={hide} />
      <div className="palette" role="dialog" aria-modal="true" aria-label={t("palette.placeholder")}>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="pal-list"
          aria-label={t("palette.placeholder")}
          placeholder={t("palette.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="pal-list" id="pal-list" role="listbox">
          {results.length === 0 && <div className="pal-empty">{t("palette.empty")}</div>}
          {results.map((c, i) => (
            <div
              key={c.id}
              role="option"
              aria-selected={i === index}
              className={"pal-item" + (i === index ? " on" : "")}
              onMouseMove={() => setIndex(i)}
              onMouseDown={(e) => { e.preventDefault(); run(c); }}
            >
              <span className="pal-ic" aria-hidden>{c.icon}</span>
              <span className="pal-title">{c.title}</span>
              <span className="pal-grp">{t(c.group)}</span>
              {c.kbd && <kbd className="kbd">{c.kbd}</kbd>}
            </div>
          ))}
        </div>
        <div className="pal-foot">
          <span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> {t("palette.nav")}</span>
          <span><kbd className="kbd">↵</kbd> {t("palette.run")}</span>
          <span><kbd className="kbd">esc</kbd> {t("palette.close")}</span>
          <span className="pal-ask">{t("palette.askHint")}</span>
        </div>
      </div>
    </>
  );
}
