// Orca-style account usage for agent panes: provider quota windows (5-hour,
// weekly, …) with percentages and reset countdowns, read from each CLI's
// own local state. Quota belongs to the profile, so one read serves every
// pane on that profile; each tick costs one IPC call per distinct live
// profile (at most one in flight each) plus one per RTK-active session.
import { useEffect } from "react";
import { create } from "zustand";
import type { QuotaWindow, SaverStats } from "../ipc/bindings";
import { ensureProfileDir } from "../ipc/cli";
import { readProfileQuota, readSaverStats } from "../ipc/quota";
import { t } from "../i18n/t";
import { useProfiles, usageKey } from "./profiles";
import { useSessions, type AgentSession } from "./sessions";
import type { CliId } from "./registry";

export const METER_POLL_MS = 15_000;
/** Orca's warning threshold. */
export const QUOTA_WARN_PERCENT = 80;

/** CLIs whose local state records provider quota windows. */
const QUOTA_CLIS: CliId[] = ["claude", "codex"];

export type QuotaView =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "unavailable" }
  | { kind: "none" }
  | { kind: "ok"; windows: QuotaWindow[]; fetchedAtMs: number | null; stale: boolean };

export function windowLabel(window: QuotaWindow): string {
  const base =
    window.minutes === 300
      ? t("usage.win5h")
      : window.minutes === 10_080
        ? t("usage.winWeekly")
        : window.minutes % 1440 === 0
          ? t("usage.winDays", { n: String(window.minutes / 1440) })
          : t("usage.winHours", { n: String(Math.max(1, Math.round(window.minutes / 60))) });
  if (window.scope === "opus") return `${base} · ${t("usage.scopeOpus")}`;
  if (window.scope === "sonnet") return `${base} · ${t("usage.scopeSonnet")}`;
  return base;
}

/** "2h 5m", "2d 2h", "<1m" until `atMs`. */
export function formatReset(atMs: number, now: number): string {
  const minutes = Math.floor(Math.max(0, atMs - now) / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours >= 1 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** A window whose reset time has passed no longer describes current usage. */
export function windowExpired(window: QuotaWindow, now: number): boolean {
  return window.resetsAtMs != null && window.resetsAtMs <= now;
}

/** The most-used window that is still current, or null. */
export function tightestWindow(windows: QuotaWindow[], now: number): QuotaWindow | null {
  return windows
    .filter((window) => !windowExpired(window, now))
    .reduce<QuotaWindow | null>((best, window) => (!best || window.percent > best.percent ? window : best), null);
}

const inFlight = new Set<string>();

interface AgentMetersStore {
  /** Keyed by `usageKey(profile)`. */
  quotas: Record<string, QuotaView>;
  /** Keyed by agent session id. */
  savings: Record<string, SaverStats>;
  /** One refresh tick over the live sessions. */
  poll(sessions: AgentSession[]): Promise<void>;
}

export const useAgentMeters = create<AgentMetersStore>((set, get) => {
  const setQuota = (key: string, view: QuotaView) => set({ quotas: { ...get().quotas, [key]: view } });

  const refreshQuota = async (session: AgentSession) => {
    const key = usageKey(session.profile);
    const previous = get().quotas[key];
    try {
      const profileDir = await ensureProfileDir(session.profile.cliId, session.profile.slug);
      const quota = await readProfileQuota(session.cliId, profileDir);
      if (quota.state === "unsupported") return setQuota(key, { kind: "unsupported" });
      if (quota.state === "noData") return setQuota(key, { kind: "none" });
      setQuota(key, { kind: "ok", windows: quota.windows, fetchedAtMs: quota.fetchedAtMs ?? null, stale: false });
      // The profile chip and its menu show the tightest current window.
      const tight = tightestWindow(quota.windows, Date.now());
      useProfiles
        .getState()
        .setProfileUsage(session.profile, tight ? { percent: tight.percent, window: windowLabel(tight) } : null);
    } catch {
      // A failed read is never shown as zero: keep the last value, marked stale.
      setQuota(key, previous?.kind === "ok" ? { ...previous, stale: true } : { kind: "unavailable" });
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
    quotas: {},
    savings: {},

    async poll(sessions) {
      const live = new Set(sessions.map((session) => session.id));
      set({ savings: Object.fromEntries(Object.entries(get().savings).filter(([id]) => live.has(id))) });
      const byProfile = new Map(sessions.map((session) => [usageKey(session.profile), session]));
      await Promise.all([
        ...[...byProfile].map(async ([key, session]) => {
          if (!QUOTA_CLIS.includes(session.cliId)) return setQuota(key, { kind: "unsupported" });
          if (inFlight.has(key)) return;
          inFlight.add(key);
          if (!get().quotas[key]) setQuota(key, { kind: "loading" });
          try {
            await refreshQuota(session);
          } finally {
            inFlight.delete(key);
          }
        }),
        ...sessions.filter((session) => session.savers.rtk === "active").map(refreshSavings),
      ]);
    },
  };
});

/** Poll meters for panes with a live PTY while the caller is mounted. */
export function useAgentMeterPolling(): void {
  useEffect(() => {
    const tick = () => {
      const { sessions, isExited } = useSessions.getState();
      const live = sessions.filter((session) => session.sessionId && !isExited(session.sessionId));
      void useAgentMeters.getState().poll(live);
    };
    tick();
    const timer = setInterval(tick, METER_POLL_MS);
    return () => clearInterval(timer);
  }, []);
}
