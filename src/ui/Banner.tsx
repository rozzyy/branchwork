import type { ReactNode } from "react";

export type BannerTone = "warn" | "bad" | "info";

/** Contextual banner: shown on every screen while an operation (merge, rebase,
 * cherry-pick, revert) is in progress. `role="status"` so it is announced. */
export function Banner({ tone, icon, title, detail, actions }: { tone: BannerTone; icon: string; title: string; detail?: string; actions: ReactNode }) {
  return (
    <div className={tone === "warn" ? "banner" : `banner ${tone}`} role="status">
      <span aria-hidden="true">{icon}</span>
      <b>{title}</b>
      {detail && <span className="muted"> · {detail}</span>}
      <span className="grow" />
      {actions}
    </div>
  );
}
