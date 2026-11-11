import type { ReactNode } from "react";

export function ScreenLoader({ children }: { children: ReactNode }) {
  return (
    <div className="placeholder">
      <span role="status" aria-live="polite">
        <span className="spin" aria-hidden="true" /> {children}
      </span>
    </div>
  );
}
