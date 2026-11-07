import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { DiffArea, DiffLine, DiffModel, Hunk } from "../ipc/bindings";
import type { MsgKey } from "../i18n/en";
import { t } from "../i18n/t";
import { Button } from "../ui/Button";
import { FileIcon } from "../ui/fileIcon";
import "./diff.css";

type DiffMode = "split" | "inline";
type DiffViewArea = DiffArea | "all";
type HunkAction = "stage" | "revert" | "unstage";
const ACTION_LABELS: Record<HunkAction, MsgKey> = {
  stage: "diff.action.stage",
  revert: "diff.action.revert",
  unstage: "diff.action.unstage",
};

interface DiffRendererProps {
  model: DiffModel;
  mode: DiffMode;
  area: DiffViewArea;
  hunkAreas?: readonly DiffArea[];
  fileName?: string;
  onToggleLine?: (hunk: Hunk, lineKey: string) => void;
  onRequestHunkAction?: (hunk: Hunk, action: HunkAction) => void;
}

function hunkArea(area: DiffViewArea, hunkAreas: readonly DiffArea[] | undefined, index: number): DiffArea {
  return hunkAreas?.[index] ?? (area === "all" ? "unstaged" : area);
}

/** The .dvh file header and .dcols column labels mirror whichever two sides this view compares
 * (prototype's `(Index)`/`HEAD ↔ Index`); "all" (no particular staged/unstaged context) falls
 * back to generic old/new labels and no compare chip or note. */
function sourceLabels(area: DiffViewArea): { left: MsgKey; right: MsgKey; chip?: MsgKey; note?: MsgKey } {
  if (area === "staged") {
    return { left: "diff.sourceHead", right: "diff.sourceIndex", chip: "diff.compareStagedChip", note: "diff.indexLabel" };
  }
  if (area === "unstaged") {
    return { left: "diff.sourceIndex", right: "diff.sourceWorkingTree", chip: "diff.compareUnstagedChip", note: "diff.workingTreeLabel" };
  }
  return { left: "diff.sourceOld", right: "diff.sourceNew" };
}

function markedText(line: DiffLine) {
  const spans = [...(line.intra ?? [])]
    .map((span) => ({
      ...span,
      start: Math.max(0, Math.min(line.text.length, span.start)),
      end: Math.max(0, Math.min(line.text.length, span.end)),
    }))
    .filter((span) => span.start < span.end)
    .sort((left, right) => left.start - right.start);
  if (spans.length === 0) return line.text;

  const nodes = [];
  let cursor = 0;
  for (const [index, span] of spans.entries()) {
    if (span.start < cursor) continue;
    if (span.start > cursor) nodes.push(line.text.slice(cursor, span.start));
    nodes.push(
      <mark className={`diff-intra diff-intra-${span.kind}`} key={`${span.start}:${span.end}:${index}`}>
        {line.text.slice(span.start, span.end)}
      </mark>,
    );
    cursor = span.end;
  }
  if (cursor < line.text.length) nodes.push(line.text.slice(cursor));
  return nodes;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function unchangedLabel(count: number): string {
  return t("diff.unchangedLines", { count });
}

// ponytail: rough per-hunk `contain-intrinsic-size` estimate (line count x row height, plus the
// header) so an off-screen hunk reserves close to its real height instead of the old flat 240px,
// which made the scrollbar/scrollHeight jump as hunks scrolled into view.
const DIFF_ROW_HEIGHT_PX = 22;
const DIFF_HEADER_HEIGHT_PX = 30;

function estimateHunkHeight(hunk: Hunk): number {
  return DIFF_HEADER_HEIGHT_PX + hunk.lines.length * DIFF_ROW_HEIGHT_PX;
}

// ponytail: windows at hunk granularity, not per row. A hunk near the viewport (plus the overscan
// margin below) renders in full; everything else becomes a spacer sized by estimateHunkHeight(),
// so the scrollbar and ruler stay roughly right without 5 000 real DOM rows existing at once.
// Known ceiling: a single hunk that is itself huge (plan caps context_lines at 3/interhunk at 0,
// so this would mean one giant contiguous change) still renders in full once active -- window its
// rows too if real diffs start producing that.
const INITIAL_RENDER_BUDGET_PX = 1_600;
const OVERSCAN_MARGIN = "800px 0px";

function initialActiveHunks(hunks: readonly Hunk[]): Set<number> {
  const active = new Set<number>();
  let used = 0;
  for (let index = 0; index < hunks.length && used < INITIAL_RENDER_BUDGET_PX; index += 1) {
    active.add(index);
    used += estimateHunkHeight(hunks[index]);
  }
  return active;
}

export function DiffRenderer({
  model,
  mode,
  area,
  hunkAreas,
  fileName,
  onToggleLine,
  onRequestHunkAction,
}: DiffRendererProps) {
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(() => new Set());
  const hunksRef = useRef<HTMLDivElement>(null);
  const hunkRefs = useRef<(HTMLElement | null)[]>([]);
  const [activeHunks, setActiveHunks] = useState<Set<number> | "all">(() =>
    typeof IntersectionObserver === "undefined" ? "all" : initialActiveHunks(model.hunks),
  );
  // prototype's `hkJump`/`S.hkI`: -1 (nothing jumped to yet) until the first ↑/↓ press, then
  // clamped to the hunk list bounds and scrolled into view.
  const [currentHunk, setCurrentHunk] = useState(-1);
  const jumpHunk = (delta: number) => {
    if (model.hunks.length === 0) return;
    const next = Math.max(0, Math.min(model.hunks.length - 1, currentHunk + delta));
    setCurrentHunk(next);
    hunkRefs.current[next]?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  };

  // R-2: window at hunk granularity, scoped to `.diff-hunks` itself (the real scroller -- it's a
  // full-height flex child of `.diff-renderer` now, not stacked under the Changes file lists, so
  // no extra sticky/measured-height hack is needed to keep it from overflowing the window). Without
  // IntersectionObserver (jsdom), render everything -- the existing unit tests assert on rendered
  // content and don't simulate layout.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setActiveHunks("all");
      return;
    }
    setActiveHunks(initialActiveHunks(model.hunks));
    const observer = new IntersectionObserver(
      (entries) => {
        setActiveHunks((previous) => {
          const next = new Set(previous === "all" ? [] : previous);
          for (const entry of entries) {
            const index = Number((entry.target as HTMLElement).dataset.hunkIndex);
            if (entry.isIntersecting) next.add(index);
            else next.delete(index);
          }
          return next;
        });
      },
      { root: hunksRef.current, rootMargin: OVERSCAN_MARGIN },
    );
    for (const el of hunkRefs.current) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [model.hunks]);

  const ruler = useMemo(() => {
    const total = Math.max(
      1,
      ...model.hunks.map((hunk) => hunk.newStart + Math.max(0, hunk.newLines - 1)),
    );
    return model.hunks.map((hunk, index) => {
      const kinds = new Set(hunk.lines.map((line) => line.kind));
      const color =
        kinds.has("add") && kinds.has("del")
          ? "var(--pur)"
          : kinds.has("add")
            ? "var(--grn)"
            : "var(--red)";
      const position = Math.min(100, Math.max(0, (hunk.newStart / total) * 100));
      return { hunk, index, color, position };
    });
  }, [model.hunks]);

  if (model.binary || model.truncated) {
    const reason = model.binary ? t("diff.binaryReason") : t("diff.truncatedReason");
    return (
      <section className="diff-summary" role="status">
        <strong>{fileName ?? t("diff.unknownFile")}</strong>
        <span>{formatBytes(model.bytes)}</span>
        <p>{reason}</p>
      </section>
    );
  }

  const labels = sourceLabels(area);

  return (
    <div className={`diff-renderer diff-mode-${mode}`} data-mode={mode}>
      {fileName && (
        <header className="diff-file-header">
          <FileIcon path={fileName} />
          <strong>{fileName.split("/").pop()}</strong>
          {labels.note && <span className="diff-file-note">{t(labels.note)}</span>}
          {labels.chip && <span className="chip">{t(labels.chip)}</span>}
          <span className="diff-file-path">{fileName}</span>
          <span className="diff-file-spacer" />
          <Button disabled size="sm" variant="ghost">
            {t("diff.stageSelectedLines")}
          </Button>
          <button
            aria-label={t("diff.previousHunk")}
            className="ib2"
            disabled={model.hunks.length === 0}
            onClick={() => jumpHunk(-1)}
            title={t("diff.previousHunk")}
            type="button"
          >
            ↑
          </button>
          <button
            aria-label={t("diff.nextHunk")}
            className="ib2"
            disabled={model.hunks.length === 0}
            onClick={() => jumpHunk(1)}
            title={t("diff.nextHunk")}
            type="button"
          >
            ↓
          </button>
          <button aria-label={t("changes.openFile")} className="ib2" disabled title={t("changes.openFile")} type="button">
            ▤
          </button>
        </header>
      )}
      {fileName && mode === "split" && (
        <div className="diff-columns">
          <span>{t(labels.left)}</span>
          <span>{t(labels.right)}</span>
        </div>
      )}
      <div className="diff-body">
        <div className="diff-hunks" ref={hunksRef}>
          {model.hunks.map((hunk, hunkIndex) => {
            const currentArea = hunkArea(area, hunkAreas, hunkIndex);
            const dimmed = area !== "all" && currentArea !== area;
            const actions: HunkAction[] =
              area === "all" ? [] : currentArea === "staged" ? ["unstage"] : ["stage", "revert"];
            const active = activeHunks === "all" || activeHunks.has(hunkIndex);
            return (
              <section
                className={`diff-hunk${dimmed ? " diff-hunk-dimmed" : ""}`}
                data-area={currentArea}
                data-dimmed={dimmed ? "true" : "false"}
                data-hunk-index={hunkIndex}
                key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}
                ref={(el) => {
                  hunkRefs.current[hunkIndex] = el;
                }}
                style={{ containIntrinsicSize: `auto ${estimateHunkHeight(hunk)}px` } as CSSProperties}
              >
                {active ? (
                  <>
                    <header className={`diff-hunk-header${hunkIndex === currentHunk ? " diff-hunk-header-current" : ""}`}>
                      <code>
                        {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
                      </code>
                      <span className={`chip${currentArea === "staged" ? " cg" : ""}`}>
                        {t(currentArea === "staged" ? "diff.staged" : "diff.unstaged")}
                      </span>
                      <div className="diff-hunk-actions">
                        {actions.map((action) => (
                          <Button
                            disabled={!onRequestHunkAction}
                            key={action}
                            onClick={() => onRequestHunkAction?.(hunk, action)}
                            size="sm"
                            variant={action === "revert" ? "ghost" : "default"}
                          >
                            {t(ACTION_LABELS[action])}
                          </Button>
                        ))}
                      </div>
                    </header>
                    <div className="diff-lines">
                      {renderHunkLines({
                        hunk,
                        hunkIndex,
                        mode,
                        onToggleLine,
                        isExpanded: (lineIndex) =>
                          expandedRuns.has(`${hunkIndex}:${lineIndex}`),
                        expand: (lineIndex) =>
                          setExpandedRuns((previous) => {
                            const next = new Set(previous);
                            next.add(`${hunkIndex}:${lineIndex}`);
                            return next;
                          }),
                      })}
                    </div>
                  </>
                ) : (
                  // Off-screen (past the overscan margin): a plain spacer keeps scroll height and
                  // ruler math roughly right without 250+ real DOM rows per hunk existing at once.
                  <div aria-hidden style={{ height: estimateHunkHeight(hunk) }} />
                )}
              </section>
            );
          })}
        </div>
        <aside className="diff-ruler" aria-label={t("diff.overviewRuler")}>
          {ruler.map(({ hunk, index, color, position }) => (
            <span
              aria-label={t("diff.rulerHunk", { number: index + 1 })}
              className="diff-ruler-tick"
              key={`${hunk.newStart}:${index}`}
              role="img"
              style={{ "--diff-ruler-color": color, top: `${position}%` } as CSSProperties}
            />
          ))}
        </aside>
      </div>
    </div>
  );
}

interface RenderHunkLinesArgs {
  hunk: Hunk;
  hunkIndex: number;
  mode: DiffMode;
  onToggleLine?: DiffRendererProps["onToggleLine"];
  isExpanded(lineIndex: number): boolean;
  expand(lineIndex: number): void;
}

function renderHunkLines({
  hunk,
  hunkIndex,
  mode,
  onToggleLine,
  isExpanded,
  expand,
}: RenderHunkLinesArgs) {
  const rows = [];
  let lineIndex = 0;
  while (lineIndex < hunk.lines.length) {
    if (hunk.lines[lineIndex].kind !== "context") {
      if (mode === "split") {
        // Pair a del-run with the following add-run into shared rows (del left, add right), the
        // way the prototype renders a modified line, instead of one staggered row per line.
        const delStart = lineIndex;
        while (lineIndex < hunk.lines.length && hunk.lines[lineIndex].kind === "del") lineIndex += 1;
        const delCount = lineIndex - delStart;
        const addStart = lineIndex;
        while (lineIndex < hunk.lines.length && hunk.lines[lineIndex].kind === "add") lineIndex += 1;
        const addCount = lineIndex - addStart;
        for (let offset = 0; offset < Math.max(delCount, addCount); offset += 1) {
          rows.push(
            <DiffSplitPairRow
              addLine={offset < addCount ? hunk.lines[addStart + offset] : undefined}
              addLineIndex={addStart + offset}
              delLine={offset < delCount ? hunk.lines[delStart + offset] : undefined}
              delLineIndex={delStart + offset}
              hunk={hunk}
              hunkIndex={hunkIndex}
              key={`${delStart}:${addStart}:${offset}`}
              onToggleLine={onToggleLine}
            />,
          );
        }
        continue;
      }
      rows.push(
        <DiffLineRow
          hunk={hunk}
          hunkIndex={hunkIndex}
          key={lineIndex}
          line={hunk.lines[lineIndex]}
          lineIndex={lineIndex}
          mode={mode}
          onToggleLine={onToggleLine}
        />,
      );
      lineIndex += 1;
      continue;
    }

    const runStart = lineIndex;
    while (lineIndex < hunk.lines.length && hunk.lines[lineIndex].kind === "context") {
      lineIndex += 1;
    }
    const runLength = lineIndex - runStart;
    const runKey = `${hunkIndex}:${runStart}`;
    if (runLength > 7 && !isExpanded(runStart)) {
      rows.push(
        <button
          className="diff-context-collapse"
          key={runKey}
          onClick={() => expand(runStart)}
          style={{ gridColumn: "1 / -1" }}
          type="button"
        >
          {unchangedLabel(runLength)}
        </button>,
      );
      continue;
    }
    for (let index = runStart; index < lineIndex; index += 1) {
      rows.push(
        <DiffLineRow
          hunk={hunk}
          hunkIndex={hunkIndex}
          key={index}
          line={hunk.lines[index]}
          lineIndex={index}
          mode={mode}
          onToggleLine={onToggleLine}
        />,
      );
    }
  }
  return rows;
}

type Side = "old" | "new";

function sideShowsNumber(line: DiffLine, side: Side): boolean {
  return side === "old" ? line.kind !== "add" : line.kind !== "del";
}

interface NumberCellProps {
  hunk: Hunk;
  hunkIndex: number;
  line?: DiffLine;
  lineIndex: number;
  side: Side;
  onToggleLine?: DiffRendererProps["onToggleLine"];
}

function NumberCell({ hunk, hunkIndex, line, lineIndex, side, onToggleLine }: NumberCellProps) {
  if (!line || !sideShowsNumber(line, side)) return <span className="diff-line-number" aria-hidden />;
  const value = side === "old" ? line.old : line.new;
  if (onToggleLine && line.kind !== "context") {
    return (
      <button
        aria-label={t("diff.toggleLine", { line: lineIndex + 1 })}
        className="diff-line-number"
        onClick={() => onToggleLine(hunk, `${hunkIndex}:${lineIndex}`)}
        type="button"
      >
        {value ?? ""}
      </button>
    );
  }
  return <span className="diff-line-number">{value ?? ""}</span>;
}

function ContentCell({ line, inline }: { line?: DiffLine; inline?: boolean }) {
  if (!line) return <span className="diff-cell diff-cell-emp" />;
  const kindClass = line.kind === "context" ? "" : ` diff-cell-${line.kind}`;
  const prefix = inline ? (line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "") : "";
  return (
    <span className={`diff-cell${kindClass}`}>
      {prefix}
      {markedText(line)}
    </span>
  );
}

interface DiffLineRowProps {
  hunk: Hunk;
  hunkIndex: number;
  line: DiffLine;
  lineIndex: number;
  mode: DiffMode;
  onToggleLine?: DiffRendererProps["onToggleLine"];
}

/** In split mode this only ever renders a context line (changed lines go through
 * `DiffSplitPairRow` instead); in inline mode it renders every line kind. Only the content cell
 * carries the del/add tint (prototype's `.c.del`/`.c.add`) -- the number columns stay plain. */
function DiffLineRow({ hunk, hunkIndex, line, lineIndex, mode, onToggleLine }: DiffLineRowProps) {
  if (mode === "inline") {
    return (
      <div className="diff-line diff-inline-line">
        <NumberCell hunk={hunk} hunkIndex={hunkIndex} line={line} lineIndex={lineIndex} onToggleLine={onToggleLine} side="old" />
        <NumberCell hunk={hunk} hunkIndex={hunkIndex} line={line} lineIndex={lineIndex} onToggleLine={onToggleLine} side="new" />
        <ContentCell inline line={line} />
      </div>
    );
  }
  return (
    <div className="diff-line diff-split-line">
      <NumberCell hunk={hunk} hunkIndex={hunkIndex} line={line} lineIndex={lineIndex} onToggleLine={onToggleLine} side="old" />
      <ContentCell line={line} />
      <NumberCell hunk={hunk} hunkIndex={hunkIndex} line={line} lineIndex={lineIndex} onToggleLine={onToggleLine} side="new" />
      <ContentCell line={line} />
    </div>
  );
}

interface DiffSplitPairRowProps {
  hunk: Hunk;
  hunkIndex: number;
  delLine?: DiffLine;
  delLineIndex: number;
  addLine?: DiffLine;
  addLineIndex: number;
  onToggleLine?: DiffRendererProps["onToggleLine"];
}

/** A split-mode row for one del/add pair: the del on the left, the add on the right. Either side
 * is left blank (the hatched `.diff-cell-emp`) when the run it belongs to is shorter than the
 * other (unpaired line). */
function DiffSplitPairRow({
  hunk,
  hunkIndex,
  delLine,
  delLineIndex,
  addLine,
  addLineIndex,
  onToggleLine,
}: DiffSplitPairRowProps) {
  return (
    <div className="diff-line diff-split-line">
      <NumberCell hunk={hunk} hunkIndex={hunkIndex} line={delLine} lineIndex={delLineIndex} onToggleLine={onToggleLine} side="old" />
      <ContentCell line={delLine} />
      <NumberCell hunk={hunk} hunkIndex={hunkIndex} line={addLine} lineIndex={addLineIndex} onToggleLine={onToggleLine} side="new" />
      <ContentCell line={addLine} />
    </div>
  );
}
