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
  selectedLineIds?: readonly string[];
  onToggleLine?: (hunk: Hunk, lineKey: string) => void;
  onRequestHunkAction?: (hunk: Hunk, action: HunkAction, hunkIndex: number) => void;
  onStageSelectedLines?: () => void;
  onOpenFile?: () => void;
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
const DIFF_ROW_HEIGHT_PX = 20;

/** Long lines scroll sideways per hunk (`.diff-lines`) instead of wrapping: wrapping would
 * break the fixed 20px row height the virtualizer relies on. Width = gutters + cell padding +
 * the longest line in `ch` (tabs counted at the default `tab-size` of 8). */
function hunkContentWidth(hunk: Hunk, mode: DiffMode): string {
  let longest = 0;
  for (const line of hunk.lines) {
    let width = line.text.length;
    for (let i = line.text.indexOf("\t"); i !== -1; i = line.text.indexOf("\t", i + 1)) width += 7;
    if (width > longest) longest = width;
  }
  return mode === "split" ? `calc(104px + ${longest * 2}ch)` : `calc(88px + ${longest}ch)`;
}
const DIFF_HEADER_HEIGHT_PX = 30;
const ROW_WINDOW_THRESHOLD = 240;
const ROW_OVERSCAN_PX = 800;

function estimateHunkHeight(hunk: Hunk): number {
  return DIFF_HEADER_HEIGHT_PX + hunk.lines.length * DIFF_ROW_HEIGHT_PX;
}

// Window hunks first, then rows inside an active hunk when one contiguous change is exceptionally
// large. Fixed-height rows keep virtual spacers aligned without creating thousands of DOM nodes.
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

type HunkDisplayRow =
  | { kind: "line"; lineIndex: number }
  | { kind: "pair"; delLineIndex: number; addLineIndex: number }
  | { kind: "collapse"; lineIndex: number; count: number };

function buildHunkRows(
  hunk: Hunk,
  hunkIndex: number,
  mode: DiffMode,
  expandedRuns: ReadonlySet<string>,
): HunkDisplayRow[] {
  const rows: HunkDisplayRow[] = [];
  let lineIndex = 0;
  while (lineIndex < hunk.lines.length) {
    if (hunk.lines[lineIndex].kind !== "context") {
      if (mode === "split") {
        const delStart = lineIndex;
        while (lineIndex < hunk.lines.length && hunk.lines[lineIndex].kind === "del") lineIndex += 1;
        const delCount = lineIndex - delStart;
        const addStart = lineIndex;
        while (lineIndex < hunk.lines.length && hunk.lines[lineIndex].kind === "add") lineIndex += 1;
        const addCount = lineIndex - addStart;
        for (let offset = 0; offset < Math.max(delCount, addCount); offset += 1) {
          rows.push({
            kind: "pair",
            delLineIndex: delStart + offset,
            addLineIndex: addStart + offset,
          });
        }
        continue;
      }
      rows.push({ kind: "line", lineIndex });
      lineIndex += 1;
      continue;
    }

    const runStart = lineIndex;
    while (lineIndex < hunk.lines.length && hunk.lines[lineIndex].kind === "context") lineIndex += 1;
    const runLength = lineIndex - runStart;
    if (runLength > 7 && !expandedRuns.has(`${hunkIndex}:${runStart}`)) {
      rows.push({ kind: "collapse", lineIndex: runStart, count: runLength });
      continue;
    }
    for (let index = runStart; index < lineIndex; index += 1) {
      rows.push({ kind: "line", lineIndex: index });
    }
  }
  return rows;
}

function visibleRowRange(
  rowCount: number,
  hunkTop: number,
  scrollTop: number,
  viewportHeight: number,
): [number, number] {
  const relativeTop = scrollTop - hunkTop - DIFF_HEADER_HEIGHT_PX;
  const first = Math.max(0, Math.floor((relativeTop - ROW_OVERSCAN_PX) / DIFF_ROW_HEIGHT_PX));
  const last = Math.min(
    rowCount,
    Math.max(first, Math.ceil((relativeTop + viewportHeight + ROW_OVERSCAN_PX) / DIFF_ROW_HEIGHT_PX)),
  );
  return [first, last];
}

export function DiffRenderer({
  model,
  mode,
  area,
  hunkAreas,
  fileName,
  selectedLineIds = [],
  onToggleLine,
  onRequestHunkAction,
  onStageSelectedLines,
  onOpenFile,
}: DiffRendererProps) {
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(() => new Set());
  const hunksRef = useRef<HTMLDivElement>(null);
  const hunkRefs = useRef<(HTMLElement | null)[]>([]);
  const [scrollMetrics, setScrollMetrics] = useState({ top: 0, height: 0 });
  const [activeHunks, setActiveHunks] = useState<Set<number> | "all">(() =>
    typeof IntersectionObserver === "undefined" ? "all" : initialActiveHunks(model.hunks),
  );
  const displayRows = useMemo(
    () => model.hunks.map((hunk, index) => buildHunkRows(hunk, index, mode, expandedRuns)),
    [expandedRuns, mode, model.hunks],
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

  // Hunk and row windows are both scoped to the real `.diff-hunks` scroller. Without
  // IntersectionObserver, keep all hunk shells mounted; huge individual hunks still row-window.
  useEffect(() => {
    const node = hunksRef.current;
    if (!node) return;
    const updateSize = () => {
      setScrollMetrics((previous) =>
        previous.height === node.clientHeight && previous.top === node.scrollTop
          ? previous
          : { top: node.scrollTop, height: node.clientHeight },
      );
    };
    updateSize();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateSize);
    resizeObserver?.observe(node);
    return () => resizeObserver?.disconnect();
  }, []);

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
          <Button
            disabled={!onStageSelectedLines || selectedLineIds.length === 0 || area === "staged"}
            onClick={() => onStageSelectedLines?.()}
            size="sm"
            variant="ghost"
          >
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
          <button
            aria-label={t("changes.openFile")}
            className="ib2"
            disabled={!onOpenFile}
            onClick={() => onOpenFile?.()}
            title={t("changes.openFile")}
            type="button"
          >
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
        <div
          className="diff-hunks"
          onScroll={(event) => {
            const node = event.currentTarget;
            setScrollMetrics((previous) =>
              previous.height === node.clientHeight && previous.top === node.scrollTop
                ? previous
                : { top: node.scrollTop, height: node.clientHeight },
            );
          }}
          ref={hunksRef}
        >
          {model.hunks.map((hunk, hunkIndex) => {
            const currentArea = hunkArea(area, hunkAreas, hunkIndex);
            const dimmed = area !== "all" && currentArea !== area;
            const actions: HunkAction[] =
              area === "all" ? [] : currentArea === "staged" ? ["unstage"] : ["stage", "revert"];
            const active = activeHunks === "all" || activeHunks.has(hunkIndex);
            const rows = displayRows[hunkIndex];
            const [firstRow, lastRow] =
              rows.length > ROW_WINDOW_THRESHOLD
                ? visibleRowRange(
                    rows.length,
                    hunkRefs.current[hunkIndex]?.offsetTop ?? 0,
                    scrollMetrics.top,
                    scrollMetrics.height,
                  )
                : [0, rows.length];
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
                            onClick={() => onRequestHunkAction?.(hunk, action, hunkIndex)}
                            size="sm"
                            variant={action === "revert" ? "ghost" : "default"}
                          >
                            {t(ACTION_LABELS[action])}
                          </Button>
                        ))}
                      </div>
                    </header>
                    <div className="diff-lines" style={{ "--diff-content-w": hunkContentWidth(hunk, mode) } as CSSProperties}>
                      {renderHunkRows({
                        hunk,
                        hunkIndex,
                        mode,
                        rows,
                        firstRow,
                        lastRow,
                        selectedLineIds,
                        onToggleLine,
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

interface RenderHunkRowsArgs {
  hunk: Hunk;
  hunkIndex: number;
  mode: DiffMode;
  rows: HunkDisplayRow[];
  firstRow: number;
  lastRow: number;
  selectedLineIds: readonly string[];
  onToggleLine?: DiffRendererProps["onToggleLine"];
  expand(lineIndex: number): void;
}

function renderHunkRows({
  hunk,
  hunkIndex,
  mode,
  rows,
  firstRow,
  lastRow,
  selectedLineIds,
  onToggleLine,
  expand,
}: RenderHunkRowsArgs) {
  const visibleRows = [];
  if (firstRow > 0) {
    visibleRows.push(
      <div
        aria-hidden
        className="diff-row-spacer"
        key="top-spacer"
        style={{ height: firstRow * DIFF_ROW_HEIGHT_PX }}
      />,
    );
  }
  for (const row of rows.slice(firstRow, lastRow)) {
    if (row.kind === "line") {
      visibleRows.push(
        <DiffLineRow
          hunk={hunk}
          hunkIndex={hunkIndex}
          key={`line-${row.lineIndex}`}
          line={hunk.lines[row.lineIndex]}
          lineIndex={row.lineIndex}
          mode={mode}
          selectedLineIds={selectedLineIds}
          onToggleLine={onToggleLine}
        />,
      );
    } else if (row.kind === "pair") {
      const delLine = hunk.lines[row.delLineIndex];
      const addLine = hunk.lines[row.addLineIndex];
      visibleRows.push(
        <DiffSplitPairRow
          addLine={addLine?.kind === "add" ? addLine : undefined}
          addLineIndex={row.addLineIndex}
          delLine={delLine?.kind === "del" ? delLine : undefined}
          delLineIndex={row.delLineIndex}
          hunk={hunk}
          hunkIndex={hunkIndex}
          key={`pair-${row.delLineIndex}-${row.addLineIndex}`}
          selectedLineIds={selectedLineIds}
          onToggleLine={onToggleLine}
        />,
      );
    } else {
      visibleRows.push(
        <button
          className="diff-context-collapse"
          key={`collapse-${row.lineIndex}`}
          onClick={() => expand(row.lineIndex)}
          style={{ gridColumn: "1 / -1" }}
          type="button"
        >
          {unchangedLabel(row.count)}
        </button>,
      );
    }
  }
  if (lastRow < rows.length) {
    visibleRows.push(
      <div
        aria-hidden
        className="diff-row-spacer"
        key="bottom-spacer"
        style={{ height: (rows.length - lastRow) * DIFF_ROW_HEIGHT_PX }}
      />,
    );
  }
  return visibleRows;
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
  selectedLineIds?: readonly string[];
  onToggleLine?: DiffRendererProps["onToggleLine"];
}

function NumberCell({ hunk, hunkIndex, line, lineIndex, side, selectedLineIds, onToggleLine }: NumberCellProps) {
  if (!line || !sideShowsNumber(line, side)) return <span className="diff-line-number" aria-hidden />;
  const value = side === "old" ? line.old : line.new;
  const lineId = `${hunkIndex}:${lineIndex}`;
  if (onToggleLine && line.kind !== "context") {
    const selected = selectedLineIds?.includes(lineId);
    return (
      <button
        aria-label={t("diff.toggleLine", { line: lineIndex + 1 })}
        aria-pressed={selected}
        className={"diff-line-number" + (selected ? " diff-line-selected" : "")}
        onClick={() => onToggleLine(hunk, lineId)}
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
  selectedLineIds?: readonly string[];
  onToggleLine?: DiffRendererProps["onToggleLine"];
}

/** In split mode this only ever renders a context line (changed lines go through
 * `DiffSplitPairRow` instead); in inline mode it renders every line kind. Only the content cell
 * carries the del/add tint (prototype's `.c.del`/`.c.add`) -- the number columns stay plain. */
function DiffLineRow({ hunk, hunkIndex, line, lineIndex, mode, selectedLineIds, onToggleLine }: DiffLineRowProps) {
  if (mode === "inline") {
    return (
      <div className="diff-line diff-inline-line">
        <NumberCell hunk={hunk} hunkIndex={hunkIndex} line={line} lineIndex={lineIndex} selectedLineIds={selectedLineIds} onToggleLine={onToggleLine} side="old" />
        <NumberCell hunk={hunk} hunkIndex={hunkIndex} line={line} lineIndex={lineIndex} selectedLineIds={selectedLineIds} onToggleLine={onToggleLine} side="new" />
        <ContentCell inline line={line} />
      </div>
    );
  }
  return (
    <div className="diff-line diff-split-line">
      <NumberCell hunk={hunk} hunkIndex={hunkIndex} line={line} lineIndex={lineIndex} selectedLineIds={selectedLineIds} onToggleLine={onToggleLine} side="old" />
      <ContentCell line={line} />
      <NumberCell hunk={hunk} hunkIndex={hunkIndex} line={line} lineIndex={lineIndex} selectedLineIds={selectedLineIds} onToggleLine={onToggleLine} side="new" />
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
  selectedLineIds?: readonly string[];
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
  selectedLineIds,
  onToggleLine,
}: DiffSplitPairRowProps) {
  return (
    <div className="diff-line diff-split-line">
      <NumberCell hunk={hunk} hunkIndex={hunkIndex} line={delLine} lineIndex={delLineIndex} selectedLineIds={selectedLineIds} onToggleLine={onToggleLine} side="old" />
      <ContentCell line={delLine} />
      <NumberCell hunk={hunk} hunkIndex={hunkIndex} line={addLine} lineIndex={addLineIndex} selectedLineIds={selectedLineIds} onToggleLine={onToggleLine} side="new" />
      <ContentCell line={addLine} />
    </div>
  );
}
