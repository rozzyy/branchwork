import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsScreen";
import { useSettings } from "../../state/settings";
import { useProfiles } from "../../agents/profiles";
import { ask } from "../../ui/dialog";
import {
  ensureProfileDir,
  logoutProfile as logoutProfileIpc,
  probeCli,
  profileHasCredentials,
  removeProfileData,
} from "../../ipc/cli";
import { DEFAULT_THEME } from "../../theme/theme";
import { readProfileQuota } from "../../ipc/quota";
import { useAgentMeters } from "../../agents/quota";

vi.mock("../../ui/dialog", () => ({
  ask: vi.fn(),
}));

vi.mock("../../ipc/quota", () => ({
  readProfileQuota: vi.fn(),
  readSaverStats: vi.fn(),
}));

vi.mock("../../ipc/cli", () => ({
  logoutProfile: vi.fn(() => Promise.resolve(["auth.json"])),
  ensureProfileDir: vi.fn(),
  resolveCliBinary: vi.fn(),
  profileHasCredentials: vi.fn(),
  probeCli: vi.fn(),
  removeProfileData: vi.fn(() => Promise.resolve(true)),
  seedClaudeOnboarding: vi.fn(() => Promise.resolve(true)),
}));

beforeEach(() => {
  useSettings.setState({ theme: DEFAULT_THEME });
  useProfiles.setState({
    profiles: [],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    loadError: null,
    usage: {},
    cliProbes: {},
    profileProbes: {},
    loginPending: {},
  });
  vi.mocked(ask).mockReset();
  vi.mocked(logoutProfileIpc).mockReset().mockImplementation(() => Promise.resolve(["auth.json"]));
  vi.mocked(ensureProfileDir).mockReset().mockImplementation(async (cliId, slug) => `/profile/${cliId}-${slug}`);
  vi.mocked(profileHasCredentials).mockReset().mockResolvedValue(true);
  vi.mocked(probeCli).mockReset().mockRejectedValue(new Error("no probe"));
  vi.mocked(removeProfileData).mockReset().mockResolvedValue(true);
  vi.mocked(readProfileQuota).mockReset().mockResolvedValue({ state: "noData" });
  useAgentMeters.setState({ quotas: {}, savings: {} });
});

function renderAccounts() {
  const view = render(<SettingsView />);
  fireEvent.click(screen.getByRole("tab", { name: "AI accounts" }));
  return view;
}

async function openMenu(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
  return screen.findByRole("menu");
}

async function addAccount(cliName: string) {
  fireEvent.click(screen.getByRole("button", { name: "Add account…" }));
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: cliName }));
}

const NOW = Date.now();
const H = 3_600_000;
const fiveHour = { minutes: 300, scope: null, percent: 42, resetsAtMs: NOW + 2 * H + 14 * 60_000 };
const weekly = { minutes: 10_080, scope: null, percent: 76, resetsAtMs: NOW + 78 * H };
const opus = { minutes: 10_080, scope: "opus", percent: 93, resetsAtMs: NOW + 78 * H };

function setProfiles(profiles: { cliId: "claude" | "codex" | "gemini" | "muse" | "copilot"; slug: string; name: string }[]) {
  useProfiles.setState({
    profiles: profiles.map((profile, index) => ({ ...profile, createdAt: index + 1 })),
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
}

it("opens on the General tab", () => {
  render(<SettingsView />);
  expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("Appearance")).toBeInTheDocument();
  expect(screen.getByText("Keyboard")).toBeInTheDocument();
  expect(screen.queryByText("Agent accounts")).not.toBeInTheDocument();
});

it("switches between settings tabs", () => {
  render(<SettingsView />);
  fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
  expect(screen.getByText("Auto-switch on limit")).toBeInTheDocument();
  expect(screen.queryByText("Appearance")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "AI accounts" }));
  expect(screen.getByRole("tab", { name: "AI accounts" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("Agent accounts")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "GitHub" }));
  expect(screen.getByText("GitHub accounts")).toBeInTheDocument();
  expect(screen.queryByText("Agent accounts")).not.toBeInTheDocument();
});

it("has no demo section", () => {
  render(<SettingsView />);
  for (const name of ["General", "Agents", "AI accounts", "GitHub"]) {
    fireEvent.click(screen.getByRole("tab", { name }));
    expect(screen.queryByText("Component preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show toast" })).not.toBeInTheDocument();
  }
});

it("changes theme mode and density from the Appearance card", async () => {
  render(<SettingsView />);
  await userEvent.click(screen.getByRole("radio", { name: "Light" }));
  await userEvent.click(screen.getByRole("radio", { name: "Compact" }));
  expect(useSettings.getState().theme.mode).toBe("light");
  expect(useSettings.getState().theme.density).toBe("compact");
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("appearance offers text size", async () => {
  render(<SettingsView />);
  expect(screen.getByRole("radiogroup", { name: "Text size" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: "Large" }));
  expect(useSettings.getState().theme.textSize).toBe("large");
  expect(document.documentElement.dataset.text).toBe("large");
  expect(screen.queryByText("Contrast")).not.toBeInTheDocument();
  expect(screen.queryByText("Reduce transparency")).not.toBeInTheDocument();
});

it("shows a page loader until account settings finish loading", () => {
  useProfiles.setState({ loaded: false, loadError: null });
  render(<SettingsView />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading settings…");
  expect(screen.queryByText("Appearance")).not.toBeInTheDocument();
});

it("lists per-CLI accounts and sets the default", async () => {
  useProfiles.setState({
    profiles: [
      { cliId: "codex", slug: "work", name: "Work", createdAt: 1 },
      { cliId: "codex", slug: "play", name: "Play", createdAt: 2 },
    ],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
  });
  renderAccounts();
  expect(screen.getByText("Agent accounts")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Add account…" })).toHaveLength(1);
  expect(screen.getByText("codex-work", { exact: false })).toBeInTheDocument();

  // Set Play as the codex default; resolution follows immediately.
  fireEvent.click(within(await openMenu("Play")).getByRole("menuitem", { name: "Set as default" }));
  expect(useProfiles.getState().resolveProfile("codex")).toEqual({ cliId: "codex", slug: "play" });
  expect(screen.getByText("Default", { selector: "span.chip" })).toBeInTheDocument();

  // Clearing falls back to the first profile.
  fireEvent.click(within(await openMenu("Play")).getByRole("menuitem", { name: "Clear default" }));
  expect(useProfiles.getState().resolveProfile("codex")).toEqual({ cliId: "codex", slug: "work" });
});

it("adds an account in Settings and immediately starts sign-in without leaving Settings", async () => {
  vi.mocked(ask).mockResolvedValueOnce("Personal");
  const login = vi.spyOn(useProfiles.getState(), "loginProfile").mockResolvedValue(true);
  renderAccounts();

  await addAccount("Claude Code");

  expect(await screen.findByText("Personal")).toBeInTheDocument();
  expect(await screen.findByText("Login status unavailable")).toBeInTheDocument();
  expect(login).toHaveBeenCalledWith({ cliId: "claude", slug: "personal" });
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  const menu = await openMenu("Personal");
  expect(within(menu).getByRole("menuitem", { name: "Rename…" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Remove account" })).toBeInTheDocument();
  expect(useProfiles.getState().profiles).toMatchObject([
    { cliId: "claude", slug: "personal", name: "Personal" },
  ]);
  login.mockRestore();
});

it("explains that adding Muse reuses device-wide credentials", async () => {
  vi.mocked(ask).mockResolvedValueOnce(null);
  renderAccounts();
  await addAccount("Muse");
  await vi.waitFor(() =>
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Muse credentials are shared on this device. Signing in replaces the login used by every Muse profile.",
      }),
    ),
  );
});

it("edits a profile name while keeping its directory identity stable", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "codex", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
  });
  vi.mocked(profileHasCredentials).mockResolvedValue(false);
  vi.mocked(ask).mockResolvedValueOnce("Primary");
  renderAccounts();

  fireEvent.click(within(await openMenu("Work")).getByRole("menuitem", { name: "Rename…" }));

  expect(await screen.findByText("Primary")).toBeInTheDocument();
  expect(useProfiles.getState().profiles[0]).toMatchObject({ slug: "work", name: "Primary" });
  expect(screen.getByText("codex-work", { exact: false })).toBeInTheDocument();
});

it("shows Sign in again and Remove — never Log out — for a profile that never logged in", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "codex", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
  vi.mocked(profileHasCredentials).mockResolvedValue(false);
  renderAccounts();
  expect(await screen.findByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  const menu = await openMenu("Work");
  expect(within(menu).getByRole("menuitem", { name: "Remove account" })).toBeInTheDocument();
  expect(within(menu).queryByRole("menuitem", { name: "Log out" })).not.toBeInTheDocument();
  expect(profileHasCredentials).toHaveBeenCalledWith("codex", "work", ["auth.json"]);
});

it("keeps login and profile actions available when the login status probe is unavailable", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "claude", slug: "personal", name: "Personal", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
  vi.mocked(probeCli).mockRejectedValue(new Error("probe unavailable"));
  renderAccounts();

  expect(await screen.findByText("Login status unavailable")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  const menu = await openMenu("Personal");
  expect(within(menu).getByRole("menuitem", { name: "Rename…" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Remove account" })).toBeInTheDocument();
});

it("removes a never-linked profile after confirmation", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "codex", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
  vi.mocked(profileHasCredentials).mockResolvedValue(false);
  vi.mocked(ask).mockResolvedValue(true);
  renderAccounts();
  fireEvent.click(within(await openMenu("Work")).getByRole("menuitem", { name: "Remove account" }));
  await screen.findByText("Agent accounts");
  expect(ask).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
  await vi.waitFor(() => expect(removeProfileData).toHaveBeenCalledWith("codex", "work"));
  expect(useProfiles.getState().profiles).toHaveLength(0);
});

it("warns that removing Muse signs out all device-wide Muse profiles", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "muse", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
  vi.mocked(ask).mockResolvedValue(true);
  renderAccounts();
  fireEvent.click(within(await openMenu("Work")).getByRole("menuitem", { name: "Remove account" }));
  await vi.waitFor(() =>
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Muse credentials are shared on this device. Removing this account signs out every Muse profile.",
      }),
    ),
  );
});

it("flips to Sign in again right after logout without a reload", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "codex", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
  // Mount check sees credentials; the re-check after logout does not.
  vi.mocked(profileHasCredentials).mockResolvedValueOnce(true).mockResolvedValue(false);
  vi.mocked(ask).mockResolvedValue(true);
  renderAccounts();
  await screen.findByText("✓ Logged in");
  fireEvent.click(within(await openMenu("Work")).getByRole("menuitem", { name: "Log out" }));
  expect(await screen.findByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  expect(within(await openMenu("Work")).queryByRole("menuitem", { name: "Log out" })).not.toBeInTheDocument();
});

it("shows a waiting-for-login loader while login is pending", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "codex", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
    loginPending: { "codex:work": 1 },
  });
  vi.mocked(profileHasCredentials).mockResolvedValue(false);
  renderAccounts();
  expect(await screen.findByText("Waiting for login…")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  expect(document.querySelector(".spin")).not.toBeNull();
});

it("explains that Copilot sign-in uses the device keychain rather than an isolated profile credential", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "copilot", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
  renderAccounts();
  expect(await screen.findByText(/Copilot sign-in is stored in the system keychain/i)).toBeInTheDocument();
});

it("shows a loader while the credential check is pending", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "codex", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
  let resolve!: (value: boolean) => void;
  vi.mocked(profileHasCredentials).mockImplementation(
    () =>
      new Promise<boolean>((run) => {
        resolve = run;
      }),
  );
  renderAccounts();
  expect(await screen.findByRole("status", { name: "Checking login status…" })).toBeInTheDocument();
  resolve(false);
  expect(await screen.findByRole("button", { name: "Sign in again" })).toBeInTheDocument();
});

it("uses the Claude profile probe instead of host auth status", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "claude", slug: "personal", name: "Personal", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
  vi.mocked(probeCli).mockImplementation((cliId, env) =>
    cliId === "claude"
      ? Promise.resolve(
          JSON.stringify({
            // The host is logged in, but this isolated account profile is not.
            loggedIn: env?.CLAUDE_CONFIG_DIR !== "/profile/claude-personal",
          }),
        )
      : Promise.reject(new Error("no probe")),
  );
  renderAccounts();
  expect(await screen.findByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  const menu = await openMenu("Personal");
  expect(within(menu).getByRole("menuitem", { name: "Remove account" })).toBeInTheDocument();
  expect(within(menu).queryByRole("menuitem", { name: "Log out" })).not.toBeInTheDocument();
  expect(probeCli).toHaveBeenCalledWith("claude", {
    CLAUDE_CONFIG_DIR: "/profile/claude-personal",
  });
});

it("shows the probe identity instead of Logout for a linked claude row", async () => {
  useProfiles.setState({
    profiles: [
      { cliId: "claude", slug: "personal", name: "Personal", createdAt: 1 },
      { cliId: "claude", slug: "work", name: "Work", createdAt: 2 },
    ],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
  vi.mocked(probeCli).mockImplementation((_cliId, env) =>
    Promise.resolve(
      JSON.stringify({
        loggedIn: true,
        email: env?.CLAUDE_CONFIG_DIR?.endsWith("personal")
          ? "personal@example.com"
          : "work@example.com",
      }),
    ),
  );
  renderAccounts();
  expect(await screen.findByText("personal@example.com")).toBeInTheDocument();
  expect(await screen.findByText("work@example.com")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in again" })).not.toBeInTheDocument();
});

it("shows real muse usage from the probe without a Logout button", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "muse", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
  const asOfMs = 1794231822000;
  vi.mocked(probeCli).mockResolvedValue(
    JSON.stringify({
      allowance: { window: { usedPercent: 25, resetsAtMs: asOfMs + 12 * 60000 }, asOfMs },
    }),
  );
  renderAccounts();
  expect(await screen.findByText("25%")).toBeInTheDocument();
  expect(screen.getByText("resets in 12m")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
});

it("shows Muse as logged in when credentials have no subscription allowance", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "muse", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
  vi.mocked(probeCli).mockResolvedValue(JSON.stringify({ allowance: null, reason: "api_key" }));
  renderAccounts();
  await waitFor(() => expect(useProfiles.getState().cliProbes.muse).toEqual({ linked: true, identity: null }));
});

it("offers login for an unprobed provider without claiming it is linked", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "copilot", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
  renderAccounts();
  await screen.findByText("Agent accounts");
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  const menu = await openMenu("Work");
  expect(within(menu).queryByRole("menuitem", { name: "Log out" })).not.toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Rename…" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Remove account" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Set as default" })).toBeInTheDocument();
  expect(probeCli).not.toHaveBeenCalledWith("copilot");
});

it("confirms logout and deletes only declared credential files", async () => {
  useProfiles.setState({
    profiles: [{ cliId: "codex", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
  });
  vi.mocked(ask).mockResolvedValue(true);
  const view = renderAccounts();
  await view.findByText("✓ Logged in");
  const menu = await openMenu("Work");
  expect(within(menu).getByRole("menuitem", { name: "Remove account" })).toBeInTheDocument();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Log out" }));
  await screen.findByText("Agent accounts");
  expect(vi.mocked(logoutProfileIpc)).toHaveBeenCalledWith("codex", "work", ["auth.json"]);
  // The profile record is kept so re-login works.
  expect(useProfiles.getState().profiles).toHaveLength(1);
});

it("reads usage for claude and codex rows when the tab opens", async () => {
  setProfiles([
    { cliId: "claude", slug: "work", name: "Work" },
    { cliId: "codex", slug: "main", name: "Main" },
    { cliId: "gemini", slug: "default", name: "Gem" },
  ]);
  renderAccounts();
  await waitFor(() => expect(readProfileQuota).toHaveBeenCalledTimes(2));
  expect(readProfileQuota).toHaveBeenCalledWith("claude", "/profile/claude-work");
  expect(readProfileQuota).toHaveBeenCalledWith("codex", "/profile/codex-main");
});

it("shows two headline meters and expands to every usage window", async () => {
  setProfiles([{ cliId: "claude", slug: "work", name: "Work" }]);
  vi.mocked(readProfileQuota).mockResolvedValue({ state: "ok", windows: [fiveHour, weekly, opus], fetchedAtMs: NOW });
  renderAccounts();
  const row = await screen.findByRole("group", { name: "Work" });
  await within(row).findByText("42%");
  expect(within(row).getByText("5h")).toBeInTheDocument();
  expect(within(row).getByText("Weekly · Opus")).toBeInTheDocument();
  expect(within(row).getByText("93%")).toBeInTheDocument();
  expect(within(row).queryByText("Weekly")).not.toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: "Show all usage windows" }));
  expect(within(row).getByText("Weekly")).toBeInTheDocument();
  expect(within(row).getByText("76%")).toBeInTheDocument();
  expect(within(row).getAllByText(/^resets in /)).toHaveLength(3);
});

it("shows an expired window as 0% reset", async () => {
  setProfiles([{ cliId: "codex", slug: "main", name: "Main" }]);
  vi.mocked(readProfileQuota).mockResolvedValue({
    state: "ok",
    windows: [{ minutes: 300, scope: null, percent: 80, resetsAtMs: NOW - 60_000 }],
    fetchedAtMs: NOW - H,
  });
  renderAccounts();
  const row = await screen.findByRole("group", { name: "Main" });
  expect(await within(row).findByText("0%")).toBeInTheDocument();
  expect(within(row).queryByText("80%")).not.toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: "Show all usage windows" }));
  expect(within(row).getByText("reset")).toBeInTheDocument();
});

it("check all usage re-reads every quota profile", async () => {
  setProfiles([
    { cliId: "claude", slug: "work", name: "Work" },
    { cliId: "codex", slug: "main", name: "Main" },
  ]);
  renderAccounts();
  await waitFor(() => expect(readProfileQuota).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Check all usage" }));
  await waitFor(() => expect(readProfileQuota).toHaveBeenCalledTimes(4));
});

it("keeps the last values when a usage refresh fails", async () => {
  setProfiles([{ cliId: "codex", slug: "main", name: "Main" }]);
  vi.mocked(readProfileQuota).mockResolvedValue({ state: "ok", windows: [fiveHour], fetchedAtMs: NOW });
  renderAccounts();
  const row = await screen.findByRole("group", { name: "Main" });
  await within(row).findByText("42%");
  fireEvent.click(within(row).getByRole("button", { name: "Show all usage windows" }));
  vi.mocked(readProfileQuota).mockRejectedValueOnce(new Error("boom"));
  fireEvent.click(within(row).getByRole("button", { name: "Check usage" }));
  expect(await within(row).findByText("refresh failed, showing last known values")).toBeInTheDocument();
  expect(within(row).getAllByText("42%").length).toBeGreaterThan(0);
});

it("says a provider without a usage source doesn't report usage", async () => {
  setProfiles([{ cliId: "gemini", slug: "default", name: "Gem" }]);
  renderAccounts();
  expect(await screen.findByText("Gemini CLI doesn't report plan usage.")).toBeInTheDocument();
  expect(readProfileQuota).not.toHaveBeenCalled();
});

it("shows no usage data for a Muse account signed in with an API key", async () => {
  setProfiles([{ cliId: "muse", slug: "work", name: "Work" }]);
  vi.mocked(probeCli).mockResolvedValue(JSON.stringify({ allowance: null, reason: "api_key" }));
  renderAccounts();
  const row = await screen.findByRole("group", { name: "Work" });
  expect(await within(row).findByText("No usage data")).toBeInTheDocument();
  expect(within(row).queryByText("Usage n/a")).not.toBeInTheDocument();
});

it("collapses providers without accounts into one not-connected line", async () => {
  setProfiles([{ cliId: "codex", slug: "main", name: "Main" }]);
  renderAccounts();
  const line = await screen.findByRole("group", { name: "Not connected" });
  expect(within(line).getByRole("button", { name: "Add OpenCode account" })).toBeInTheDocument();
  expect(within(line).queryByRole("button", { name: "Add Codex account" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "OpenCode" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
});

it("marks stale usage on the collapsed row after a failed refresh", async () => {
  setProfiles([{ cliId: "codex", slug: "main", name: "Main" }]);
  vi.mocked(readProfileQuota).mockResolvedValue({ state: "ok", windows: [fiveHour], fetchedAtMs: NOW });
  renderAccounts();
  const row = await screen.findByRole("group", { name: "Main" });
  await within(row).findByText("42%");
  expect(within(row).queryByTitle("refresh failed, showing last known values")).not.toBeInTheDocument();
  vi.mocked(readProfileQuota).mockRejectedValueOnce(new Error("boom"));
  fireEvent.click(screen.getByRole("button", { name: "Check all usage" }));
  expect(await within(row).findByTitle("refresh failed, showing last known values")).toBeInTheDocument();
  expect(within(row).queryByRole("button", { name: "Hide usage windows" })).not.toBeInTheDocument();
});
