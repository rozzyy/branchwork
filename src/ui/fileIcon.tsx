import type { CSSProperties } from "react";

const EXT_COLORS: Record<string, string> = {
  ts: "var(--blu)",
  tsx: "oklch(.78 .12 210)",
  json: "var(--yel)",
  md: "var(--fg2)",
};
const EXT_LABELS: Record<string, string> = { ts: "ts", tsx: "tsx", json: "{}", md: "md" };

/** Small extension-colored badge (prototype's `ficH`): `ts`/`tsx`/`json`/`md` get a distinct
 * color and short label; anything else falls back to a generic dim "··" marker. */
export function FileIcon({ path }: { path: string }) {
  const ext = path.split(".").pop() ?? "";
  const color = EXT_COLORS[ext] ?? "var(--fg3)";
  const label = EXT_LABELS[ext] ?? "··";
  return (
    <span aria-hidden className="file-icon" style={{ "--file-icon-color": color } as CSSProperties}>
      {label}
    </span>
  );
}
