import type { CSSProperties } from "react";
import type { ProfileUsage } from "./profiles";

/**
 * Prototype `useC` thresholds, theme-safe via CSS vars:
 * at/above 90% red, at/above 70% yellow, below green.
 */
export function usageTone(percent: number): string {
  if (percent >= 90) return "var(--red)";
  if (percent >= 70) return "var(--yel)";
  return "var(--grn)";
}

/**
 * Inline usage progress bar (prototype `.ubar`). Render only when the
 * profile carries live usage from a vendor-CLI hook — callers gate on
 * null, so the bar stays hidden instead of showing a fabricated number.
 */
export function UsageBar({ usage, className }: { usage: ProfileUsage; className?: string }) {
  const tone = usageTone(usage.percent);
  return (
    <span className={className ? `ubar ${className}` : "ubar"} aria-hidden="true">
      <i style={{ width: `${usage.percent}%`, "--ubar-c": tone } as CSSProperties} />
    </span>
  );
}
