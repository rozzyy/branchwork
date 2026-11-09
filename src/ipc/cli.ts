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
