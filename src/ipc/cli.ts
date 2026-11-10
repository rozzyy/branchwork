// Typed wrappers for the CLI registry backend commands (spec §6.6.1).
import { commands } from "./bindings";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Resolve a CLI binary through the login shell's PATH. */
export function resolveCliBinary(binary: string): Promise<string> {
  if (!inTauri()) {
    return Promise.reject(new Error("Resolving a CLI requires the desktop app"));
  }
  return commands.cliResolve(binary);
}

/** Create (when needed) the isolated profile dir and return its path. */
export function ensureProfileDir(cliId: string, slug: string): Promise<string> {
  if (!inTauri()) {
    return Promise.reject(new Error("Creating a profile requires the desktop app"));
  }
  return commands.cliProfileDir(cliId, slug);
}

/**
 * Run a read-only vendor status probe and return its stdout. Only CLIs with
 * a verified machine-readable command are accepted (claude, muse); anything
 * else rejects. The command itself is fixed server-side.
 */
export function probeCli(cliId: string, env?: Record<string, string>): Promise<string> {
  if (!inTauri()) {
    return Promise.reject(new Error("Probing a CLI requires the desktop app"));
  }
  return commands.cliProbe(cliId, env ?? null);
}

/**
 * Seed Claude's one-time onboarding flag for an isolated profile dir.
 * Exclusive-create only: never reads or overwrites existing credentials.
 * Best-effort — callers ignore failures and let the vendor wizard run.
 */
export function seedClaudeOnboarding(cliId: string, slug: string): Promise<boolean> {
  if (!inTauri()) {
    return Promise.reject(new Error("Seeding onboarding requires the desktop app"));
  }
  return commands.cliSeedOnboarding(cliId, slug);
}

/**
 * True when any declared credential file exists in the profile dir —
 * the vendor login actually completed there. Empty file lists (providers
 * whose credentials live outside the profile dir) always report false.
 */
export function profileHasCredentials(
  cliId: string,
  slug: string,
  credentialFiles: string[],
): Promise<boolean> {
  if (!inTauri()) {
    return Promise.reject(new Error("Checking credentials requires the desktop app"));
  }
  return commands.cliHasCredentials(cliId, slug, credentialFiles);
}

/**
 * Remove the registry's declared credential files inside a profile dir.
 * Returns the names actually removed. Nothing else is touched.
 */
export function logoutProfile(
  cliId: string,
  slug: string,
  credentialFiles: string[],
): Promise<string[]> {
  if (!inTauri()) {
    return Promise.reject(new Error("Logging out requires the desktop app"));
  }
  return commands.cliLogoutProfile(cliId, slug, credentialFiles);
}

/** Confirm removal and delete all data in one isolated Branchwork profile. */
export function removeProfileData(cliId: string, slug: string): Promise<boolean> {
  if (!inTauri()) {
    return Promise.reject(new Error("Removing an account requires the desktop app"));
  }
  return commands.cliRemoveProfile(cliId, slug);
}
