import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type RefObject } from "react";
import { useStage } from "../state/stage";
import { Pane } from "./Pane";
import { MIN_SHARE, layoutRects, nearestSide, type Gutter } from "./stageModel";
import { SCREEN_MIME } from "./dnd";
import { DropContext, type DropTarget } from "./dropTarget";
import type { ScreenId } from "../screens/registry";
import { t } from "../i18n/t";
import { OperationBanner } from "../shell/OperationBanner";
import { useWorktrees } from "../state/worktrees";

/** A divider drag never shrinks a pane below this many pixels. */
const MIN_PANE_PX = 200;
const pct = (fraction: number) => `${fraction * 100}%`;

function Divider({ gutter, canvas }: { gutter: Gutter; canvas: RefObject<HTMLDivElement | null> }) {
  const { split, index, box, at } = gutter;
  const horizontal = split.dir === "h";
  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = canvas.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // The split's own box in pixels, from its fractional box in the canvas.
    const start = horizontal ? rect.left + rect.width * box.x : rect.top + rect.height * box.y;
    const length = horizontal ? rect.width * box.w : rect.height * box.h;
    const before = split.sizes.slice(0, index).reduce((a, b) => a + b, 0);
    const minShare = Math.max(MIN_SHARE, length > 0 ? MIN_PANE_PX / length : MIN_SHARE);
    const stage = el.closest(".stage");
    stage?.classList.add("resizing");
    const move = (ev: globalThis.MouseEvent) => {
      const along = ((horizontal ? ev.clientX : ev.clientY) - start) / length;
      useStage.getState().setGutter(split.id, index, along - before, minShare);
    };
    const up = () => {
      stage?.classList.remove("resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const style = horizontal
    ? { left: pct(at), top: pct(box.y), height: pct(box.h) }
    : { top: pct(at), left: pct(box.x), width: pct(box.w) };
  return (
    <div
      className={"divider divider-" + split.dir}
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      title={t("split.resizeHint")}
      style={style}
      onMouseDown={onMouseDown}
      onDoubleClick={() => useStage.getState().equalize(split.id)}
    />
  );
}

export function Stage() {
  const tree = useStage((s) => s.tree);
  const count = useStage((s) => s.panes.length);
  const dir = useStage((s) => s.dir);
  const activePath = useWorktrees((s) => s.activePath);
  useEffect(() => { useStage.getState().switchWorktree(activePath); }, [activePath]);
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const full = count >= 4;
  const { panes, gutters } = useMemo(() => layoutRects(tree), [tree]);
  // Panes render as flat siblings keyed by pane id (in visual order, for
  // Tab order): splitting or closing changes only their boxes, so React keeps
  // the screens that stay mounted (editor state, terminals).
  const paneIds = useMemo(() => [...panes.keys()], [panes]);

  /** The stage pane under the pointer and the side of it nearest the pointer. */
  const targetAt = (e: DragEvent): DropTarget | null => {
    // `data-stage-pane` is stage-only (the Terminal screen has its own pane ids).
    const el = ((e.target as Element | null)?.closest?.("[data-stage-pane]") ??
      (count === 1 ? ref.current?.querySelector("[data-stage-pane]") : null)) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { paneId: el.dataset.stagePane!, side: nearestSide((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height) };
  };

  return (
    <div className="stage-stack">
    <OperationBanner />
    <div
      ref={ref}
      className={"stage" + (count > 1 ? " split split-" + dir : "")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(SCREEN_MIME)) return;
        e.preventDefault();
        const target = targetAt(e);
        setDrop((current) => (current?.paneId === target?.paneId && current?.side === target?.side ? current : target));
      }}
      onDragLeave={(e) => { if (!ref.current!.contains(e.relatedTarget as Node)) setDrop(null); }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(SCREEN_MIME) as ScreenId;
        const target = targetAt(e);
        setDrop(null);
        if (!id || !target) return;
        e.preventDefault();
        const stage = useStage.getState();
        const index = stage.panes.indexOf(stage.screens[target.paneId]);
        stage.openSplit(id, target.side, index >= 0 ? index : undefined);
      }}
    >
      <div ref={canvas} className="stage-canvas">
        <DropContext.Provider value={drop}>
          {paneIds.map((paneId) => {
            const box = panes.get(paneId)!;
            return <Pane key={paneId} paneId={paneId} x={box.x} y={box.y} w={box.w} h={box.h} />;
          })}
        </DropContext.Provider>
        {gutters.map((gutter) => <Divider key={`${gutter.split.id}:${gutter.index}`} gutter={gutter} canvas={canvas} />)}
      </div>
      {drop && full && <span className="dz-hint dz-full">{t("split.dropFull")}</span>}
    </div>
    </div>
  );
}
