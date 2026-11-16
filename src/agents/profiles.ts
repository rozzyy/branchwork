// Agent profile and account management (spec §6.6.4, Task 07).
// Profiles hold only non-secret metadata. Branchwork never reads, stores,
// or logs credentials: the user types them into the vendor CLI itself. Per-
// profile logout removes declared credential files; account removal clears
// the isolated profile directory and any provider-owned shared credential.
import { createElement } from "react";
import { create } from "zustand";
import { CLI_REGISTRY, resolveCli, slugify, type CliId } from "./registry";
import { CliIcon } from "./cliIcons";
import {
  ensureProfileDir,
  logoutProfile,
  probeCli,
  profileHasCredentials,
  removeProfileData,
  seedClaudeOnboarding,
} from "../ipc/cli";
import { parseClaudeAuth, parseMuseLoginStatus, parseMuseUsage } from "./probe";
import { loadSetting, saveSetting } from "../ipc/settings";
import { errorMessage } from "../ipc/errors";
import { t } from "../i18n/t";
import { toast } from "../ui/toast";
import { ask } from "../ui/dialog";
import { agentLoginManager } from "./AgentLoginManager";
import { OPENCODE_LOGIN_CHOICES, type OpenCodeLoginOptions } from "./login";

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

function isCliId(value: unknown): value is CliId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CLI_REGISTRY, value);
}

function isProfileSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function parseAgentProfile(value: unknown): AgentProfile | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (
    isCliId(entry.cliId) &&
    isProfileSlug(entry.slug) &&
    typeof entry.name === "string" &&
    entry.name.trim().length > 0 &&
    typeof entry.createdAt === "number" &&
    Number.isFinite(entry.createdAt)
  ) {
    return {
      cliId: entry.cliId,
      slug: entry.slug,
      name: entry.name,
      createdAt: entry.createdAt,
    };
  }
  return null;
}

function parseProfileRef(value: unknown): ProfileRef | null {
  if (typeof value !== "object" || value === null) return null;
  const ref = value as Record<string, unknown>;
  if (!isCliId(ref.cliId) || !isProfileSlug(ref.slug)) return null;
  return { cliId: ref.cliId, slug: ref.slug };
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
            icon: createElement(CliIcon, { id: def.id }),
          });
          await agentLoginManager.cancel(ref);
          return;
        }
        if (!agentLoginManager.isActive(ref)) {
          if (linked !== null) toast({ title: t("agents.loginNotDetected"), icon: "⚠" });
          return;
        }
        if (Date.now() - started > LOGIN_MONITOR_TIMEOUT_MS) {
          toast({ title: t("agents.loginNotDetected"), icon: "⚠" });
          await agentLoginManager.cancel(ref);
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
  /** Create a profile and start background browser login. Null when canceled/invalid. */
  addProfile(cliId: CliId, name?: string): Promise<AgentProfile | null>;
  /**
   * Start background browser login for an existing profile. False when the
   * login could not start or the OpenCode choice was canceled.
   */
  loginProfile(ref: ProfileRef, options?: OpenCodeLoginOptions): Promise<boolean>;
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
          const raw = await probeCli("muse");
          const usage = parseMuseUsage(raw);
          const linked = parseMuseLoginStatus(raw);
          if (linked === null) return null;
          get().setCliProbe("muse", { linked, identity: null });
          if (usage) get().setProfileUsage(ref, usage);
          return linked;
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
      if (cliId === "custom") {
        toast({ title: t("agents.loginUnsupported"), icon: "⚠" });
        return null;
      }
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
      await get().loginProfile(ref);
      return profile;
    },

    async loginProfile(ref, suppliedOptions) {
      const profile = findProfile(ref);
      if (!profile) {
        toast({ title: t("agents.profileRequired", { name: ref.cliId }), icon: "⚠" });
        return false;
      }
      if (agentLoginManager.isActive(ref)) return false;
      let options = suppliedOptions;
      if (ref.cliId === "opencode" && !options) {
        const choice = await ask({
          title: t("settings.opencodeLoginTitle"),
          body: t("settings.opencodeLoginBody"),
          choices: OPENCODE_LOGIN_CHOICES.map((entry) => ({ value: entry.value, label: t(entry.labelKey) })),
          ok: t("agents.loginNow"),
          icon: createElement(CliIcon, { id: "opencode" }),
        });
        if (typeof choice !== "string") return false;
        const [providerId, methodId] = choice.split(":");
        options = { providerId, methodId };
      }
      try {
        await ensureProfileDir(ref.cliId, profile.slug);
      } catch (error) {
        toast({ title: t("agents.dirError", { message: errorMessage(error) }), icon: "⚠" });
        return false;
      }
      if (ref.cliId === "claude") {
        // Same best-effort seed as creation: a no-op when the flag file
        // already exists, so existing credentials are never touched.
        await seedClaudeOnboarding(ref.cliId, profile.slug).catch(() => false);
      }
      get().setLoginPending(ref, Date.now());
      try {
        await agentLoginManager.start(ref, options);
        monitorLogin(ref);
        return true;
      } catch {
        get().setLoginPending(ref, null);
        toast({ title: t("agents.loginStartFailed"), icon: "⚠" });
        return false;
      }
    },

    removeProfile(ref) {
      void agentLoginManager.cancel(ref);
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
            const profile = parseAgentProfile(entry);
            if (profile) profiles.push(profile);
          }
        }
        const hasProfile = (ref: ProfileRef | null): ref is ProfileRef =>
          !!ref && profiles.some((profile) => profile.cliId === ref.cliId && profile.slug === ref.slug);
        const cliDefaults: Partial<Record<CliId, ProfileRef>> = {};
        if (typeof saved?.cliDefaults === "object" && saved.cliDefaults !== null) {
          for (const [rawCliId, value] of Object.entries(saved.cliDefaults)) {
            const ref = parseProfileRef(value);
            if (isCliId(rawCliId) && ref?.cliId === rawCliId && hasProfile(ref)) {
              cliDefaults[rawCliId] = ref;
            }
          }
        }
        const parsedGlobalDefault = parseProfileRef(saved?.globalDefault);
        const globalDefault = hasProfile(parsedGlobalDefault) ? parsedGlobalDefault : null;
        const normalized: PersistedProfiles = { profiles, globalDefault, cliDefaults };
        set({
          profiles,
          globalDefault,
          cliDefaults,
          loaded: true,
          loadError: null,
        });
        if (saved && JSON.stringify(saved) !== JSON.stringify(normalized)) persistSoon(normalized);
      } catch (error) {
        set({ loadError: errorMessage(error) });
        throw error;
      }
    },
  };
});
