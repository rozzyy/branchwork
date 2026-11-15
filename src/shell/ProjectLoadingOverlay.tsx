import { useEffect, useState } from "react";
import { t } from "../i18n/t";

const EXIT_ANIMATION_MS = 140;

/** Blocks the previous project's main content while the new worktree state loads. */
export function ProjectLoadingOverlay({ loading }: { loading: boolean }) {
  const [mounted, setMounted] = useState(loading);

  useEffect(() => {
    if (loading) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const timer = window.setTimeout(() => setMounted(false), EXIT_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [loading, mounted]);

  if (!loading && !mounted) return null;
  return (
    <div
      className={"project-loading-overlay" + (!loading ? " leaving" : "")}
      role="status"
      aria-live="polite"
      aria-label={t("groups.switchingProject")}
    >
      <span className="spin" aria-hidden="true" />
      <span>{t("groups.switchingProject")}</span>
    </div>
  );
}
