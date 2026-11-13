// Per-pane session usage (spec: agent session usage and token saver).
// Polls the Rust log readers for live panes and keeps a small view model per
// session. Nothing is persisted: the readers rebuild totals from the CLI's
// own logs. Each tick costs one IPC call per live pane (at most one in
// flight per pane); readers are incremental on the Rust side.
import { useEffect } from "react";
import { create } from "zustand";
import type { SaverStats, TokenCounts } from "../ipc/bindings";
import { ensureProfileDir } from "../ipc/cli";
import { readSaverStats, readSessionUsage } from "../ipc/sessionUsage";
import { resetLabel } from "./probe";
import { useProfiles } from "./profiles";
import { useSessions, type AgentSession } from "./sessions";
import type { CliId } from "./registry";

export const USAGE_POLL_MS = 5000;

/** CLIs with a verified local session-log reader. */
const USAGE_CLIS: CliId[] = ["claude", "codex"];

export type UsageView =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "unavailable" }
  | { kind: "none" }
  | { kind: "ok"; tokens: TokenCounts; percent: number | null; stale: boolean };

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const inFlight = new Set<string>();

interface SessionUsageStore {
  views: Record<string, UsageView>;
  savings: Record<string, SaverStats>;
  /** One refresh tick over the live sessions; drops state for the rest. */
  poll(sessions: AgentSession[]): Promise<void>;
}

/** Two live panes on one CLI + profile + worktree share a log dir: not attributable. */
function ambiguous(session: AgentSession, sessions: AgentSession[]): boolean {
  return sessions.some(
    (other) =>
      other.id !== session.id &&
      other.cliId === session.cliId &&
      other.profile.slug === session.profile.slug &&
      other.worktreePath === session.worktreePath,
  );
}

export const useSessionUsage = create<SessionUsageStore>((set, get) => {
  const setView = (id: string, view: UsageView) => set({ views: { ...get().views, [id]: view } });

  const refresh = async (session: AgentSession) => {
    const previous = get().views[session.id];
    try {
      const profileDir = await ensureProfileDir(session.profile.cliId, session.profile.slug);
      const usage = await readSessionUsage(session.cliId, profileDir, session.worktreePath, session.startedAt ?? 0);
      if (usage.state === "unsupported") return setView(session.id, { kind: "unsupported" });
      if (usage.state === "noData") return setView(session.id, { kind: "none" });
      const percent =
        usage.contextUsed != null && usage.contextLimit != null && usage.contextLimit > 0
          ? Math.min(100, Math.max(0, Math.round((usage.contextUsed / usage.contextLimit) * 100)))
          : null;
      setView(session.id, { kind: "ok", tokens: usage.tokens, percent, stale: false });
      if (usage.quota) {
        const window = usage.quota.resetsAt != null ? resetLabel(usage.quota.resetsAt * 1000 - Date.now()) : "";
        useProfiles.getState().setProfileUsage(session.profile, { percent: usage.quota.percent, window });
      }
    } catch {
      // A failed read is never shown as zero: keep the last value, marked stale.
      setView(session.id, previous?.kind === "ok" ? { ...previous, stale: true } : { kind: "unavailable" });
    }
  };

  const refreshSavings = async (session: AgentSession) => {
    try {
      const stats = await readSaverStats(session.id);
      set({ savings: { ...get().savings, [session.id]: stats } });
    } catch {
      // Savings stay unknown; the badge then shows no figure.
    }
  };

  return {
    views: {},
    savings: {},

    async poll(sessions) {
      const live = new Set(sessions.map((session) => session.id));
      const keep = <T,>(record: Record<string, T>) =>
        Object.fromEntries(Object.entries(record).filter(([id]) => live.has(id)));
      set({ views: keep(get().views), savings: keep(get().savings) });
      await Promise.all(
        sessions.map(async (session) => {
          if (!USAGE_CLIS.includes(session.cliId)) return setView(session.id, { kind: "unsupported" });
          if (ambiguous(session, sessions)) return setView(session.id, { kind: "unavailable" });
          if (inFlight.has(session.id)) return;
          inFlight.add(session.id);
          if (!get().views[session.id]) setView(session.id, { kind: "loading" });
          try {
            await Promise.all([
              refresh(session),
              session.savers.rtk === "active" ? refreshSavings(session) : Promise.resolve(),
            ]);
          } finally {
            inFlight.delete(session.id);
          }
        }),
      );
    },
  };
});

/** Poll usage every 5 s for panes with a live PTY while the caller is mounted. */
export function useUsagePolling(): void {
  useEffect(() => {
    const tick = () => {
      const { sessions, isExited } = useSessions.getState();
      const live = sessions.filter((session) => session.sessionId && !isExited(session.sessionId));
      void useSessionUsage.getState().poll(live);
    };
    tick();
    const timer = setInterval(tick, USAGE_POLL_MS);
    return () => clearInterval(timer);
  }, []);
}
