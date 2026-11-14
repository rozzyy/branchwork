// Agent Sessions screen store (spec §6.6.2, Task 08).
// One record per agent session: a shell PTY spawned with the profile env,
// then the registry's launch argv written into it. Status detection,
// notifications, profile switching, and usage are later Stage 3 tasks.
import { createElement } from "react";
import { create } from "zustand";
import { CLI_IDS, CLI_REGISTRY, resolveCli, type CliId } from "./registry";
import { CliIcon } from "./cliIcons";
import { ensureProfileDir, profileHasCredentials, resolveCliBinary } from "../ipc/cli";
import {
  ensureAgentHooks,
  ensureSaverHook,
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
  waitTerminalReady,
  writeTerminal,
} from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { errorMessage } from "../ipc/errors";
import { t } from "../i18n/t";
import { toast } from "../ui/toast";
import { ask } from "../ui/dialog";
import { useDock } from "../terminal/dock";
import { waitForTerminalAttach } from "../terminal/attachReady";
import { useProfiles, type ProfileRef } from "./profiles";
import { useSettings } from "../state/settings";
import { useStage } from "../state/stage";
import { useWorktrees } from "../state/worktrees";
import { cavemanResumeLine, sessionSavers, withCaveman, type SessionSavers } from "./savers";

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
  /** Token-saver state of the running integration (not persisted). */
  savers: SessionSavers;
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
let sessionsLoading = false;

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
/**
 * Sessions that already raised their waiting notification. Status still
 * flips running↔waiting on every heuristic cycle, but the toast + OS ping
 * fire only once per session — otherwise an agent streaming chattery
 * output re-notifies every few seconds forever.
 */
const notifiedWaiting = new Set<string>();
/** Record ids whose waiting state was declared by an agent hook (trusted). */
const hookWaiting = new Set<string>();
/** Record ids with a proven hook connection: hooks are the primary signal,
 * so the idle heuristic (always fighty with redrawing TUIs) stays off. */
const hookActive = new Set<string>();
/**
 * Rolling [timestamp, bytes] of recent PTY chunks while waiting. Terminal
 * UIs keep redrawing (cursor blink, spinner frames), so tiny chunks must
 * not fake the agent being back at work.
 */
const outputVolume = new Map<string, Array<[number, number]>>();
const PULSE_WINDOW_MS = 1500;
const PULSE_BYTES = 1024;

function clearSessionWatch(id: string) {
  const timer = idleTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    idleTimers.delete(id);
  }
  overlaps.delete(id);
  lineBuffers.delete(id);
  notifiedWaiting.delete(id);
  hookWaiting.delete(id);
  hookActive.delete(id);
  outputVolume.delete(id);
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
  /** Restore an existing session record, resuming its CLI conversation. */
  sessionRecordId?: string;
  resume?: boolean;
  slot?: AgentSlot;
  /** Background restores may run while the Agents screen is not mounted. */
  waitForAttach?: boolean;
}

interface PersistedAgentSession {
  id: string;
  cliId: CliId;
  profile: ProfileRef;
  worktreePath: string;
  slot: AgentSlot;
}

interface PersistedAgentState {
  sessions?: unknown;
  layoutMode?: unknown;
}

function isCliId(value: unknown): value is CliId {
  return typeof value === "string" && CLI_IDS.includes(value as CliId);
}

function isPersistedAgentSession(value: unknown): value is PersistedAgentSession {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  const profile = item.profile as Record<string, unknown> | null;
  return (
    typeof item.id === "string" &&
    isCliId(item.cliId) &&
    typeof profile === "object" && profile !== null &&
    profile.cliId === item.cliId && typeof profile.slug === "string" &&
    typeof item.worktreePath === "string" &&
    (item.slot === "left" || item.slot === "right" || item.slot === "auto" || item.slot === "full")
  );
}

interface SessionsStore {
  sessions: AgentSession[];
  layoutMode: AgentLayoutMode;
  newAgentOpen: boolean;
  newAgentPrompt: string | null;
  /** Source session id for the Handover dialog, or null when closed. */
  handoverFor: string | null;
  /** CLI preset for the Handover dialog target (pane switcher); cleared on close. */
  handoverTarget: CliId | null;
  /** Race dialog visibility and its launched entries. */
  raceOpen: boolean;
  raceEntries: RaceEntry[];
  loaded: boolean;
  setNewAgentOpen(open: boolean): void;
  setNewAgentPrompt(prompt: string | null): void;
  setHandoverFor(id: string | null): void;
  setHandoverTarget(cli: CliId | null): void;
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
   * the session id, or null when refused. A refused switch never stops the
   * running session: the target profile is prepared (login gate, env) before
   * the old terminal is stopped.
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
      sessions: get().sessions.map((session) => ({
        id: session.id,
        cliId: session.cliId,
        profile: session.profile,
        worktreePath: session.worktreePath,
        slot: session.slot,
      })),
      layoutMode: get().layoutMode,
    });

  const findSession = (id: string): AgentSession | undefined =>
    get().sessions.find((session) => session.id === id);

  const updateSession = (id: string, patch: Partial<AgentSession>) =>
    set({ sessions: get().sessions.map((session) => (session.id === id ? { ...session, ...patch } : session)) });

  const reportDone = (session: AgentSession) => {
    const title = t("agents.doneTitle", { name: CLI_REGISTRY[session.cliId].name });
    toast({ title, icon: createElement(CliIcon, { id: session.cliId }) });
    void notifyWhenUnfocused(title).catch(() => undefined);
  };

  /**
   * Mark a live session waiting. The status dot and sidebar badge already
   * tell the story in-app, so there is no toast; the OS ping fires once per
   * session and only when the app is unfocused. `hook` marks the signal as
   * coming from the agent hook (trusted), which the output gate treats
   * stricter than heuristic waiting.
   */
  const setWaiting = (id: string, hook = false) => {
    const session = findSession(id);
    if (!session || session.status !== "running" || !session.sessionId) return;
    if (exitedSessions.has(session.sessionId)) return;
    updateSession(id, { status: "waiting" });
    save();
    if (hook) hookWaiting.add(id);
    if (notifiedWaiting.has(id)) return;
    notifiedWaiting.add(id);
    const title = t("agents.waitingTitle", { name: CLI_REGISTRY[session.cliId].name });
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
      // Fresh output means the agent (or the user) acted: back to running —
      // but only when the output is substantial. Cursor blink and spinner
      // redraws are small bursts and must not fake "running".
      const now = Date.now();
      const pulses = (outputVolume.get(session.id) ?? []).filter(([at]) => now - at <= PULSE_WINDOW_MS);
      pulses.push([now, text.length]);
      outputVolume.set(session.id, pulses);
      if (pulses.reduce((sum, [, size]) => sum + size, 0) >= PULSE_BYTES) {
        hookWaiting.delete(session.id);
        outputVolume.delete(session.id);
        updateSession(session.id, { status: "running" });
        save();
      }
    }
    // Hooks are the primary signal (spec §6.6.3): once they are proven
    // alive for a session, the idle heuristic stays off — redrawing TUIs
    // would flip running↔waiting forever.
    if (!hookActive.has(session.id)) scheduleIdle(session.id);
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

  /**
   * Everything a launch needs except the PTY itself: profile dir, login
   * gate, and env. Prepared before any terminal is stopped, so a failed
   * profile switch cannot take the running session down with it.
   */
  const prepareAgentShell = async (
    agentId: string,
    cliId: CliId,
    profile: ProfileRef,
  ): Promise<
    { env: Record<string, string>; savers: SessionSavers } | { error: string; loginRequired?: boolean }
  > => {
    let profileDir: string;
    try {
      profileDir = await ensureProfileDir(profile.cliId, profile.slug);
    } catch (error) {
      return { error: errorMessage(error) };
    }
    // Never launch into a doomed onboarding: when the provider keeps
    // credentials in the profile dir, refuse to start until the vendor login
    // actually completed there. The toast action opens the login PTY, so one
    // click continues where the login left off. A crowded inbox of dead
    // onboarding sessions is worse than a blocked start.
    const linkedDef = CLI_REGISTRY[cliId];
    if (linkedDef.credentialPaths.length > 0 || cliId === "claude") {
      let linked: boolean | null = null;
      try {
        linked =
          linkedDef.credentialPaths.length > 0
            ? await profileHasCredentials(profile.cliId, profile.slug, linkedDef.credentialPaths)
            : await useProfiles.getState().checkProfileLogin(profile);
      } catch {
        linked = linkedDef.credentialPaths.length > 0 ? false : null;
      }
      if (linked === false) {
        const profileName =
          useProfiles
            .getState()
            .profiles.find(
              (candidate) => candidate.cliId === profile.cliId && candidate.slug === profile.slug,
            )?.name ?? profile.slug;
        const title = t("agents.loginRequired", { name: linkedDef.name, profile: profileName });
        toast({
          title,
          icon: createElement(CliIcon, { id: linkedDef.id }),
          action: {
            label: t("agents.loginNow"),
            run: () => void useProfiles.getState().loginProfile(profile),
          },
        });
        return { error: title, loginRequired: true };
      }
    }
    // Hook setup is best-effort: a missing sidecar or unsupported CLI only
    // loses the primary signal; the output heuristics still apply.
    void ensureAgentHooks(cliId, profileDir).catch(() => false);
    // Token saver (on by default): RTK counts as active only once the hook
    // sidecar confirmed installation; the env flag arms it for this session.
    const { agentTokenSaver, agentSaverProtected } = useSettings.getState();
    const rtkReady =
      agentTokenSaver &&
      sessionSavers(cliId, true, true).rtk === "active" &&
      (await ensureSaverHook(cliId, profileDir).catch(() => false));
    const savers = sessionSavers(cliId, agentTokenSaver, rtkReady);
    let env: Record<string, string>;
    try {
      env = {
        ...resolveCli(CLI_REGISTRY[cliId]).envFor(profileDir),
        ...(await hookEnv(agentId).catch(() => ({}))),
        ...(savers.rtk === "active"
          ? { BRANCHWORK_SAVER: "rtk", BRANCHWORK_SAVER_PROTECT: agentSaverProtected.join(",") }
          : {}),
      };
    } catch (error) {
      return { error: errorMessage(error) };
    }
    return { env, savers };
  };

  /** Resume/launch line with the concise-answer instruction when active. */
  const withSaverLine = (cliId: CliId, savers: SessionSavers, line: string): string =>
    savers.caveman === "active" ? cavemanResumeLine(cliId, line) : line;

  /** Spawn the shell and write one raw command line over a prepared env. */
  const spawnPreparedShell = async (
    worktreePath: string,
    env: Record<string, string>,
    command: string,
    prefix: string[] = [],
    beforeWrite?: (sessionId: string) => Promise<void>,
  ): Promise<{ sessionId: string } | { error: string }> => {
    let sessionId: string;
    try {
      const spawned = await spawnTerminal(worktreePath, 80, 24, env);
      sessionId = spawned.sessionId;
    } catch (error) {
      return { error: errorMessage(error) };
    }
    try {
      await beforeWrite?.(sessionId);
      // Issue #3: the attach above only means the view is listening. Shell wrappers (e.g. Kiro
      // CLI re-launching bash in its own PTY when `Q_TERM` is unset, as in a Finder-launched
      // app) discard typeahead until the prompt is up. On timeout we still write.
      await waitTerminalReady(sessionId).catch(() => false);
      for (const line of prefix) {
        await writeTerminal(sessionId, new TextEncoder().encode(`${line}\n`));
      }
      await writeTerminal(sessionId, new TextEncoder().encode(`${command}\n`));
      return { sessionId };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  };

  /** Spawn the shell and write the argv; returns the PTY session or an error. */
  const spawnAgentShell = async (
    agentId: string,
    cliId: CliId,
    profile: ProfileRef,
    worktreePath: string,
    argv: string[],
    prefix: string[] = [],
    beforeWrite?: (sessionId: string) => Promise<void>,
    commandOverride?: string,
  ): Promise<
    { sessionId: string; savers: SessionSavers } | { error: string; loginRequired?: boolean }
  > => {
    const ready = await prepareAgentShell(agentId, cliId, profile);
    if (!("env" in ready)) return ready;
    const command =
      commandOverride !== undefined
        ? withSaverLine(cliId, ready.savers, commandOverride)
        : (ready.savers.caveman === "active" ? withCaveman(cliId, argv) : argv).map(quoteArg).join(" ");
    const result = await spawnPreparedShell(worktreePath, ready.env, command, prefix, beforeWrite);
    return "sessionId" in result ? { ...result, savers: ready.savers } : result;
  };

  return {
    sessions: [],
    layoutMode: "grid",
    newAgentOpen: false,
    newAgentPrompt: null,
    handoverFor: null,
    handoverTarget: null,
    raceOpen: false,
    raceEntries: [],
    loaded: false,

    setNewAgentOpen(open) {
      if (get().newAgentOpen !== open) set({ newAgentOpen: open });
    },

    setNewAgentPrompt(prompt) {
      if (get().newAgentPrompt !== prompt) set({ newAgentPrompt: prompt });
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

    setHandoverTarget(cli) {
      if (get().handoverTarget !== cli) set({ handoverTarget: cli });
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
        const firstDone = session.status !== "done";
        exitedSessions.add(sessionId);
        clearSessionWatch(session.id);
        updateSession(session.id, { status: "done" });
        save();
        if (firstDone) reportDone(session);
        return;
      }
      hookActive.add(session.id);
      setWaiting(session.id, true);
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
        toast({ title: t("agents.installTitle", { name: def.name }), icon: createElement(CliIcon, { id: def.id }) });
        return null;
      }
      let launch: string[];
      let commandOverride: string | undefined;
      try {
        const resolved = resolveCli(def);
        launch = resolved.launch;
        if (request.resume) commandOverride = resolved.resumeLine ?? resolved.resume.map(quoteArg).join(" ");
      } catch (error) {
        toast({ title: errorMessage(error), icon: "⚠" });
        return null;
      }
      const session: AgentSession = {
        id: request.sessionRecordId ?? nextSessionId(),
        cliId: request.cliId,
        profile,
        worktreePath,
        sessionId: null,
        slot: request.slot ?? "auto",
        error: null,
        sharedWithDock: false,
        status: "idle",
        limitHit: false,
        savers: sessionSavers(request.cliId, useSettings.getState().agentTokenSaver, false),
      };
      const existing = findSession(session.id);
      set({
        sessions: existing
          ? get().sessions.map((item) => item.id === session.id ? session : item)
          : [...get().sessions, session],
      });
      const result = await spawnAgentShell(
        session.id,
        request.cliId,
        profile,
        worktreePath,
        launch,
        request.prompt ? [request.prompt] : [],
        request.waitForAttach === false
          ? undefined
          : async (sessionId) => {
              const attachReady = waitForTerminalAttach(sessionId);
              updateSession(session.id, { sessionId });
              await attachReady;
            },
        commandOverride,
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
        updateSession(session.id, {
          sessionId: result.sessionId,
          error: null,
          status: "running",
          savers: result.savers,
        });
        scheduleIdle(session.id);
      } else if (result.loginRequired) {
        set({ sessions: get().sessions.filter((item) => item.id !== session.id) });
        save();
        return null;
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
          icon: createElement(CliIcon, { id: def.id }),
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
        icon: createElement(CliIcon, { id: def.id }),
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
              let command: string;
              try {
                const resolved = resolveCli(def);
                command = resolved.resumeLine ?? resolved.resume.map(quoteArg).join(" ");
              } catch (error) {
                toast({ title: errorMessage(error), icon: "⚠" });
                return;
              }
              const ready = await prepareAgentShell(removed.id, removed.cliId, removed.profile);
              if (!("env" in ready)) {
                if (!ready.loginRequired) {
                  toast({
                    title: t("agents.spawnError", { name: def.name, message: ready.error }),
                    icon: "⚠",
                  });
                }
                return;
              }
              const result = await spawnPreparedShell(
                removed.worktreePath,
                ready.env,
                withSaverLine(removed.cliId, ready.savers, command),
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
                  {
                    ...removed,
                    id: nextSessionId(),
                    sessionId: result.sessionId,
                    error: null,
                    sharedWithDock: false,
                    savers: ready.savers,
                  },
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
          icon: createElement(CliIcon, { id: def.id }),
        });
        if (confirmed !== true) return null;
      }
      // Prepare everything first: a resume error or a not-logged-in target
      // must refuse the switch while the old session keeps running. The raw
      // resume line (with its fresh-launch fallback) is preferred so a
      // profile without history does not strand the pane at a shell.
      let command: string;
      try {
        const resolved = resolveCli(def);
        command = resolved.resumeLine ?? resolved.resume.map(quoteArg).join(" ");
      } catch (error) {
        toast({ title: errorMessage(error), icon: "⚠" });
        return null;
      }
      const ready = await prepareAgentShell(id, session.cliId, profile);
      if (!("env" in ready)) {
        // The login gate already toasted; anything else needs its own toast.
        if (!ready.loginRequired) {
          toast({ title: t("agents.spawnError", { name: def.name, message: ready.error }), icon: "⚠" });
        }
        return null;
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
      const result = await spawnPreparedShell(
        session.worktreePath,
        ready.env,
        withSaverLine(session.cliId, ready.savers, command),
        [],
        async (sessionId) => {
          // Switching replaces the mounted PTY just like an initial launch.
          // Publish its ID so CliPane can attach before the resume command is sent.
          const attachReady = waitForTerminalAttach(sessionId);
          updateSession(id, { sessionId });
          await attachReady;
        },
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
        savers: ready.savers,
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
      if (get().loaded || sessionsLoading) return;
      sessionsLoading = true;
      if (exitSubscription === null) {
        const subscribed = onTerminalExit((event) => {
          exitedSessions.add(event.sessionId);
          const session = get().sessions.find((item) => item.sessionId === event.sessionId);
          if (session) {
            const firstDone = session.status !== "done";
            clearSessionWatch(session.id);
            updateSession(session.id, { status: "done" });
            save();
            if (firstDone && (event.exitCode !== 0 || event.signal)) reportDone(session);
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
      // Launchpad and Inbox can request session loading as soon as they mount,
      // before App's staged startup has hydrated agent profiles. Restoring
      // against an empty profile list would leave saved sessions in an error
      // state and App's later load call would return because this store is now
      // marked loaded.
      try {
        if (!useProfiles.getState().loaded) await useProfiles.getState().load();
      } catch (error) {
        sessionsLoading = false;
        throw error;
      }
      let saved: PersistedAgentState | null;
      try {
        saved = await loadSetting<PersistedAgentState>("agentSessions");
      } catch (error) {
        sessionsLoading = false;
        throw error;
      }
      const entries = Array.isArray(saved?.sessions)
        ? saved.sessions.filter(isPersistedAgentSession)
        : [];
      const unique = [...new Map(entries.map((item) => [item.id, item])).values()];
      const restored: AgentSession[] = unique.map((item) => ({
        ...item,
        sessionId: null,
        error: null,
        sharedWithDock: false,
        status: "idle",
        limitHit: false,
        savers: sessionSavers(item.cliId, useSettings.getState().agentTokenSaver, false),
      }));
      set({
        sessions: restored,
        layoutMode: saved?.layoutMode === "full" ? "full" : "grid",
        loaded: true,
      });
      const waitForAttach = useStage.getState().panes.includes("agents");
      for (const session of restored) {
        const profileExists = useProfiles.getState().profiles.some(
          (profile) => profile.cliId === session.profile.cliId && profile.slug === session.profile.slug,
        );
        if (!profileExists) {
          updateSession(session.id, { error: t("agents.profileRequired", { name: CLI_REGISTRY[session.cliId].name }) });
          continue;
        }
        const id = await get().startSession({
          cliId: session.cliId,
          profile: session.profile,
          worktreePath: session.worktreePath,
          sessionRecordId: session.id,
          resume: true,
          slot: session.slot,
          waitForAttach,
        });
        if (!id && findSession(session.id)) {
          updateSession(session.id, { error: t("agents.restoreError", { name: CLI_REGISTRY[session.cliId].name }) });
        }
      }
      save();
      set({ loaded: true });
      sessionsLoading = false;
    },
  };
});
