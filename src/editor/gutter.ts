import { gutter, GutterMarker } from "@codemirror/view";
import {
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type Text,
} from "@codemirror/state";
import type { DiffModel } from "../ipc/diff";

export class GitGutterMarker extends GutterMarker {
  constructor(readonly kind: "a" | "m" | "d") {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = `gm gm-${this.kind}`;
    return el;
  }
}

export const setGitMarkersEffect = StateEffect.define<RangeSet<GutterMarker>>();

export const gitGutterField = StateField.define<RangeSet<GutterMarker>>({
  create() {
    return RangeSet.empty;
  },
  update(markers, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGitMarkersEffect)) {
        return effect.value;
      }
    }
    return markers.map(tr.changes);
  },
});

export function computeGutterMarkers(diff: DiffModel | null, doc: Text): RangeSet<GutterMarker> {
  if (!diff || !diff.hunks || diff.hunks.length === 0 || doc.length === 0) {
    return RangeSet.empty;
  }

  const builder = new RangeSetBuilder<GutterMarker>();
  const lineMarkers = new Map<number, "a" | "m" | "d">();

  for (const hunk of diff.hunks) {
    const hasAdd = hunk.lines.some((l) => l.kind === "add");
    const hasDel = hunk.lines.some((l) => l.kind === "del");

    if (hasAdd && hasDel) {
      for (const line of hunk.lines) {
        if (line.kind === "add" && line.new != null) {
          lineMarkers.set(line.new, "m");
        }
      }
    } else if (hasAdd) {
      for (const line of hunk.lines) {
        if (line.kind === "add" && line.new != null) {
          lineMarkers.set(line.new, "a");
        }
      }
    } else if (hasDel) {
      const target = Math.min(Math.max(1, hunk.newStart), doc.lines);
      lineMarkers.set(target, "d");
    }
  }

  const sortedLines = Array.from(lineMarkers.keys()).sort((a, b) => a - b);
  for (const lineNum of sortedLines) {
    if (lineNum >= 1 && lineNum <= doc.lines) {
      const linePos = doc.line(lineNum).from;
      builder.add(linePos, linePos, new GitGutterMarker(lineMarkers.get(lineNum)!));
    }
  }

  return builder.finish();
}

export const gitGutterExtension: Extension = [
  gitGutterField,
  gutter({
    class: "cm-gutter-git",
    markers: (view) => view.state.field(gitGutterField),
    initialSpacer: () => new GitGutterMarker("m"),
  }),
];
