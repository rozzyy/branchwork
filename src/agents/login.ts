import { CLI_REGISTRY, type CliId } from "./registry";

export interface OpenCodeLoginOptions {
  providerId: string;
  methodId: string;
}

export interface LoginAdapter {
  binary: string;
  verifiedAgainst: string | null;
  credentialScope: "profile" | "device";
  browserHosts: readonly string[];
  buildArgs(options?: OpenCodeLoginOptions): string[];
  envFor(profileDir: string): Record<string, string>;
}

const OPENCODE_OAUTH_METHODS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["oauth"],
  openai: ["device"],
};

export const OPENCODE_LOGIN_CHOICES = [
  { value: "anthropic:oauth", labelKey: "settings.opencodeAnthropicLogin" },
  { value: "openai:device", labelKey: "settings.opencodeOpenAiLogin" },
] as const;

const ADAPTERS: Partial<Record<Exclude<CliId, "custom">, LoginAdapter>> = {
  claude: {
    binary: "claude",
    verifiedAgainst: CLI_REGISTRY.claude.verifiedAgainst,
    credentialScope: "profile",
    browserHosts: ["claude.ai", "console.anthropic.com", "platform.claude.com"],
    buildArgs: () => ["auth", "login"],
    envFor: CLI_REGISTRY.claude.profileEnv,
  },
  codex: {
    binary: "codex",
    verifiedAgainst: CLI_REGISTRY.codex.verifiedAgainst,
    credentialScope: "profile",
    browserHosts: ["auth.openai.com", "openai.com", "chatgpt.com"],
    buildArgs: () => ["login"],
    envFor: CLI_REGISTRY.codex.profileEnv,
  },
  opencode: {
    binary: "opencode",
    verifiedAgainst: CLI_REGISTRY.opencode.verifiedAgainst,
    credentialScope: "profile",
    browserHosts: ["opencode.ai", "auth.openai.com", "claude.ai", "console.anthropic.com"],
    buildArgs: (options) => {
      if (!options || !OPENCODE_OAUTH_METHODS[options.providerId]?.includes(options.methodId)) {
        throw new Error("Choose a supported OpenCode browser sign-in method");
      }
      return ["auth", "login", options.providerId, "--method", options.methodId];
    },
    envFor: CLI_REGISTRY.opencode.profileEnv,
  },
  gemini: {
    binary: "gemini",
    verifiedAgainst: CLI_REGISTRY.gemini.verifiedAgainst,
    credentialScope: "profile",
    browserHosts: ["accounts.google.com", "google.com"],
    buildArgs: () => [],
    envFor: (profileDir) => ({ ...CLI_REGISTRY.gemini.profileEnv(profileDir), GEMINI_DEFAULT_AUTH_TYPE: "oauth-personal" }),
  },
  copilot: {
    binary: "copilot",
    verifiedAgainst: CLI_REGISTRY.copilot.verifiedAgainst,
    credentialScope: "device",
    browserHosts: ["github.com", "githubusercontent.com"],
    buildArgs: () => ["login", "--web-flow"],
    envFor: CLI_REGISTRY.copilot.profileEnv,
  },
  muse: {
    binary: "muse",
    verifiedAgainst: CLI_REGISTRY.muse.verifiedAgainst,
    credentialScope: "device",
    browserHosts: ["meta.ai", "facebook.com"],
    buildArgs: () => ["login"],
    envFor: CLI_REGISTRY.muse.profileEnv,
  },
};

export function getLoginAdapter(cliId: CliId): LoginAdapter | null {
  return ADAPTERS[cliId as Exclude<CliId, "custom">] ?? null;
}

export function isAllowedLoginUrl(adapter: LoginAdapter, raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !adapter.browserHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}
