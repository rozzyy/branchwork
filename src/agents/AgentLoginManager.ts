import type { PtyErrorEvent, PtyExit, PtyOutput } from "../ipc/pty";
import type { ProfileRef } from "./profiles";
import { getLoginAdapter, isAllowedLoginUrl, type OpenCodeLoginOptions } from "./login";
import { openUrl } from "@tauri-apps/plugin-opener";
import { attachTerminal, closeTerminal, onTerminalError, onTerminalExit, onTerminalOutput, spawnAgentLogin } from "../ipc/pty";

const MAX_ACTIVE_LOGINS = 2;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_LOGIN_OUTPUT_CHARS = 8 * 1024;
const URL_PATTERN = /https:\/\/[^\s\u001b"'<>]+/g;

export interface LoginManagerDeps {
  spawn(ref: ProfileRef, options?: OpenCodeLoginOptions): Promise<{ sessionId: string }>;
  attach(sessionId: string, attachmentId: number): Promise<void>;
  onOutput(callback: (event: PtyOutput) => void): Promise<() => void>;
  onExit(callback: (event: PtyExit) => void): Promise<() => void>;
  onError(callback: (event: PtyErrorEvent) => void): Promise<() => void>;
  close(sessionId: string): Promise<void>;
  openUrl(url: string): Promise<void>;
}

interface ActiveLogin {
  sessionId: string | null;
  stopped: boolean;
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  unlisten: Array<() => void>;
  stop(close: boolean): Promise<void>;
}

const loginKey = (ref: ProfileRef) => `${ref.cliId}:${ref.slug}`;
let nextAttachmentId = 1;

export function createAgentLoginManager(deps: LoginManagerDeps) {
  const active = new Map<string, ActiveLogin>();

  async function stop(key: string, entry: ActiveLogin, close: boolean): Promise<void> {
    if (entry.stopped) return;
    entry.stopped = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    active.delete(key);
    entry.buffer = "";
    for (const unlisten of entry.unlisten) unlisten();
    entry.unlisten = [];
    const sessionId = entry.sessionId;
    entry.sessionId = null;
    if (close && sessionId) await deps.close(sessionId).catch(() => undefined);
  }

  return {
    async start(ref: ProfileRef, options?: OpenCodeLoginOptions): Promise<void> {
      const key = loginKey(ref);
      if (active.has(key)) throw new Error("A sign-in is already running for this profile");
      if (active.size >= MAX_ACTIVE_LOGINS) throw new Error("Too many sign-ins are running");
      const adapter = getLoginAdapter(ref.cliId);
      if (!adapter) throw new Error("Sign-in is unavailable for this provider");
      adapter.buildArgs(options); // Validate UI choices; Rust independently builds fixed argv.

      const entry: ActiveLogin = {
        sessionId: null,
        stopped: false,
        buffer: "",
        timer: null,
        unlisten: [],
        stop: async () => undefined,
      };
      entry.stop = (close) => stop(key, entry, close);
      active.set(key, entry); // Reserve synchronously to prevent concurrent duplicate starts.
      try {
        entry.unlisten.push(await deps.onOutput((event) => {
          if (entry.stopped || event.sessionId !== entry.sessionId) return;
          entry.buffer = (entry.buffer + new TextDecoder().decode(new Uint8Array(event.data), { stream: true }))
            .slice(-MAX_LOGIN_OUTPUT_CHARS);
          const printable = entry.buffer.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
          for (const match of printable.matchAll(URL_PATTERN)) {
            const safeUrl = isAllowedLoginUrl(adapter, match[0].replace(/[),.;]+$/, ""));
            if (safeUrl) {
              entry.buffer = "";
              void deps.openUrl(safeUrl).catch(() => undefined);
              break;
            }
          }
        }));
        entry.unlisten.push(await deps.onExit((event) => {
          if (!entry.stopped && event.sessionId === entry.sessionId) void entry.stop(false);
        }));
        entry.unlisten.push(await deps.onError((event) => {
          if (!entry.stopped && event.sessionId === entry.sessionId) void entry.stop(false);
        }));
        const session = await deps.spawn(ref, options);
        if (entry.stopped) {
          await deps.close(session.sessionId).catch(() => undefined);
          return;
        }
        entry.sessionId = session.sessionId;
        // Replaying the bounded detached buffer closes the spawn/listener race
        // for CLIs that print a browser URL immediately at startup.
        await deps.attach(session.sessionId, nextAttachmentId++);
        entry.timer = setTimeout(() => void entry.stop(true), LOGIN_TIMEOUT_MS);
      } catch (error) {
        await entry.stop(true);
        throw error;
      }
    },

    cancel(ref: ProfileRef): Promise<void> {
      return active.get(loginKey(ref))?.stop(true) ?? Promise.resolve();
    },

    async cancelAll(): Promise<void> {
      await Promise.all([...active.values()].map((entry) => entry.stop(true)));
    },

    get activeCount(): number {
      return active.size;
    },

    isActive(ref: ProfileRef): boolean {
      return active.has(loginKey(ref));
    },
  };
}

export const agentLoginManager = createAgentLoginManager({
  spawn: (ref, options) => spawnAgentLogin(
    ref.cliId,
    ref.slug,
    100,
    30,
    options?.providerId,
    options?.methodId,
  ),
  // Defer reading the IPC export until a login actually starts. Many stores
  // import profiles in tests that intentionally mock only their own PTY API.
  attach: (sessionId, attachmentId) => attachTerminal(sessionId, attachmentId),
  onOutput: (callback) => onTerminalOutput(callback),
  onExit: (callback) => onTerminalExit(callback),
  onError: (callback) => onTerminalError(callback),
  close: (sessionId) => closeTerminal(sessionId),
  openUrl: (url) => openUrl(url).then(() => undefined),
});

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => void agentLoginManager.cancelAll(), { once: true });
}
