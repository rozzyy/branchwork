// GitHub account index store (M4 Task 02): usernames only, never secrets.
// Tokens stay in the Keychain; this index only remembers which accounts
// exist and which is the default. Task 03 builds the Settings UI on top.
import { create } from "zustand";
import { loadSetting, saveSetting } from "../ipc/settings";
import { GITHUB_ACCOUNTS_KEY } from "./accounts";

interface PersistedGithubAccounts {
  accounts?: unknown;
  defaultAccount?: unknown;
  ownerAccounts?: unknown;
}

function isUsername(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function isOwnerMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon(snapshot: {
  accounts: string[];
  defaultAccount: string | null;
  ownerAccounts: Record<string, string>;
}): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSetting(GITHUB_ACCOUNTS_KEY, snapshot), 300);
}

interface GithubAccountsStore {
  accounts: string[];
  defaultAccount: string | null;
  /** Username chosen per repo owner (keys lowercased). Usernames only. */
  ownerAccounts: Record<string, string>;
  loaded: boolean;
  load(): Promise<void>;
  /** Record a verified username; first account becomes the default. */
  addAccount(username: string): void;
  /** Drop an account; default falls back to the first remaining one. */
  removeAccount(username: string): void;
  setDefault(account: string | null): void;
  /** Remember which account serves a repo owner; null clears the memory. */
  setAccountForOwner(owner: string, account: string | null): void;
}

export const useGithubAccounts = create<GithubAccountsStore>((set, get) => {
  const save = () =>
    persistSoon({
      accounts: get().accounts,
      defaultAccount: get().defaultAccount,
      ownerAccounts: get().ownerAccounts,
    });

  return {
    accounts: [],
    defaultAccount: null,
    ownerAccounts: {},
    loaded: false,

    async load() {
      try {
        const saved = await loadSetting<PersistedGithubAccounts>(GITHUB_ACCOUNTS_KEY);
        const accounts = Array.isArray(saved?.accounts) ? saved.accounts.filter(isUsername) : [];
        const savedDefault = isUsername(saved?.defaultAccount) ? saved.defaultAccount : null;
        const defaultAccount =
          savedDefault && accounts.includes(savedDefault) ? savedDefault : (accounts[0] ?? null);
        const ownerAccounts: Record<string, string> = {};
        if (isOwnerMap(saved?.ownerAccounts)) {
          for (const [owner, name] of Object.entries(saved.ownerAccounts)) {
            // Per-entry filtering: one corrupt entry must not wipe the rest.
            if (isUsername(name) && accounts.includes(name)) {
              ownerAccounts[owner.toLowerCase()] = name;
            }
          }
        }
        set({ accounts, defaultAccount, ownerAccounts, loaded: true });
      } catch {
        set({ loaded: true });
      }
    },

    addAccount(username) {
      if (!isUsername(username)) return;
      // GitHub usernames are case-insensitive: keep the first-seen spelling.
      const known = get().accounts.some(
        (name) => name.toLowerCase() === username.toLowerCase(),
      );
      const accounts = known ? get().accounts : [...get().accounts, username];
      set({ accounts, defaultAccount: get().defaultAccount ?? username });
      save();
    },

    removeAccount(username) {
      const accounts = get().accounts.filter((name) => name !== username);
      const defaultAccount =
        get().defaultAccount === username ? (accounts[0] ?? null) : get().defaultAccount;
      const ownerAccounts: Record<string, string> = {};
      for (const [owner, name] of Object.entries(get().ownerAccounts)) {
        if (name !== username) ownerAccounts[owner] = name;
      }
      set({ accounts, defaultAccount, ownerAccounts });
      save();
    },

    setDefault(account) {
      if (account !== null && !get().accounts.includes(account)) return;
      set({ defaultAccount: account });
      save();
    },

    setAccountForOwner(owner, account) {
      const key = owner.trim().toLowerCase();
      if (!key) return;
      if (account !== null && !get().accounts.includes(account)) return;
      const ownerAccounts = { ...get().ownerAccounts };
      if (account === null) delete ownerAccounts[key];
      else ownerAccounts[key] = account;
      set({ ownerAccounts });
      save();
    },
  };
});
