import { fireEvent, render, screen } from "@testing-library/react";
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

vi.mock("../../ui/dialog", () => ({
  ask: vi.fn(),
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
});

it("changes theme mode and density from the Appearance card", async () => {
  render(<SettingsView />);
  await userEvent.click(screen.getByRole("radio", { name: "Light" }));
  await userEvent.click(screen.getByRole("radio", { name: "Compact" }));
  expect(useSettings.getState().theme.mode).toBe("light");
  expect(useSettings.getState().theme.density).toBe("compact");
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("toggles reduce transparency", async () => {
  render(<SettingsView />);
  await userEvent.click(screen.getByRole("switch", { name: "Reduce transparency" }));
  expect(useSettings.getState().theme.reduceTransparency).toBe(true);
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
  render(<SettingsView />);
  expect(screen.getByText("Agent accounts")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Add account…" })).toHaveLength(6);
  expect(screen.getByText("codex-work", { exact: false })).toBeInTheDocument();

  // Set Play as the codex default; resolution follows immediately.
  fireEvent.click(screen.getAllByRole("button", { name: "Set as default" })[1]);
  expect(useProfiles.getState().resolveProfile("codex")).toEqual({ cliId: "codex", slug: "play" });
  expect(screen.getByText("Default", { selector: "span.chip" })).toBeInTheDocument();

  // Clearing falls back to the first profile.
  fireEvent.click(screen.getByRole("button", { name: "✓ Default" }));
  expect(useProfiles.getState().resolveProfile("codex")).toEqual({ cliId: "codex", slug: "work" });
});

it("adds an account in Settings and immediately starts sign-in without leaving Settings", async () => {
  vi.mocked(ask).mockResolvedValueOnce("Personal");
  const login = vi.spyOn(useProfiles.getState(), "loginProfile").mockResolvedValue(true);
  render(<SettingsView />);

  await userEvent.click(screen.getAllByRole("button", { name: "Add account…" })[0]);

  expect(await screen.findByText("Personal")).toBeInTheDocument();
  expect(await screen.findByText("Login status unavailable")).toBeInTheDocument();
  expect(login).toHaveBeenCalledWith({ cliId: "claude", slug: "personal" });
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove account" })).toBeInTheDocument();
  expect(useProfiles.getState().profiles).toMatchObject([
    { cliId: "claude", slug: "personal", name: "Personal" },
  ]);
  login.mockRestore();
});

it("explains that adding Muse reuses device-wide credentials", async () => {
  vi.mocked(ask).mockResolvedValueOnce(null);
  render(<SettingsView />);
  await userEvent.click(screen.getAllByRole("button", { name: "Add account…" })[5]);
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
  render(<SettingsView />);

  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

  expect(await screen.findByText("Primary")).toBeInTheDocument();
  expect(useProfiles.getState().profiles[0]).toMatchObject({ slug: "work", name: "Primary" });
  expect(screen.getByText("codex-work", { exact: false })).toBeInTheDocument();
});

it("shows the usage bar only when the CLI reports usage", async () => {
  useProfiles.setState({
    profiles: [
      { cliId: "codex", slug: "work", name: "Work", createdAt: 1 },
      { cliId: "codex", slug: "play", name: "Play", createdAt: 2 },
    ],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: { "codex:work": { window: "5h", percent: 72 } },
  });
  render(<SettingsView />);
  expect(screen.getByText("Limit 5h · 72%")).toBeInTheDocument();
  expect(screen.getByText("No usage data")).toBeInTheDocument();
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
  render(<SettingsView />);
  expect(await screen.findByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove account" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
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
  render(<SettingsView />);

  expect(await screen.findByText("Login status unavailable")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove account" })).toBeInTheDocument();
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
  render(<SettingsView />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove account" }));
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
  render(<SettingsView />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove account" }));
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
  render(<SettingsView />);
  fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
  expect(await screen.findByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
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
  render(<SettingsView />);
  expect(await screen.findByText("Waiting for login…")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  expect(document.querySelector(".spin")).not.toBeNull();
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
  render(<SettingsView />);
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
  render(<SettingsView />);
  expect(await screen.findByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove account" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
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
  render(<SettingsView />);
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
  render(<SettingsView />);
  expect(await screen.findByText("Limit resets in 12m · 25%")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
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
  render(<SettingsView />);
  await screen.findByText("Agent accounts");
  expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove account" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Set as default" })).toBeInTheDocument();
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
  const view = render(<SettingsView />);
  expect(await view.findByRole("button", { name: "Log out" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove account" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Log out" }));
  await screen.findByText("Agent accounts");
  expect(vi.mocked(logoutProfileIpc)).toHaveBeenCalledWith("codex", "work", ["auth.json"]);
  // The profile record is kept so re-login works.
  expect(useProfiles.getState().profiles).toHaveLength(1);
});
