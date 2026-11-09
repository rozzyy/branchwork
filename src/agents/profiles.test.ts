import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfiles } from "./profiles";
import { ensureProfileDir, logoutProfile } from "../ipc/cli";
import { writeTerminal } from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { ask } from "../ui/dialog";
import { useToasts } from "../ui/toast";
import { useWorktrees } from "../state/worktrees";

vi.mock("../ipc/cli", () => ({
  ensureProfileDir: vi.fn(),
  logoutProfile: vi.fn(),
}));

vi.mock("../ipc/pty", () => ({
  writeTerminal: vi.fn(),
}));

vi.mock("../ipc/settings", () => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(),
}));

vi.mock("../ui/dialog", () => ({
  ask: vi.fn(),
}));

const newTab = vi.fn();
vi.mock("../terminal/screen", () => ({
  useTerminalScreen: {
    getState: () => ({
      newTab,
      tabs: [{ id: "tab-1", focusedPaneId: "p1", panes: { p1: { sessionId: "pty-9" } } }],
    }),
  },
}));

function reset() {
  useProfiles.setState({ profiles: [], globalDefault: null, cliDefaults: {}, loaded: false });
}

beforeEach(() => {
  vi.mocked(ensureProfileDir).mockReset().mockResolvedValue("/home/u/.branchwork/profiles/codex-work");
  vi.mocked(logoutProfile).mockReset().mockResolvedValue(["auth.json"]);
  vi.mocked(writeTerminal).mockReset().mockResolvedValue(undefined);
  vi.mocked(loadSetting).mockReset().mockResolvedValue(null);
  vi.mocked(saveSetting).mockReset().mockResolvedValue(undefined);
  vi.mocked(ask).mockReset().mockResolvedValue(true);
  newTab.mockReset().mockResolvedValue("tab-1");
  useToasts.setState({ toasts: [] });
  useWorktrees.setState({ activePath: "/wt/a" });
  reset();
});

describe("addProfile", () => {
  it("creates the dir, opens an isolated login tab, and runs the login command", async () => {
    const profile = await useProfiles.getState().addProfile("codex", "Work");
    expect(profile).toMatchObject({ cliId: "codex", slug: "work", name: "Work" });
    expect(ensureProfileDir).toHaveBeenCalledWith("codex", "work");
    expect(newTab).toHaveBeenCalledWith("/wt/a", { CODEX_HOME: "/home/u/.branchwork/profiles/codex-work" });
    expect(writeTerminal).toHaveBeenCalledWith("pty-9", new TextEncoder().encode("codex login\n"));
  });

  it("asks for a name and guides in-pane login when the CLI has none", async () => {
    vi.mocked(ask).mockResolvedValueOnce("Personal");
    const profile = await useProfiles.getState().addProfile("claude");
    expect(profile).toMatchObject({ slug: "personal" });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ input: "" }));
    expect(writeTerminal).not.toHaveBeenCalled();
  });

  it("aborts on cancel, blank names, and duplicate slugs", async () => {
    vi.mocked(ask).mockResolvedValueOnce(null);
    expect(await useProfiles.getState().addProfile("codex")).toBeNull();
    expect(ensureProfileDir).not.toHaveBeenCalled();

    expect(await useProfiles.getState().addProfile("codex", "   ")).toBeNull();
    expect(ensureProfileDir).not.toHaveBeenCalled();

    await useProfiles.getState().addProfile("codex", "Work");
    expect(await useProfiles.getState().addProfile("codex", "work")).toBeNull();
    expect(useProfiles.getState().profiles).toHaveLength(1);
  });
});

describe("logoutProfile", () => {
  it("confirms, deletes only declared credential files, and keeps the profile", async () => {
    await useProfiles.getState().addProfile("codex", "Work");
    const removed = await useProfiles.getState().logoutProfile({ cliId: "codex", slug: "work" });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(logoutProfile).toHaveBeenCalledWith("codex", "work", ["auth.json"]);
    expect(removed).toEqual(["auth.json"]);
    expect(useProfiles.getState().profiles).toHaveLength(1);
  });

  it("aborts on cancel and on unknown profiles", async () => {
    await useProfiles.getState().addProfile("codex", "Work");
    vi.mocked(ask).mockResolvedValueOnce(null);
    expect(await useProfiles.getState().logoutProfile({ cliId: "codex", slug: "work" })).toBeNull();
    expect(logoutProfile).not.toHaveBeenCalled();

    expect(await useProfiles.getState().logoutProfile({ cliId: "codex", slug: "nope" })).toBeNull();
  });
});

describe("resolution and defaults", () => {
  it("resolves explicit, group, global, cli-default, then first profile", async () => {
    await useProfiles.getState().addProfile("codex", "One");
    await useProfiles.getState().addProfile("codex", "Two");
    const one = { cliId: "codex" as const, slug: "one" };
    const two = { cliId: "codex" as const, slug: "two" };
    const other = { cliId: "claude" as const, slug: "one" };

    expect(useProfiles.getState().resolveProfile("codex", { explicit: two })).toEqual(two);
    expect(useProfiles.getState().resolveProfile("codex")).toEqual(one);

    useProfiles.getState().setCliDefault("codex", two);
    expect(useProfiles.getState().resolveProfile("codex")).toEqual(two);

    useProfiles.getState().setGlobalDefault(two);
    expect(useProfiles.getState().resolveProfile("codex", { explicit: one })).toEqual(one);

    // A default from another CLI or a missing profile never wins.
    useProfiles.getState().setGlobalDefault(other);
    expect(useProfiles.getState().resolveProfile("codex")).toEqual(two);
    expect(
      useProfiles.getState().resolveProfile("codex", { explicit: { cliId: "codex", slug: "gone" } }),
    ).toEqual(two);
  });

  it("ignores defaults that reference unknown profiles", () => {
    useProfiles.getState().setGlobalDefault({ cliId: "codex", slug: "ghost" });
    expect(useProfiles.getState().globalDefault).toBeNull();
    useProfiles.getState().setCliDefault("codex", { cliId: "claude", slug: "ghost" });
    expect(useProfiles.getState().cliDefaults).toEqual({});
  });

  it("restores saved profiles and drops invalid entries", async () => {
    vi.mocked(loadSetting).mockResolvedValue({
      profiles: [
        { cliId: "codex", slug: "work", name: "Work", createdAt: 1 },
        { cliId: "nope", slug: "x", name: "X" },
        { cliId: "codex", slug: 42, name: "Bad" },
      ],
      globalDefault: { cliId: "codex", slug: "work" },
      cliDefaults: { codex: { cliId: "codex", slug: "work" }, bad: { cliId: "x", slug: "y" } },
    });
    await useProfiles.getState().load();
    const state = useProfiles.getState();
    expect(state.profiles).toHaveLength(1);
    expect(state.globalDefault).toEqual({ cliId: "codex", slug: "work" });
    expect(state.cliDefaults).toEqual({ codex: { cliId: "codex", slug: "work" } });
  });

  it("never persists credential-shaped fields", async () => {
    await useProfiles.getState().addProfile("codex", "Work");
    await new Promise((resolve) => setTimeout(resolve, 350));
    const calls = vi.mocked(saveSetting).mock.calls;
    const payload = JSON.stringify(calls[calls.length - 1]?.[1]);
    expect(payload).not.toMatch(/token|secret|password|credential|apiKey/i);
    for (const profile of useProfiles.getState().profiles) {
      expect(Object.keys(profile).sort()).toEqual(["cliId", "createdAt", "name", "slug"]);
    }
  });
});
