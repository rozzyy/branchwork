import { useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from "react";
import { useStage } from "../state/stage";
import { Pane } from "./Pane";
import { nearestSide, type Side } from "./stageModel";
import { SCREEN_MIME, sideLabel } from "./dnd";
import type { ScreenId } from "../screens/registry";
import { t } from "../i18n/t";

export function Stage() {
  const panes = useStage((s) => s.panes);
  const dir = useStage((s) => s.dir);
  const ratio = useStage((s) => s.ratio);
  const ref = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<Side | null>(null);
  const two = panes.length > 1;

  const onDividerDown = (e: MouseEvent) => {
    e.preventDefault();
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    el.classList.add("resizing");
    const move = (ev: globalThis.MouseEvent) =>
      useStage.getState().setRatio(dir === "h" ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height);
    const up = () => {
      el.classList.remove("resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const sideAt = (e: DragEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return nearestSide((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };

  return (
    <div
      ref={ref}
      className={"stage" + (two ? " split-" + dir : "")}
      style={{ "--r": ratio } as CSSProperties}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(SCREEN_MIME)) return;
        e.preventDefault();
        setDrop(sideAt(e));
      }}
      onDragLeave={(e) => { if (!ref.current!.contains(e.relatedTarget as Node)) setDrop(null); }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(SCREEN_MIME) as ScreenId;
        setDrop(null);
        if (!id) return;
        e.preventDefault();
        useStage.getState().openSplit(id, sideAt(e));
      }}
    >
      <Pane index={0} />
      {two && (
        <div
          className="divider"
          role="separator"
          aria-orientation={dir === "h" ? "vertical" : "horizontal"}
          title={t("split.resizeHint")}
          onMouseDown={onDividerDown}
          onDoubleClick={() => useStage.getState().setRatio(0.5)}
        />
      )}
      {two && <Pane index={1} />}
      {drop && (
        <div className="dropzone" data-side={drop}>
          <div className="dz-hl">{t(sideLabel(drop))}</div>
          <span className="dz-hint">{t("split.dropHint")}</span>
        </div>
      )}
    </div>
  );
}
