// CLI registry for agent sessions (spec §6.6.1). Branchwork launches the
// vendor's CLI in a PTY; there is no custom chat UI. This module holds the
// metadata table plus launch/resume/profile-env construction. Actually
// spawning a CLI with its environment is a later Stage 3 task.
import { t } from "../i18n/t";
import type { MsgKey } from "../i18n/en";

export type CliId = "claude" | "codex" | "opencode" | "gemini" | "copilot" | "muse" | "custom";

export interface CliDef {
  id: CliId;
  name: string;
  /** Binary name resolved through the login shell's PATH. Empty for Custom. */
  binary: string;
  /** Interactive argv, without any profile environment applied. */
  launch: string[];
  /** Argv that continues the conversation after a profile switch. */
  resume: string[];
  /** Interactive login command, or null when the CLI has none. */
  loginCmd: string | null;
  installGuidance: MsgKey;
  /** Environment that isolates one profile dir from the user's own config. */
  profileEnv: (profileDir: string) => Record<string, string>;
  /**
   * Credential filenames removed on logout (relative to the profile dir).
   * Empty until the layout is verified against a real installation — logout
   * is then a confirmed no-op for that CLI.
   */
  credentialPaths: string[];
  /** CLI `--help` output the flags above were verified against, if any. */
  verifiedAgainst: string | null;
  /**
   * Lowercase substrings suggesting the agent waits for input (heuristic
   * fallback; agent hooks are the primary signal). Matched against trailing
   * PTY output. Only interactively verified entries are CLI-specific; the
   * shared generic choice/permission cues apply to every CLI.
   */
  waitingPatterns: string[];
  /**
   * Lowercase substrings suggesting the CLI hit a usage limit (spec §6.6.4).
   * Same fresh-output-only matching as waiting patterns. Shared generics for
   * every CLI until a vendor-specific wording is observed on a real run.
   */
  limitPatterns: string[];
}

/**
 * Generic "needs input" cues shared by every CLI. Conservative on purpose:
 * heuristics complement hooks, they never replace them.
 */
const GENERIC_WAITING_PATTERNS = [
  "do you want to proceed",
  "do you want to continue",
  "shall i proceed",
  "may i proceed",
  "awaiting approval",
  "needs your approval",
  "needs approval",
  "approval required",
  "permission required",
  "(y/n)",
  "[y/n]",
  "(yes/no)",
  "[yes/no]",
  "yes / no",
  "press enter to",
];

/**
 * Generic usage-limit cues, incl. the "weekly limit" wording observed on a
 * real Claude Code run. Conservative: matched against fresh output only.
 */
const GENERIC_LIMIT_PATTERNS = [
  "you've hit your",
  "you hit your",
  "weekly limit",
  "daily limit",
  "monthly limit",
  "usage limit",
  "rate limit",
  "limit reached",
  "limit exceeded",
  "over your limit",
  "quota exceeded",
  "out of credits",
  "credits exhausted",
  "resets at",
  "resets in",
  "upgrade to increase",
  "usage cap",
  "billing limit",
];

const CLAUDE: CliDef = {
  id: "claude",
  name: "Claude Code",
  binary: "claude",
  launch: ["claude"],
  resume: ["claude", "--continue"],
  loginCmd: null, // in-app `/login` slash command, not a shell argv
  installGuidance: "agents.installClaude",
  profileEnv: (profileDir) => ({ CLAUDE_CONFIG_DIR: profileDir }),
  // Verified: ~/.claude.json exists on this host, so under CLAUDE_CONFIG_DIR
  // the credentials live at .claude.json.
  credentialPaths: [".claude.json"],
  verifiedAgainst: "claude 2.1.280",
  waitingPatterns: [...GENERIC_WAITING_PATTERNS],
  limitPatterns: [...GENERIC_LIMIT_PATTERNS],
};

const CODEX: CliDef = {
  id: "codex",
  name: "Codex",
  binary: "codex",
  launch: ["codex"],
  resume: ["codex", "resume", "--last"],
  loginCmd: "codex login",
  installGuidance: "agents.installCodex",
  profileEnv: (profileDir) => ({ CODEX_HOME: profileDir }),
  // Verified: ~/.codex/auth.json exists on this host.
  credentialPaths: ["auth.json"],
  verifiedAgainst: "codex-cli 0.163.0",
  waitingPatterns: [...GENERIC_WAITING_PATTERNS],
  limitPatterns: [...GENERIC_LIMIT_PATTERNS],
};

const OPENCODE: CliDef = {
  id: "opencode",
  name: "OpenCode",
  binary: "opencode",
  launch: ["opencode"],
  resume: ["opencode", "--continue"],
  loginCmd: null,
  installGuidance: "agents.installOpencode",
  profileEnv: (profileDir) => ({ HOME: `${profileDir}/home` }),
  // No verified credential layout; logout stays a no-op until documented.
  credentialPaths: [],
  verifiedAgainst: "opencode 1.19.3",
  waitingPatterns: [...GENERIC_WAITING_PATTERNS],
  limitPatterns: [...GENERIC_LIMIT_PATTERNS],
};

const GEMINI: CliDef = {
  id: "gemini",
  name: "Gemini CLI",
  binary: "gemini",
  launch: ["gemini"],
  resume: ["gemini"],
  loginCmd: null,
  installGuidance: "agents.installGemini",
  profileEnv: (profileDir) => ({ HOME: `${profileDir}/home` }),
  // No verified credential layout; logout stays a no-op until documented.
  credentialPaths: [],
  verifiedAgainst: null, // not installed on this host; flags follow spec §6.6.1
  waitingPatterns: [...GENERIC_WAITING_PATTERNS],
  limitPatterns: [...GENERIC_LIMIT_PATTERNS],
};

const COPILOT: CliDef = {
  id: "copilot",
  name: "GitHub Copilot",
  binary: "copilot",
  launch: ["copilot"],
  resume: ["copilot", "--continue"],
  loginCmd: "copilot login",
  installGuidance: "agents.installCopilot",
  profileEnv: (profileDir) => ({ HOME: `${profileDir}/home` }),
  // No verified credential layout (auth may live in the system keychain,
  // which Branchwork never touches); logout stays a no-op until documented.
  credentialPaths: [],
  verifiedAgainst: "copilot 1.0.107",
  waitingPatterns: [...GENERIC_WAITING_PATTERNS],
  limitPatterns: [...GENERIC_LIMIT_PATTERNS],
};

const MUSE: CliDef = {
  id: "muse",
  name: "Muse",
  binary: "muse",
  launch: ["muse"],
  resume: ["muse", "resume", "--last"],
  loginCmd: "muse login",
  installGuidance: "agents.installMuse",
  // Orca's method: no HOME sandboxing for muse (it has no vendor config-dir
  // variable, and its Keychain-backed credentials only work under the real
  // HOME). The profile runs with the user's own environment and login.
  profileEnv: () => ({}),
  // No verified credential layout; logout stays a no-op until documented.
  credentialPaths: [],
  verifiedAgainst: "muse 1.4.14",
  waitingPatterns: [...GENERIC_WAITING_PATTERNS],
  limitPatterns: [...GENERIC_LIMIT_PATTERNS],
};

const CUSTOM: CliDef = {
  id: "custom",
  name: "Custom",
  binary: "",
  launch: [],
  resume: [],
  loginCmd: null,
  installGuidance: "agents.installCustom",
  profileEnv: () => ({}),
  credentialPaths: [],
  verifiedAgainst: null,
  waitingPatterns: [...GENERIC_WAITING_PATTERNS],
  limitPatterns: [...GENERIC_LIMIT_PATTERNS],
};

export const CLI_REGISTRY: Record<CliId, CliDef> = {
  claude: CLAUDE,
  codex: CODEX,
  opencode: OPENCODE,
  gemini: GEMINI,
  copilot: COPILOT,
  muse: MUSE,
  custom: CUSTOM,
};

export const CLI_IDS = Object.keys(CLI_REGISTRY) as CliId[];

/** Per-CLI overrides (Settings): replace argv/guidance, add env, pin a binary. */
export interface CliOverrides {
  binary?: string;
  launch?: string[];
  resume?: string[];
  extraEnv?: Record<string, string>;
  installGuidance?: string;
}

export interface ResolvedCli {
  binary: string;
  launch: string[];
  resume: string[];
  loginCmd: string | null;
  guidance: string;
  /** Profile environment for `profileDir`, with overrides merged in. */
  envFor: (profileDir: string) => Record<string, string>;
}

/** Merge overrides over a registry default without mutating either. */
export function resolveCli(def: CliDef, overrides?: CliOverrides): ResolvedCli {
  const launch = overrides?.launch ?? def.launch;
  const resume = overrides?.resume ?? def.resume;
  if (launch.length === 0) {
    throw new Error(`CLI ${def.id} needs a launch command (Settings override)`);
  }
  const baseEnv = def.profileEnv;
  const extraEnv = overrides?.extraEnv ?? {};
  return {
    binary: overrides?.binary ?? def.binary,
    launch: [...launch],
    resume: [...resume],
    loginCmd: def.loginCmd,
    guidance: overrides?.installGuidance ?? t(def.installGuidance),
    envFor: (profileDir) => ({ ...baseEnv(profileDir), ...extraEnv }),
  };
}

/** `name` → filesystem slug for `~/.branchwork/profiles/<cli>-<slug>/`. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return slug || "profile";
}

export function profileDirName(cliId: CliId, slug: string): string {
  return `${cliId}-${slugify(slug)}`;
}
