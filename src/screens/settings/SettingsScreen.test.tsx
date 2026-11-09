import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsScreen";
import { useSettings } from "../../state/settings";
import { useProfiles } from "../../agents/profiles";
import { ask } from "../../ui/dialog";
import { logoutProfile as logoutProfileIpc } from "../../ipc/cli";
import { DEFAULT_THEME } from "../../theme/theme";

vi.mock("../../ui/dialog", () => ({
  ask: vi.fn(),
}));

vi.mock("../../ipc/cli", () => ({
  logoutProfile: vi.fn(() => Promise.resolve(["auth.json"])),
  ensureProfileDir: vi.fn(),
  resolveCliBinary: vi.fn(),
}));

beforeEach(() => {
  useSettings.setState({ theme: DEFAULT_THEME });
  useProfiles.setState({ profiles: [], globalDefault: null, cliDefaults: {}, loaded: true });
  vi.mocked(ask).mockReset();
  vi.mocked(logoutProfileIpc).mockReset().mockImplementation(() => Promise.resolve(["auth.json"]));
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
  fireEvent.click(screen.getByRole("button", { name: "Log out" }));
  await screen.findByText("Agent accounts");
  expect(vi.mocked(logoutProfileIpc)).toHaveBeenCalledWith("codex", "work", ["auth.json"]);
  // The profile record is kept so re-login works.
  expect(useProfiles.getState().profiles).toHaveLength(1);
});
