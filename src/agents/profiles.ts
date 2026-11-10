// Agent profile and account management (spec §6.6.4, Task 07).
// Profiles hold only non-secret metadata. Branchwork never reads, stores,
// or logs credentials: the user types them into the vendor CLI itself. Per-
// profile logout removes declared credential files; account removal clears
// the isolated profile directory and any provider-owned shared credential.
import { createElement } from "react";
import { create } from "zustand";
import { CLI_REGISTRY, resolveCli, slugify, type CliDef, type CliId } from "./registry";
import { CliIcon } from "./cliIcons";
import {
  ensureProfileDir,
  logoutProfile,
  probeCli,
  profileHasCredentials,
  removeProfileData,
  seedClaudeOnboarding,
} from "../ipc/cli";
import { parseClaudeAuth, parseMuseUsage } from "./probe";
import { writeTerminal } from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { errorMessage } from "../ipc/errors";
import { t } from "../i18n/t";
import { toast } from "../ui/toast";
import { ask } from "../ui/dialog";
import { useTerminalScreen } from "../terminal/screen";
import { useStage } from "../state/stage";
import { useWorktrees } from "../state/worktrees";

export interface AgentProfile {
  cliId: CliId;
  slug: string;
  name: string;
  createdAt: number;
}

export interface ProfileRef {
  cliId: CliId;
  slug: string;
}

interface PersistedProfiles {
  profiles?: unknown;
  globalDefault?: unknown;
  cliDefaults?: unknown;
}

function isAgentProfile(value: unknown): value is AgentProfile {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.cliId === "string" &&
    entry.cliId in CLI_REGISTRY &&
    typeof entry.slug === "string" &&
    typeof entry.name === "string" &&
    typeof entry.createdAt === "number"
  );
}

function isProfileRef(value: unknown): value is ProfileRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.cliId === "string" &&
    ref.cliId in CLI_REGISTRY &&
    typeof ref.slug === "string"
  );
}

const PROFILES_KEY = "agentProfiles";

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon(snapshot: PersistedProfiles): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSetting(PROFILES_KEY, snapshot), 300);
}

export interface ProfileUsage {
  /** Human window label from the vendor CLI, e.g. "5h". */
  window: string;
  /** 0–100. Shown only when a CLI hook reports it; never fabricated. */
  percent: number;
}

export const usageKey = (ref: ProfileRef): string => `${ref.cliId}:${ref.slug}`;

/** Vendor auth/usage probe state keyed by CLI. */
export interface CliProbeState {
  linked: boolean;
  /** Account label from the vendor (e.g. login email), never fabricated. */
  identity: string | null;
}

/**
 * Open the isolated login PTY for a profile dir and land it in the
 * vendor's real login command (Orca's method: the user completes the vendor
 * login inside it; Branchwork never sees the secret). True when the login
 * step started.
 */
async function openLoginTab(def: CliDef, profileDir: string): Promise<boolean> {
  let env: Record<string, string>;
  try {
    env = resolveCli(def).envFor(profileDir);
  } catch (error) {
    // Custom CLI with no launch override yet: explain instead of
    // rejecting unhandled (callers fire-and-forget these flows).
    toast({ title: errorMessage(error), icon: "⚠" });
    return false;
  }
  const target = useWorktrees.getState().activePath;
  const screen = useTerminalScreen.getState();
  let tabId: string | null;
  try {
    await screen.load();
    tabId = await screen.newTab(target ?? undefined, env);
  } catch (error) {
    toast({ title: errorMessage(error), icon: "⚠" });
    return false;
  }
  if (!tabId) return false; // newTab already explained why (no worktree).
  useStage.getState().go("terminal");
  // Land the pane inside the vendor CLI when it exposes no dedicated
  // shell login command (gemini: auth completes inside its TUI).
  const startCmd = def.loginCmd ?? def.launch[0] ?? null;
  if (!startCmd) {
    toast({ title: t("agents.loginReady", { name: def.name }), icon: createElement(CliIcon, { id: def.id }) });
    return true;
  }
  // Re-read the store: newTab settled new state after `screen` was taken.
  const tab = useTerminalScreen.getState().tabs.find((item) => item.id === tabId);
  const paneId = tab?.focusedPaneId;
  const sessionId = paneId ? tab?.panes[paneId]?.sessionId : null;
  if (!sessionId) return false;
  try {
    await writeTerminal(sessionId, new TextEncoder().encode(`${startCmd}\n`));
  } catch (error) {
    toast({ title: errorMessage(error), icon: "⚠" });
    return false;
  }
  return true;
}

const activeLoginMonitors = new Set<string>();
const LOGIN_MONITOR_TIMEOUT_MS = 10 * 60_000;
const LOGIN_MONITOR_INTERVAL_MS = 1_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the vendor login is verifiably complete (or unverifiable /
 * timed out). Drives the Settings "Waiting for login…" loader: pending is
 * set synchronously and cleared only on a real positive check.
 */
function monitorLogin(ref: ProfileRef): void {
  const key = usageKey(ref);
  if (activeLoginMonitors.has(key)) return;
  activeLoginMonitors.add(key);
  const store = useProfiles.getState();
  store.setLoginPending(ref, Date.now());
  void (async () => {
    const started = Date.now();
    try {
      for (;;) {
        const linked = await useProfiles.getState().checkProfileLogin(ref);
        if (linked === true) {
          const def = CLI_REGISTRY[ref.cliId];
          const profile = useProfiles
            .getState()
            .profiles.find((item) => item.cliId === ref.cliId && item.slug === ref.slug);
          toast({
            title: t("agents.loginDetected", { name: def.name, profile: profile?.name ?? ref.slug }),
            // The probe turns true the moment the browser step completes,
            // while the login terminal may still sit on the vendor's
            // one-time setup wizard — say so, or it reads as another login.
            detail: ref.cliId === "claude" ? t("agents.loginFinishSetup") : undefined,
            icon: createElement(CliIcon, { id: def.id }),
          });
          return;
        }
        if (linked === null) return; // unverifiable: stop, never fabricate
        if (Date.now() - started > LOGIN_MONITOR_TIMEOUT_MS) {
          toast({ title: t("agents.loginNotDetected"), icon: "⚠" });
          return;
        }
        await delay(LOGIN_MONITOR_INTERVAL_MS);
      }
    } finally {
      activeLoginMonitors.delete(key);
      useProfiles.getState().setLoginPending(ref, null);
    }
  })();
}

interface ProfilesStore {
  profiles: AgentProfile[];
  globalDefault: ProfileRef | null;
  cliDefaults: Partial<Record<CliId, ProfileRef>>;
  loaded: boolean;
  loadError: string | null;
  /**
   * Live usage reported by a vendor-CLI hook (spec §6.6.4). Ephemeral and
   * never persisted: a stale window presented as current would mislead.
   * Null/absent means the CLI exposes nothing → the bar stays hidden.
   */
  usage: Record<string, ProfileUsage>;
  /** Record (or clear with null) live usage for one profile. Percent is clamped. */
  setProfileUsage(ref: ProfileRef, value: ProfileUsage | null): void;
  /** CLI-global probe state (currently Muse). */
  cliProbes: Record<string, CliProbeState>;
  setCliProbe(cliId: CliId, value: CliProbeState | null): void;
  /** Profile-scoped probe state, keyed by usageKey (currently Claude). */
  profileProbes: Record<string, CliProbeState>;
  setProfileProbe(ref: ProfileRef, value: CliProbeState | null): void;
  /** Profiles with a login in flight (keyed by usageKey, value = start ms). */
  loginPending: Record<string, number>;
  setLoginPending(ref: ProfileRef, startedAt: number | null): void;
  /**
   * Verify whether the vendor login actually completed for a profile:
   * true/false when verifiable, null when this CLI exposes no check.
   * Updates probe/usage state as a side effect.
   */
  checkProfileLogin(ref: ProfileRef): Promise<boolean | null>;
  /** Create a profile record + dir without opening anything. Null when invalid. */
  createProfile(cliId: CliId, name: string): Promise<AgentProfile | null>;
  /** Create a profile, then open its login terminal. Null when cancelled/invalid. */
  addProfile(cliId: CliId, name?: string): Promise<AgentProfile | null>;
  /**
   * Re-open the login terminal for an existing profile (e.g. a row whose
   * credentials were never completed). False when the login step failed
   * to start; the profile record is kept in both cases.
   */
  loginProfile(ref: ProfileRef): Promise<boolean>;
  /** Confirmed logout: delete the profile's credentials, keep the profile. */
  logoutProfile(ref: ProfileRef): Promise<string[] | null>;
  /** Confirmed account removal: delete profile data before dropping its record. */
  removeAccount(ref: ProfileRef): Promise<boolean>;
  /** Drop a profile record (rollback for failed logins); clears its defaults. */
  removeProfile(ref: ProfileRef): void;
  /** Rename a profile's display label without changing its storage slug. */
  renameProfile(ref: ProfileRef, name: string): boolean;
  setGlobalDefault(ref: ProfileRef | null): void;
  setCliDefault(cliId: CliId, ref: ProfileRef | null): void;
  /** Explicit → group default → global default → first profile of the CLI. */
  resolveProfile(
    cliId: CliId,
    opts?: { explicit?: ProfileRef | null; groupDefault?: ProfileRef | null },
  ): ProfileRef | null;
  load(): Promise<void>;
}

function snapshot(get: () => ProfilesStore): PersistedProfiles {
  return {
    profiles: get().profiles,
    globalDefault: get().globalDefault,
    cliDefaults: get().cliDefaults,
  };
}

export const useProfiles = create<ProfilesStore>((set, get) => {
  const save = () => persistSoon(snapshot(get));

  const findProfile = (ref: ProfileRef): AgentProfile | undefined =>
    get().profiles.find((profile) => profile.cliId === ref.cliId && profile.slug === ref.slug);

  return {
    profiles: [],
    globalDefault: null,
    cliDefaults: {},
    loaded: false,
    loadError: null,
    usage: {},
    cliProbes: {},
    profileProbes: {},
    loginPending: {},

    setProfileUsage(ref, value) {
      const key = usageKey(ref);
      const usage = { ...get().usage };
      if (value === null) delete usage[key];
      else usage[key] = { window: value.window, percent: Math.min(100, Math.max(0, Math.round(value.percent))) };
      set({ usage });
    },

    setCliProbe(cliId, value) {
      const cliProbes = { ...get().cliProbes };
      if (value === null) delete cliProbes[cliId];
      else cliProbes[cliId] = value;
      set({ cliProbes });
    },

    setProfileProbe(ref, value) {
      const profileProbes = { ...get().profileProbes };
      const key = usageKey(ref);
      if (value === null) delete profileProbes[key];
      else profileProbes[key] = value;
      set({ profileProbes });
    },

    setLoginPending(ref, startedAt) {
      const loginPending = { ...get().loginPending };
      if (startedAt === null) delete loginPending[usageKey(ref)];
      else loginPending[usageKey(ref)] = startedAt;
      set({ loginPending });
    },

    async checkProfileLogin(ref) {
      const def = CLI_REGISTRY[ref.cliId];
      if (def.credentialPaths.length > 0) {
        try {
          return await profileHasCredentials(ref.cliId, ref.slug, def.credentialPaths);
        } catch {
          return false;
        }
      }
      if (ref.cliId === "claude") {
        try {
          const dir = await ensureProfileDir(ref.cliId, ref.slug);
          const raw = await probeCli("claude", resolveCli(def).envFor(dir));
          const auth = parseClaudeAuth(raw);
          if (!auth) return null;
          get().setProfileProbe(ref, { linked: auth.loggedIn, identity: auth.email });
          return auth.loggedIn;
        } catch {
          return null;
        }
      }
      if (ref.cliId === "muse") {
        try {
          const usage = parseMuseUsage(await probeCli("muse"));
          if (!usage) {
            get().setCliProbe("muse", { linked: false, identity: null });
            return false;
          }
          get().setCliProbe("muse", { linked: true, identity: null });
          get().setProfileUsage(ref, usage);
          return true;
        } catch {
          return null;
        }
      }
      return null;
    },

    async createProfile(cliId, name) {
      const def = CLI_REGISTRY[cliId];
      const trimmed = name.trim();
      if (!trimmed) {
        toast({ title: t("agents.needsName"), icon: "⚠" });
        return null;
      }
      const slug = slugify(trimmed);
      if (findProfile({ cliId, slug })) {
        toast({ title: t("agents.slugTaken", { name: def.name, slug }), icon: "⚠" });
        return null;
      }
      try {
        await ensureProfileDir(cliId, slug);
      } catch (error) {
        toast({ title: t("agents.dirError", { message: errorMessage(error) }), icon: "⚠" });
        return null;
      }
      if (cliId === "claude") {
        // Skip the vendor's first-run wizard for profiles created here: the
        // seed only exclusive-creates the flag file and never touches
        // credentials, so a verified login goes straight to the prompt.
        // Best-effort — a failure just means the wizard runs once.
        await seedClaudeOnboarding(cliId, slug).catch(() => false);
      }
      const profile: AgentProfile = { cliId, slug, name: trimmed, createdAt: Date.now() };
      set({ profiles: [...get().profiles, profile] });
      save();
      return profile;
    },

    async addProfile(cliId, name) {
      const def = CLI_REGISTRY[cliId];
      const label =
        name ??
        (await ask({
          title: t("agents.addTitle", { name: def.name }),
          body: t("agents.addBody", { name: def.name }),
          input: "",
          ok: t("agents.addOk"),
          icon: createElement(CliIcon, { id: def.id }),
        }));
      if (typeof label !== "string") return null;
      const profile = await get().createProfile(cliId, label);
      if (!profile) return null;
      const ref = { cliId, slug: profile.slug };
      const rollback = () => get().removeProfile(ref);
      let profileDir: string;
      try {
        profileDir = await ensureProfileDir(cliId, profile.slug);
      } catch (error) {
        rollback();
        toast({ title: t("agents.dirError", { message: errorMessage(error) }), icon: "⚠" });
        return null;
      }
      // A login that never starts must not leave a dead account behind.
      const started = await openLoginTab(def, profileDir);
      if (!started) {
        rollback();
        return null;
      }
      monitorLogin(ref);
      return profile;
    },

    async loginProfile(ref) {
      const profile = findProfile(ref);
      if (!profile) {
        toast({ title: t("agents.profileRequired", { name: ref.cliId }), icon: "⚠" });
        return false;
      }
      const def = CLI_REGISTRY[ref.cliId];
      let profileDir: string;
      try {
        profileDir = await ensureProfileDir(ref.cliId, profile.slug);
      } catch (error) {
        toast({ title: t("agents.dirError", { message: errorMessage(error) }), icon: "⚠" });
        return false;
      }
      if (ref.cliId === "claude") {
        // Same best-effort seed as creation: a no-op when the flag file
        // already exists, so existing credentials are never touched.
        await seedClaudeOnboarding(ref.cliId, profile.slug).catch(() => false);
      }
      const started = await openLoginTab(def, profileDir);
      if (started) monitorLogin(ref);
      return started;
    },

    removeProfile(ref) {
      const profiles = get().profiles.filter(
        (profile) => !(profile.cliId === ref.cliId && profile.slug === ref.slug),
      );
      if (profiles.length === get().profiles.length) return;
      const clearDefault = (current: ProfileRef | null) =>
        current && current.cliId === ref.cliId && current.slug === ref.slug ? null : current;
      const cliDefaults = { ...get().cliDefaults };
      if (cliDefaults[ref.cliId]?.slug === ref.slug) delete cliDefaults[ref.cliId];
      const usage = { ...get().usage };
      delete usage[usageKey(ref)];
      const loginPending = { ...get().loginPending };
      delete loginPending[usageKey(ref)];
      const profileProbes = { ...get().profileProbes };
      delete profileProbes[usageKey(ref)];
      set({
        profiles,
        globalDefault: clearDefault(get().globalDefault),
        cliDefaults,
        usage,
        profileProbes,
        loginPending,
      });
      save();
    },

    renameProfile(ref, name) {
      const profile = findProfile(ref);
      if (!profile) {
        toast({ title: t("agents.profileRequired", { name: CLI_REGISTRY[ref.cliId].name }), icon: "⚠" });
        return false;
      }
      const trimmed = name.trim();
      const slug = slugify(trimmed);
      if (!trimmed || !slug) {
        toast({ title: t("agents.needsName"), icon: "⚠" });
        return false;
      }
      if (slug !== ref.slug && findProfile({ cliId: ref.cliId, slug })) {
        toast({ title: t("agents.slugTaken", { name: CLI_REGISTRY[ref.cliId].name, slug }), icon: "⚠" });
        return false;
      }
      set({
        profiles: get().profiles.map((item) =>
          item.cliId === ref.cliId && item.slug === ref.slug ? { ...item, name: trimmed } : item,
        ),
      });
      save();
      return true;
    },

    async logoutProfile(ref) {
      const profile = findProfile(ref);
      if (!profile) {
        toast({ title: t("agents.profileRequired", { name: ref.cliId }), icon: "⚠" });
        return null;
      }
      const def = CLI_REGISTRY[ref.cliId];
      const confirmed = await ask({
        title: t("agents.logoutTitle", { name: def.name, profile: profile.name }),
        body: t("agents.logoutBody"),
        ok: t("agents.logoutOk"),
        danger: true,
        icon: createElement(CliIcon, { id: def.id }),
      });
      if (confirmed !== true) return null;
      try {
        const removed = await logoutProfile(ref.cliId, ref.slug, def.credentialPaths);
        toast({
          title:
            removed.length > 0
              ? t("agents.loggedOut", { name: def.name, profile: profile.name })
              : t("agents.noCredentials", { name: def.name, profile: profile.name }),
          icon: createElement(CliIcon, { id: def.id }),
        });
        return removed;
      } catch (error) {
        toast({ title: errorMessage(error), icon: "⚠" });
        return null;
      }
    },

    async removeAccount(ref) {
      const profile = findProfile(ref);
      if (!profile) {
        toast({ title: t("agents.profileRequired", { name: ref.cliId }), icon: "⚠" });
        return false;
      }
      try {
        const removed = await removeProfileData(ref.cliId, ref.slug);
        if (!removed) return false;
        get().removeProfile(ref);
        if (ref.cliId === "muse") {
          get().setCliProbe("muse", { linked: false, identity: null });
          const usage = { ...get().usage };
          for (const item of get().profiles.filter((profile) => profile.cliId === "muse")) {
            delete usage[usageKey({ cliId: "muse", slug: item.slug })];
          }
          set({ usage });
        }
        return true;
      } catch (error) {
        toast({ title: errorMessage(error), icon: "⚠" });
        return false;
      }
    },

    setGlobalDefault(ref) {
      if (ref && !findProfile(ref)) return;
      set({ globalDefault: ref });
      save();
    },

    setCliDefault(cliId, ref) {
      if (ref && (ref.cliId !== cliId || !findProfile(ref))) return;
      const cliDefaults = { ...get().cliDefaults };
      if (ref) cliDefaults[cliId] = ref;
      else delete cliDefaults[cliId];
      set({ cliDefaults });
      save();
    },

    resolveProfile(cliId, opts) {
      const candidates = [
        opts?.explicit ?? null,
        opts?.groupDefault ?? null,
        get().globalDefault,
        get().cliDefaults[cliId] ?? null,
        // First profile of the CLI, in creation order.
        ...get()
          .profiles.filter((profile) => profile.cliId === cliId)
          .map((profile): ProfileRef => ({ cliId: profile.cliId, slug: profile.slug })),
      ];
      for (const candidate of candidates) {
        if (candidate && candidate.cliId === cliId && findProfile(candidate)) return candidate;
      }
      return null;
    },

    async load() {
      set({ loadError: null });
      try {
        const saved = await loadSetting<PersistedProfiles>(PROFILES_KEY);
        const profiles: AgentProfile[] = [];
        if (Array.isArray(saved?.profiles)) {
          for (const entry of saved.profiles) {
            if (!isAgentProfile(entry)) continue;
            profiles.push(entry);
          }
        }
        const cliDefaults: Partial<Record<CliId, ProfileRef>> = {};
        if (typeof saved?.cliDefaults === "object" && saved.cliDefaults !== null) {
          for (const [cliId, ref] of Object.entries(saved.cliDefaults)) {
            if (cliId in CLI_REGISTRY && isProfileRef(ref)) {
              cliDefaults[cliId as CliId] = ref;
            }
          }
        }
        set({
          profiles,
          globalDefault: isProfileRef(saved?.globalDefault) ? saved.globalDefault : null,
          cliDefaults,
          loaded: true,
          loadError: null,
        });
      } catch (error) {
        set({ loadError: errorMessage(error) });
        throw error;
      }
    },
  };
});
