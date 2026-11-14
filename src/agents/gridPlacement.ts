// Explicit placement for the Agents grid (two columns). CSS auto-placement
// gives every row the same height, so a lone left pane next to two stacked
// right panes only filled the top half. Here each column's panes share the
// column's full height: the block uses lcm(left, right) rows and a pane spans
// rows / (panes in its column). Full-width panes follow, one pane-height each.
import type { AgentSlot } from "./sessions";

export interface GridPlace {
  /** CSS `grid-column` value. */
  column: string;
  /** CSS `grid-row` value. */
  row: string;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;

/** O(n) for n visible panes; `rows` is the grid's explicit row count. */
export function gridPlacement(panes: Array<{ id: string; slot: AgentSlot }>): { rows: number; places: Map<string, GridPlace> } {
  const left: string[] = [];
  const right: string[] = [];
  const full: string[] = [];
  for (const { id, slot } of panes) {
    if (slot === "left") left.push(id);
    else if (slot === "right") right.push(id);
    else if (slot === "full") full.push(id);
  }
  // Auto panes go to the emptier column (left on a tie), in order.
  for (const { id, slot } of panes) {
    if (slot === "auto") (left.length <= right.length ? left : right).push(id);
  }
  const counts = [left.length, right.length].filter((count) => count > 0);
  const blockRows = counts.length === 0 ? 0 : counts.reduce(lcm);
  // One pane-height in grid rows: the taller column's pane size.
  const unit = blockRows === 0 ? 1 : blockRows / Math.max(left.length, right.length);
  const places = new Map<string, GridPlace>();
  [left, right].forEach((column, index) => {
    const span = column.length > 0 ? blockRows / column.length : 0;
    column.forEach((id, i) => places.set(id, { column: String(index + 1), row: `${1 + i * span} / span ${span}` }));
  });
  full.forEach((id, i) => places.set(id, { column: "1 / -1", row: `${blockRows + 1 + i * unit} / span ${unit}` }));
  return { rows: blockRows + full.length * unit, places };
}
