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
  /**
   * Raw shell line for the resume, or null to join `resume` argv quoted.
   * Carries a `|| <fresh launch>` fallback: vendors exit non-zero when the
   * profile has no conversation yet, and the pane must not end at a shell.
   */
  resumeLine: string | null;
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
  // Raw resume line with a fresh-launch fallback: `--continue` exits
  // non-zero on a profile with no conversation, and the TUI must not die.
  resumeLine: "claude --continue || claude",
  // Sign in through the browser first, then complete Claude's first-run
  // onboarding in the same profile-scoped terminal.
  loginCmd: "claude auth login && claude",
  installGuidance: "agents.installClaude",
  // Claude's per-account config and onboarding state are isolated here.
  // Login status must be probed with this same environment: host-default
  // auth status can be true while this profile still needs onboarding.
  profileEnv: (profileDir) => ({ CLAUDE_CONFIG_DIR: profileDir }),
  // Auth is exposed through `claude auth status`, not a verified file path.
  // The probe determines profile login state; logout remains unavailable.
  credentialPaths: [],
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
  resumeLine: "codex resume --last || codex",
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
  resumeLine: "opencode --continue || opencode",
  // Shell login verified: `opencode auth login` (interactive provider picker
  // runs in the login PTY; `-p/--provider -m/--method` skip it). No
  // `--standalone` flag in the installed 1.19.3 (OpenCode 2 only).
  loginCmd: "opencode auth login",
  installGuidance: "agents.installOpencode",
  profileEnv: (profileDir) => ({ HOME: `${profileDir}/home` }),
  // Verified on this host: auth lives at ~/.local/share/opencode/auth.json,
  // which under the HOME sandbox is this nested path in the profile dir.
  credentialPaths: ["home/.local/share/opencode/auth.json"],
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
  resumeLine: null,
  // No shell login argv (installed CLI exposes none): auth completes inside
  // the interactive TUI on first run, so addProfile lands the pane in `gemini`.
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
  resumeLine: "copilot --continue || copilot",
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
  resumeLine: "muse resume --last || muse",
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
  resumeLine: null,
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
  /** Raw resume line, or null when the resume argv must be quoted instead. */
  resumeLine: string | null;
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
    // A resume override has no raw line: callers quote the argv instead.
    resumeLine: overrides?.resume ? null : def.resumeLine,
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
