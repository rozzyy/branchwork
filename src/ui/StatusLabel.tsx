import type { ReactNode } from "react";

export type StatusTone = "ok" | "warn" | "bad" | "agent" | "info";

/** Status is always icon + text: a colored dot/word alone is never the only signal. */
export function StatusLabel({ tone, icon, children }: { tone: StatusTone; icon: string; children: ReactNode }) {
  return (
    <span className={`status ${tone}`}>
      <span aria-hidden="true">{icon}</span>
      {children}
    </span>
  );
}

export type CountTone = "neutral" | "warn" | "bad" | "agent";

export function CountBadge({ count, tone = "neutral", label }: { count: number | string; tone?: CountTone; label: string }) {
  return (
    <span className={tone === "neutral" ? "count" : `count ${tone}`} role="status" aria-label={label}>
      {count}
    </span>
  );
}
