// Agent profile and account management (spec §6.6.4, Task 07).
// Profiles hold only non-secret metadata. Branchwork never reads, stores,
// or logs credentials: the user types them into the vendor CLI itself (added
// via the Add flow below), which owns the system Keychain. Logout deletes the
// registry's declared credential files and nothing else.
import { create } from "zustand";
import { CLI_REGISTRY, resolveCli, slugify, type CliId } from "./registry";
import { ensureProfileDir, logoutProfile } from "../ipc/cli";
import { writeTerminal } from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { errorMessage } from "../ipc/errors";
import { t } from "../i18n/t";
import { toast } from "../ui/toast";
import { ask } from "../ui/dialog";
import { useTerminalScreen } from "../terminal/screen";
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

interface ProfilesStore {
  profiles: AgentProfile[];
  globalDefault: ProfileRef | null;
  cliDefaults: Partial<Record<CliId, ProfileRef>>;
  loaded: boolean;
  /** Create a profile record + dir without opening anything. Null when invalid. */
  createProfile(cliId: CliId, name: string): Promise<AgentProfile | null>;
  /** Create a profile, then open its login terminal. Null when cancelled/invalid. */
  addProfile(cliId: CliId, name?: string): Promise<AgentProfile | null>;
  /** Confirmed logout: delete the profile's credentials, keep the profile. */
  logoutProfile(ref: ProfileRef): Promise<string[] | null>;
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
          icon: def.icon,
        }));
      if (typeof label !== "string") return null;
      const profile = await get().createProfile(cliId, label);
      if (!profile) return null;
      let profileDir: string;
      try {
        profileDir = await ensureProfileDir(cliId, profile.slug);
      } catch (error) {
        toast({ title: t("agents.dirError", { message: errorMessage(error) }), icon: "⚠" });
        return null;
      }
      // The login PTY starts isolated in the profile env; the user completes
      // the vendor login inside it. Branchwork never sees the secret.
      const env = resolveCli(def).envFor(profileDir);
      const target = useWorktrees.getState().activePath;
      const screen = useTerminalScreen.getState();
      const tabId = await screen.newTab(target ?? undefined, env);
      if (def.loginCmd && tabId) {
        // Re-read the store: newTab settled new state after `screen` was taken.
        const tab = useTerminalScreen.getState().tabs.find((item) => item.id === tabId);
        const paneId = tab?.focusedPaneId;
        const sessionId = paneId ? tab?.panes[paneId]?.sessionId : null;
        if (sessionId) {
          try {
            await writeTerminal(sessionId, new TextEncoder().encode(`${def.loginCmd}\n`));
          } catch (error) {
            toast({ title: errorMessage(error), icon: "⚠" });
          }
        }
      } else {
        toast({ title: t("agents.loginReady", { name: def.name }), icon: def.icon });
      }
      return profile;
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
        icon: def.icon,
      });
      if (confirmed !== true) return null;
      try {
        const removed = await logoutProfile(ref.cliId, ref.slug, def.credentialPaths);
        toast({
          title:
            removed.length > 0
              ? t("agents.loggedOut", { name: def.name, profile: profile.name })
              : t("agents.noCredentials", { name: def.name, profile: profile.name }),
          icon: def.icon,
        });
        return removed;
      } catch (error) {
        toast({ title: errorMessage(error), icon: "⚠" });
        return null;
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
      });
    },
  };
});
