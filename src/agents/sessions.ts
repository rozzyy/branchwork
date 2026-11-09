// Agent Sessions screen store (spec §6.6.2, Task 08).
// One record per agent session: a shell PTY spawned with the profile env,
// then the registry's launch argv written into it. Status detection,
// notifications, profile switching, and usage are later Stage 3 tasks.
import { create } from "zustand";
import { CLI_IDS, CLI_REGISTRY, resolveCli, type CliId } from "./registry";
import { ensureProfileDir, resolveCliBinary } from "../ipc/cli";
import {
  ensureAgentHooks,
  notifySocketPath,
  notifyWhenUnfocused,
  onAgentStatus,
} from "../ipc/notify";
import {
  closeTerminal,
  onTerminalExit,
  onTerminalOutput,
  spawnTerminal,
  stopTerminal,
  writeTerminal,
} from "../ipc/pty";
import { saveSetting } from "../ipc/settings";
import { errorMessage } from "../ipc/errors";
import { t } from "../i18n/t";
import { toast } from "../ui/toast";
import { ask } from "../ui/dialog";
import { useDock } from "../terminal/dock";
import { useProfiles, type ProfileRef } from "./profiles";
import { useSettings } from "../state/settings";
import { useWorktrees } from "../state/worktrees";

export type AgentSlot = "left" | "right" | "auto" | "full";

/** Lifecycle status (spec §6.6.3): hooks first, output heuristics as fallback. */
export type AgentStatus = "idle" | "running" | "waiting" | "done";

export interface AgentSession {
  id: string;
  cliId: CliId;
  profile: ProfileRef;
  worktreePath: string;
  sessionId: string | null;
  slot: AgentSlot;
  error: string | null;
  sharedWithDock: boolean;
  status: AgentStatus;
  /** The CLI printed a usage-limit message; the banner offers a switch. */
  limitHit: boolean;
}

export type AgentLayoutMode = "grid" | "full";

/** One launched race contestant: the session plus where it runs. */
export interface RaceEntry {
  id: string;
  cliId: CliId;
  worktreePath: string;
}

export const STOP_GRACE_MS = 3000;

let sessionCounter = 0;
function nextSessionId(): string {
  sessionCounter += 1;
  return `agent-${Date.now().toString(36)}-${sessionCounter}`;
}

function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// Sessions whose process already exited. Closing an exited pane skips the
// running-process confirmation.
const exitedSessions = new Set<string>();

let exitSubscription: Promise<() => void> | null = null;
let outputSubscription: Promise<() => void> | null = null;
let statusSubscription: Promise<() => void> | null = null;

/** Spec §6.6.3 fallback: quiet 4 s after activity suggests waiting input. */
export const IDLE_WAIT_MS = 4000;
/**
 * Tail carried across chunks so a pattern split over a chunk boundary still
 * matches. Longer than the longest waiting pattern; matches ending inside it
 * are stale scrollback and ignored (see `freshMatch`).
 */
const OVERLAP_CAP = 32;
const overlaps = new Map<string, string>();
/** Rolling pane output per session for handover notes (capped lines). */
const LINE_CAP = 200;
const lineBuffers = new Map<string, string[]>();

/** Socket path for hook delivery, resolved once per app lifetime. */
let notifySocket: string | null | undefined;
/** Environment hooks use to report back; empty when sockets are unavailable. */
async function hookEnv(agentId: string): Promise<Record<string, string>> {
  if (notifySocket === undefined) {
    try {
      notifySocket = await notifySocketPath();
    } catch {
      notifySocket = null;
    }
  }
  if (!notifySocket) return {};
  return {
    BRANCHWORK_AGENT_SESSION: agentId,
    BRANCHWORK_NOTIFY_SOCKET: notifySocket,
  };
}
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearSessionWatch(id: string) {
  const timer = idleTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    idleTimers.delete(id);
  }
  overlaps.delete(id);
  lineBuffers.delete(id);
}

/**
 * True when a waiting pattern ends inside the fresh chunk. Matches fully
 * inside the carried overlap (old scrollback) do not count, so a prompt
 * printed once cannot re-trigger waiting on every later chunk.
 */
function freshMatch(patterns: string[], overlapLength: number, window: string): boolean {
  const text = window.toLowerCase();
  return patterns.some((pattern) => {
    const at = text.indexOf(pattern);
    return at !== -1 && at + pattern.length > overlapLength;
  });
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon(tabs: unknown): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSetting("agentSessions", tabs), 300);
}

export interface NewAgentRequest {
  cliId: CliId;
  profile?: ProfileRef | null;
  worktreePath?: string;
  /** Sent as the session's first input line after launch (race prompts). */
  prompt?: string;
}

interface SessionsStore {
  sessions: AgentSession[];
  layoutMode: AgentLayoutMode;
  newAgentOpen: boolean;
  /** Source session id for the Handover dialog, or null when closed. */
  handoverFor: string | null;
  /** Race dialog visibility and its launched entries. */
  raceOpen: boolean;
  raceEntries: RaceEntry[];
  loaded: boolean;
  setNewAgentOpen(open: boolean): void;
  setHandoverFor(id: string | null): void;
  setRaceOpen(open: boolean): void;
  addRaceEntry(entry: RaceEntry): void;
  removeRaceEntry(id: string): void;
  /** True when the session's process already exited (never throws). */
  isExited(sessionId: string | null): boolean;
  /**
   * External status signal (hook/notify binary). `waiting` marks a live
   * session; `done` mirrors the PTY exit. Unknown sessions are ignored.
   */
  notifySessionEvent(sessionId: string, event: "waiting" | "done"): void;
  /** Binary availability per CLI, resolved on demand for the New Agent flow. */
  checkBinaries(): Promise<Record<CliId, string | null>>;
  startSession(request: NewAgentRequest): Promise<string | null>;
  closeSession(id: string, opts?: { confirm?: boolean }): Promise<void>;
  /**
   * Relaunch the session under another profile of the same CLI, keeping the
   * worktree and resuming the conversation. Confirms when running unless
   * `skipConfirm` (limit-driven switches already carry user consent via the
   * toast/banner/auto-switch setting); refuses dock-shared sessions. Returns
   * the session id, or null when refused.
   */
  switchProfile(id: string, profile: ProfileRef, skipConfirm?: boolean): Promise<string | null>;
  /** Switch to the next profile of the same CLI (cycle); toasts when alone. */
  switchToNextProfile(id: string, skipConfirm?: boolean): Promise<string | null>;
  /** Hide the usage-limit banner without switching. */
  dismissLimit(id: string): void;
  /** Last pane output lines (oldest first), capped for handover notes. */
  getOutputTail(id: string, count?: number): string[];
  toggleSlot(id: string, side: "left" | "right" | "full"): void;
  setLayoutMode(mode: AgentLayoutMode): void;
  moveToDock(id: string): void;
  load(): Promise<void>;
}

export const useSessions = create<SessionsStore>((set, get) => {
  const save = () =>
    persistSoon({
      sessions: get().sessions.map((session) => ({ ...session, sessionId: null, error: null })),
      layoutMode: get().layoutMode,
    });

  const findSession = (id: string): AgentSession | undefined =>
    get().sessions.find((session) => session.id === id);

  const updateSession = (id: string, patch: Partial<AgentSession>) =>
    set({ sessions: get().sessions.map((session) => (session.id === id ? { ...session, ...patch } : session)) });

  /** Mark a live session waiting and tell the user once per transition. */
  const setWaiting = (id: string) => {
    const session = findSession(id);
    if (!session || session.status !== "running" || !session.sessionId) return;
    if (exitedSessions.has(session.sessionId)) return;
    updateSession(id, { status: "waiting" });
    save();
    const title = t("agents.waitingTitle", { name: CLI_REGISTRY[session.cliId].name });
    toast({ title, icon: "⏳" });
    void notifyWhenUnfocused(title).catch(() => undefined);
  };

  const scheduleIdle = (id: string) => {
    const current = idleTimers.get(id);
    if (current !== undefined) clearTimeout(current);
    idleTimers.set(
      id,
      setTimeout(() => {
        idleTimers.delete(id);
        const session = findSession(id);
        if (session && session.status === "running") setWaiting(id);
      }, IDLE_WAIT_MS),
    );
  };

  /** Feed one PTY output chunk through the §6.6.3 heuristic fallback. */
  const noteSessionActivity = (sessionId: string, text: string) => {
    const session = get().sessions.find((item) => item.sessionId === sessionId);
    if (!session || !session.sessionId || exitedSessions.has(session.sessionId)) return;
    if (session.status !== "running" && session.status !== "waiting") return;
    const lines = lineBuffers.get(session.id) ?? [];
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.length > 0) lines.push(line);
    }
    lineBuffers.set(session.id, lines.slice(-LINE_CAP));
    const tail = (overlaps.get(session.id) ?? "").slice(-OVERLAP_CAP);
    const window = tail + text;
    overlaps.set(session.id, window.slice(-OVERLAP_CAP));
    if (session.status === "waiting") {
      // Fresh output means the agent (or the user) acted: back to running.
      updateSession(session.id, { status: "running" });
      save();
    }
    scheduleIdle(session.id);
    const def = CLI_REGISTRY[session.cliId];
    if (freshMatch(def.waitingPatterns, tail.length, window)) setWaiting(session.id);
    if (freshMatch(def.limitPatterns, tail.length, window)) onLimitHit(session.id);
  };

  /** A usage-limit message appeared: waiting + banner, then switch or not. */
  const onLimitHit = (id: string) => {
    const session = findSession(id);
    if (!session || !session.sessionId || exitedSessions.has(session.sessionId)) return;
    if (session.status !== "running" && session.status !== "waiting") return;
    if (!session.limitHit) {
      updateSession(id, { limitHit: true });
      save();
    }
    setWaiting(id);
    const def = CLI_REGISTRY[session.cliId];
    if (useSettings.getState().agentAutoSwitch) {
      void get().switchToNextProfile(id, true);
      return;
    }
    toast({
      title: t("agents.limitToast", { name: def.name }),
      icon: "⚠",
      action: { label: t("agents.limitSwitch"), run: () => void get().switchToNextProfile(id, true) },
    });
  };

  /** Spawn the shell and write the argv; returns the PTY session or an error. */
  const spawnAgentShell = async (
    agentId: string,
    cliId: CliId,
    profile: ProfileRef,
    worktreePath: string,
    argv: string[],
    prefix: string[] = [],
  ): Promise<{ sessionId: string } | { error: string }> => {
    let profileDir: string;
    try {
      profileDir = await ensureProfileDir(profile.cliId, profile.slug);
    } catch (error) {
      return { error: errorMessage(error) };
    }
    // Hook setup is best-effort: a missing sidecar or unsupported CLI only
    // loses the primary signal; the output heuristics still apply.
    void ensureAgentHooks(cliId, profileDir).catch(() => false);
    const env = {
      ...resolveCli(CLI_REGISTRY[cliId]).envFor(profileDir),
      ...(await hookEnv(agentId).catch(() => ({}))),
    };
    let sessionId: string;
    try {
      const spawned = await spawnTerminal(worktreePath, 80, 24, env);
      sessionId = spawned.sessionId;
    } catch (error) {
      return { error: errorMessage(error) };
    }
    try {
      for (const line of prefix) {
        await writeTerminal(sessionId, new TextEncoder().encode(`${line}\n`));
      }
      await writeTerminal(sessionId, new TextEncoder().encode(`${argv.map(quoteArg).join(" ")}\n`));
      return { sessionId };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  };

  return {
    sessions: [],
    layoutMode: "grid",
    newAgentOpen: false,
    handoverFor: null,
    raceOpen: false,
    raceEntries: [],
    loaded: false,

    setNewAgentOpen(open) {
      if (get().newAgentOpen !== open) set({ newAgentOpen: open });
    },

    setRaceOpen(open) {
      if (get().raceOpen !== open) set({ raceOpen: open });
    },

    addRaceEntry(entry) {
      if (!get().raceEntries.some((item) => item.id === entry.id)) {
        set({ raceEntries: [...get().raceEntries, entry] });
      }
    },

    removeRaceEntry(id) {
      set({ raceEntries: get().raceEntries.filter((item) => item.id !== id) });
    },

    setHandoverFor(id) {
      if (get().handoverFor !== id) set({ handoverFor: id });
    },

    isExited(sessionId) {
      return !!sessionId && exitedSessions.has(sessionId);
    },

    notifySessionEvent(sessionId, event) {
      const session = get().sessions.find(
        (item) => item.id === sessionId || item.sessionId === sessionId,
      );
      if (!session) return;
      if (event === "done") {
        exitedSessions.add(sessionId);
        clearSessionWatch(session.id);
        updateSession(session.id, { status: "done" });
        save();
        return;
      }
      setWaiting(session.id);
    },

    async checkBinaries() {
      const entries = await Promise.all(
        CLI_IDS.filter((id) => id !== "custom").map(async (cliId) => {
          try {
            return [cliId, await resolveCliBinary(CLI_REGISTRY[cliId].binary)] as const;
          } catch {
            return [cliId, null] as const;
          }
        }),
      );
      return Object.fromEntries(entries) as Record<CliId, string | null>;
    },

    async startSession(request) {
      const def = CLI_REGISTRY[request.cliId];
      const profile =
        (request.profile &&
        request.profile.cliId === request.cliId &&
        useProfiles.getState().profiles.some(
          (candidate) => candidate.cliId === request.profile!.cliId && candidate.slug === request.profile!.slug,
        )
          ? request.profile
          : useProfiles.getState().resolveProfile(request.cliId)) ?? null;
      if (!profile) {
        toast({ title: t("agents.profileRequired", { name: def.name }), icon: "⚠" });
        return null;
      }
      const worktreePath = request.worktreePath ?? useWorktrees.getState().activePath;
      if (!worktreePath) {
        toast({ title: t("agents.worktreeRequired", { name: def.name }), icon: "⚠" });
        return null;
      }
      let binary: string | null = null;
      if (def.binary) {
        try {
          binary = await resolveCliBinary(def.binary);
        } catch {
          binary = null;
        }
      }
      if (def.binary && !binary) {
        toast({ title: t("agents.installTitle", { name: def.name }), icon: def.icon });
        return null;
      }
      let launch: string[];
      try {
        launch = resolveCli(def).launch;
      } catch (error) {
        toast({ title: errorMessage(error), icon: "⚠" });
        return null;
      }
      const session: AgentSession = {
        id: nextSessionId(),
        cliId: request.cliId,
        profile,
        worktreePath,
        sessionId: null,
        slot: "auto",
        error: null,
        sharedWithDock: false,
        status: "idle",
        limitHit: false,
      };
      set({ sessions: [...get().sessions, session] });
      const result = await spawnAgentShell(
        session.id,
        request.cliId,
        profile,
        worktreePath,
        launch,
        request.prompt ? [request.prompt] : [],
      );
      const live = findSession(session.id);
      if (!live) {
        if ("sessionId" in result) {
          try {
            await closeTerminal(result.sessionId);
          } catch {
            // The backend session is already gone; nothing left to clean up.
          }
        }
        return null;
      }
      if ("sessionId" in result) {
        exitedSessions.delete(result.sessionId);
        updateSession(session.id, { sessionId: result.sessionId, error: null, status: "running" });
        scheduleIdle(session.id);
      } else {
        updateSession(session.id, { error: result.error });
        toast({ title: t("agents.spawnError", { name: def.name, message: result.error }), icon: "⚠" });
      }
      save();
      return session.id;
    },

    getOutputTail(id, count = 50) {
      const lines = lineBuffers.get(id) ?? [];
      return lines.slice(-Math.max(1, count));
    },

    async closeSession(id, opts) {
      const session = findSession(id);
      if (!session) return;
      const alreadyExited = !session.sessionId || exitedSessions.has(session.sessionId);
      const running = !!session.sessionId && !alreadyExited && !session.sharedWithDock;
      if (running && opts?.confirm !== false) {
        const def = CLI_REGISTRY[session.cliId];
        const confirmed = await ask({
          title: t("agents.closeTitle", { name: def.name }),
          body: t("agents.closeBody"),
          ok: t("agents.closeOk"),
          danger: true,
          icon: def.icon,
        });
        if (confirmed !== true) return;
      }
      // A session shared with the dock stays alive there: the grid pane only
      // detaches, and the dock owns PTY cleanup. An already-exited session
      // needs no stop (the backend reports it gone).
      if (session.sessionId && !session.sharedWithDock && !alreadyExited) {
        try {
          await stopTerminal(session.sessionId, STOP_GRACE_MS);
        } catch (error) {
          toast({ title: errorMessage(error), icon: "⚠" });
          return;
        }
        exitedSessions.delete(session.sessionId);
      }
      const removed = { ...session };
      clearSessionWatch(id);
      set({ sessions: get().sessions.filter((item) => item.id !== id) });
      save();
      const def = CLI_REGISTRY[removed.cliId];
      toast({
        title: t("agents.closed", { name: def.name }),
        icon: def.icon,
        action: {
          label: t("toast.undo"),
          undo: true,
          enabled: !!removed.sessionId || !!removed.error,
          run: () => {
            void (async () => {
              const profile = useProfiles
                .getState()
                .profiles.find(
                  (candidate) =>
                    candidate.cliId === removed.profile.cliId && candidate.slug === removed.profile.slug,
                );
              if (!profile) {
                toast({ title: t("agents.profileRequired", { name: def.name }), icon: "⚠" });
                return;
              }
              const result = await spawnAgentShell(
                removed.id,
                removed.cliId,
                removed.profile,
                removed.worktreePath,
                resolveCli(def).resume,
              );
              if (!("sessionId" in result)) {
                toast({
                  title: t("agents.spawnError", { name: def.name, message: result.error }),
                  icon: "⚠",
                });
                return;
              }
              exitedSessions.delete(result.sessionId);
              set({
                sessions: [
                  ...get().sessions,
                  { ...removed, id: nextSessionId(), sessionId: result.sessionId, error: null, sharedWithDock: false },
                ],
              });
              save();
            })();
          },
        },
      });
    },

    async switchProfile(id, profile, skipConfirm = false) {
      const session = findSession(id);
      if (!session) return null;
      if (session.profile.cliId === profile.cliId && session.profile.slug === profile.slug) return id;
      const def = CLI_REGISTRY[session.cliId];
      if (profile.cliId !== session.cliId) {
        toast({ title: t("agents.switchWrongCli"), icon: "⚠" });
        return null;
      }
      const target = useProfiles
        .getState()
        .profiles.find((p) => p.cliId === profile.cliId && p.slug === profile.slug);
      if (!target) {
        toast({ title: t("agents.profileRequired", { name: def.name }), icon: "⚠" });
        return null;
      }
      if (session.sharedWithDock) {
        toast({ title: t("agents.switchShared"), icon: "⚠" });
        return null;
      }
      const currentName =
        useProfiles
          .getState()
          .profiles.find(
            (p) => p.cliId === session.profile.cliId && p.slug === session.profile.slug,
          )?.name ?? session.profile.slug;
      const running = !!session.sessionId && !exitedSessions.has(session.sessionId);
      if (running && !skipConfirm) {
        const confirmed = await ask({
          title: t("agents.switchTitle", { name: def.name }),
          body: t("agents.switchBody", { from: currentName, to: target.name }),
          ok: t("agents.switchOk"),
          icon: def.icon,
        });
        if (confirmed !== true) return null;
      }
      if (session.sessionId) {
        try {
          await stopTerminal(session.sessionId, STOP_GRACE_MS);
        } catch (error) {
          toast({ title: errorMessage(error), icon: "⚠" });
          return null;
        }
        exitedSessions.add(session.sessionId);
        try {
          await closeTerminal(session.sessionId);
        } catch {
          // Already gone; the new shell replaces it below.
        }
      }
      clearSessionWatch(id);
      let resume: string[];
      try {
        resume = resolveCli(def).resume;
      } catch (error) {
        toast({ title: errorMessage(error), icon: "⚠" });
        return null;
      }
      const dimmed = `\x1b[2m${t("agents.switchLine", { from: currentName, to: target.name })}\x1b[0m`;
      const result = await spawnAgentShell(
        id,
        session.cliId,
        profile,
        session.worktreePath,
        resume,
        [dimmed],
      );
      if (!("sessionId" in result)) {
        updateSession(id, { error: result.error, status: "idle" });
        toast({ title: t("agents.spawnError", { name: def.name, message: result.error }), icon: "⚠" });
        save();
        return null;
      }
      exitedSessions.delete(result.sessionId);
      updateSession(id, {
        profile,
        sessionId: result.sessionId,
        error: null,
        status: "running",
        limitHit: false,
      });
      scheduleIdle(id);
      save();
      return id;
    },

    async switchToNextProfile(id, skipConfirm = false) {
      const session = findSession(id);
      if (!session) return null;
      const options = useProfiles.getState().profiles.filter((p) => p.cliId === session.cliId);
      if (options.length < 2) {
        toast({ title: t("agents.switchNeedTwo", { name: CLI_REGISTRY[session.cliId].name }), icon: "⚠" });
        return null;
      }
      const at = options.findIndex((p) => p.slug === session.profile.slug);
      const next = options[(at + 1) % options.length];
      return get().switchProfile(id, { cliId: next.cliId, slug: next.slug }, skipConfirm);
    },

    dismissLimit(id) {
      const session = findSession(id);
      if (session && session.limitHit) {
        updateSession(id, { limitHit: false });
        save();
      }
    },

    toggleSlot(id, side) {
      const session = findSession(id);
      if (!session) return;
      if (session.slot === side) {
        updateSession(id, { slot: "auto" });
      } else {
        // Toggling a side moves any conflicting pane to the other side.
        const other = side === "full" ? null : (side === "left" ? "right" : "left");
        set({
          sessions: get().sessions.map((item) => {
            if (item.id === id) return { ...item, slot: side };
            if (other && item.slot === side) return { ...item, slot: other };
            return item;
          }),
        });
      }
      save();
    },

    setLayoutMode(mode) {
      if (get().layoutMode !== mode) {
        set({ layoutMode: mode });
        save();
      }
    },

    moveToDock(id) {
      const session = findSession(id);
      if (!session?.sessionId || exitedSessions.has(session.sessionId)) {
        toast({ title: t("agents.moveNeedsSession"), icon: "⚠" });
        return;
      }
      useDock.getState().adoptExisting(session.worktreePath, session.sessionId);
      updateSession(id, { sharedWithDock: true });
      save();
    },

    async load() {
      if (exitSubscription === null) {
        const subscribed = onTerminalExit((event) => {
          exitedSessions.add(event.sessionId);
          const session = get().sessions.find((item) => item.sessionId === event.sessionId);
          if (session) {
            clearSessionWatch(session.id);
            updateSession(session.id, { status: "done" });
            save();
            if (event.exitCode !== 0 || event.signal) {
              void notifyWhenUnfocused(
                t("agents.doneTitle", { name: CLI_REGISTRY[session.cliId].name }),
              ).catch(() => undefined);
            }
          }
          // A clean agent exit closes its pane immediately (the Undo toast
          // offers relaunch). Abnormal exits keep the pane so the error stays
          // visible.
          if (event.exitCode === 0 && !event.signal) {
            if (session && !session.sharedWithDock) {
              void get().closeSession(session.id);
            }
          }
        });
        exitSubscription = subscribed;
        subscribed.catch(() => {
          if (exitSubscription === subscribed) exitSubscription = null;
        });
      }
      if (outputSubscription === null) {
        const subscribed = onTerminalOutput((event) => {
          if (!event.sessionId) return;
          try {
            noteSessionActivity(event.sessionId, new TextDecoder().decode(Uint8Array.from(event.data)));
          } catch {
            // Binary chunks carry no matchable text; the idle timer still runs.
            noteSessionActivity(event.sessionId, "");
          }
        });
        outputSubscription = subscribed;
        subscribed.catch(() => {
          if (outputSubscription === subscribed) outputSubscription = null;
        });
      }
      if (statusSubscription === null) {
        const subscribed = onAgentStatus((event) => {
          get().notifySessionEvent(event.sessionId, event.event);
        });
        statusSubscription = subscribed;
        subscribed.catch(() => {
          if (statusSubscription === subscribed) statusSubscription = null;
        });
      }
      set({ loaded: true });
    },
  };
});
