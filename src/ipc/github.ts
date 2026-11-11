// Typed wrappers for the GitHub auth backend commands (M4, spec §6.7).
// Tokens live in the platform credential store only: they are passed in
// from the device-flow/PAT UI, never synthesized here, and status calls
// never return them. Accounts are GitHub usernames; the device_code never
// leaves the backend.
import { commands } from "./bindings";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface DeviceStart {
  requestId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DeviceState = "pending" | "authorized" | "expired" | "denied";

export interface DevicePoll {
  state: DeviceState;
  username: string | null;
  interval: number;
}

/** Store a user-supplied token under an account. Never synthesized. */
export function setGithubToken(token: string, account: string): Promise<void> {
  if (!inTauri()) {
    return Promise.reject(new Error("Storing the GitHub token requires the desktop app"));
  }
  return commands.ghAuthSetToken(token, account).then(() => undefined);
}

/**
 * True when a token is stored (for the account, or any account when
 * omitted). The token itself is never returned.
 */
export function githubAuthStatus(account?: string): Promise<{ linked: boolean }> {
  if (!inTauri()) {
    return Promise.reject(new Error("Checking GitHub auth requires the desktop app"));
  }
  return commands.ghAuthStatus(account ?? null);
}

/** Delete the stored token for an account. True when something was removed. */
export function signOutGithub(account: string): Promise<boolean> {
  if (!inTauri()) {
    return Promise.reject(new Error("Signing out of GitHub requires the desktop app"));
  }
  return commands.ghAuthSignOut(account);
}

/**
 * Start a device authorization. Returns the user code and verification URI;
 * the device code stays backend-side under the returned request id.
 */
export function startGithubDeviceFlow(): Promise<DeviceStart> {
  if (!inTauri()) {
    return Promise.reject(new Error("Starting GitHub login requires the desktop app"));
  }
  return commands.ghAuthStart().then((start) => ({
    requestId: start.request_id,
    userCode: start.user_code,
    verificationUri: start.verification_uri,
    expiresIn: start.expires_in,
    interval: start.interval,
  }));
}

/** Poll one in-flight device authorization once (interval-enforced). */
export function pollGithubDeviceFlow(requestId: string): Promise<DevicePoll> {
  if (!inTauri()) {
    return Promise.reject(new Error("Polling GitHub login requires the desktop app"));
  }
  return commands.ghAuthPoll(requestId).then((poll) => ({
    state: poll.state,
    username: poll.username,
    interval: poll.interval,
  }));
}

/** Verify a user-supplied PAT, store it under its username, return the name. */
export function verifyGithubPat(token: string): Promise<string> {
  if (!inTauri()) {
    return Promise.reject(new Error("Verifying the GitHub token requires the desktop app"));
  }
  return commands.ghAuthPat(token).then((result) => result.username);
}

/**
 * Open the device-flow verification page in the system browser.
 * The backend allowlists the URL; anything else is refused there.
 */
export function openGithubUrl(url: string): Promise<void> {
  if (!inTauri()) {
    return Promise.reject(new Error("Opening the browser requires the desktop app"));
  }
  return commands.ghOpenUrl(url).then(() => undefined);
}
