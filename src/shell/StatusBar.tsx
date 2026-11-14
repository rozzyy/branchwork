import { t } from "../i18n/t";
import { useWorktrees } from "../state/worktrees";
import { useSessions } from "../agents/sessions";
import { useDock } from "../terminal/dock";
import { StatusLabel } from "../ui/StatusLabel";

export function StatusBar() {
  const activePath = useWorktrees((s) => s.activePath);
  const worktree = useWorktrees((s) => s.worktrees.find((w) => w.path === s.activePath) ?? null);
  const sessionCount = useSessions((s) => s.sessions.filter((x) => x.worktreePath === activePath && x.status !== "done").length);
  const waiting = useSessions((s) => s.sessions.filter((x) => x.worktreePath === activePath && x.status === "waiting").length);
  const dockOpen = useDock((s) => s.open);
  return <footer className="status-bar">
    <span className="status-branch mono">{worktree?.branch ?? (activePath ? t("sidebar.detached") : t("sidebar.noWorktree"))}</span>
    {worktree && <><StatusLabel tone={worktree.dirtyCount ? "warn" : "ok"} icon={worktree.dirtyCount ? "●" : "✓"}>{worktree.dirtyCount ? t("sidebar.changed", { count: worktree.dirtyCount }) : t("sidebar.clean")}</StatusLabel>
      {(worktree.ahead || worktree.behind) > 0 && <span className="status-sync">↑{worktree.ahead} ↓{worktree.behind}</span>}</>}
    {sessionCount > 0 && <StatusLabel tone="agent" icon="✦">{t("status.agents", { count: sessionCount, waiting })}</StatusLabel>}
    <button className="status-dock" aria-pressed={dockOpen} onClick={() => useDock.getState().toggle()}>❯_ {t("status.terminal")} <kbd>⌃`</kbd></button>
  </footer>;
}
