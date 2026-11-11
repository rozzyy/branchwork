import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfiles } from "./profiles";
import {
  ensureProfileDir,
  logoutProfile,
  probeCli,
  profileHasCredentials,
  removeProfileData,
  seedClaudeOnboarding,
} from "../ipc/cli";
import { writeTerminal } from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { ask } from "../ui/dialog";
import { useToasts } from "../ui/toast";
import { useWorktrees } from "../state/worktrees";
import { useStage } from "../state/stage";

vi.mock("../ipc/cli", () => ({
  ensureProfileDir: vi.fn(),
  logoutProfile: vi.fn(),
  profileHasCredentials: vi.fn(),
  probeCli: vi.fn(),
  removeProfileData: vi.fn(),
  seedClaudeOnboarding: vi.fn(),
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
      load: vi.fn().mockResolvedValue(undefined),
      newTab,
      tabs: [{ id: "tab-1", focusedPaneId: "p1", panes: { p1: { sessionId: "pty-9" } } }],
    }),
  },
}));

function reset() {
  useProfiles.setState({
    profiles: [],
    globalDefault: null,
    cliDefaults: {},
    loaded: false,
    loadError: null,
    usage: {},
    cliProbes: {},
    profileProbes: {},
    loginPending: {},
  });
}

beforeEach(() => {
  vi.mocked(ensureProfileDir).mockReset().mockResolvedValue("/home/u/.branchwork/profiles/codex-work");
  vi.mocked(seedClaudeOnboarding).mockReset().mockResolvedValue(true);
  vi.mocked(logoutProfile).mockReset().mockResolvedValue(["auth.json"]);
  vi.mocked(removeProfileData).mockReset().mockResolvedValue(true);
  vi.mocked(profileHasCredentials).mockReset().mockResolvedValue(true);
  vi.mocked(probeCli).mockReset().mockRejectedValue(new Error("no probe"));
  vi.mocked(writeTerminal).mockReset().mockResolvedValue(undefined);
  vi.mocked(loadSetting).mockReset().mockResolvedValue(null);
  vi.mocked(saveSetting).mockReset().mockResolvedValue(undefined);
  vi.mocked(ask).mockReset().mockResolvedValue(true);
  newTab.mockReset().mockResolvedValue("tab-1");
  useToasts.setState({ toasts: [] });
  useWorktrees.setState({ activePath: "/wt/a" });
  useStage.setState({ panes: ["settings"], focus: 0, dir: "h", ratio: 0.5 });
  reset();
});

describe("addProfile", () => {
  it("creates the dir, opens an isolated login tab, and runs the login command", async () => {
    const profile = await useProfiles.getState().addProfile("codex", "Work");
    expect(profile).toMatchObject({ cliId: "codex", slug: "work", name: "Work" });
    expect(ensureProfileDir).toHaveBeenCalledWith("codex", "work");
    expect(newTab).toHaveBeenCalledWith("/wt/a", { CODEX_HOME: "/home/u/.branchwork/profiles/codex-work" });
    expect(writeTerminal).toHaveBeenCalledWith("pty-9", new TextEncoder().encode("codex login\n"));
    expect(useStage.getState().panes).toContain("terminal");
  });

  it("asks for a name and signs in through the browser before opening Claude", async () => {
    vi.mocked(ask).mockResolvedValueOnce("Personal");
    const profile = await useProfiles.getState().addProfile("claude");
    expect(profile).toMatchObject({ slug: "personal" });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ input: "" }));
    expect(writeTerminal).toHaveBeenCalledWith(
      "pty-9",
      new TextEncoder().encode("claude auth login && claude\n"),
    );
  });

  it("seeds Claude onboarding at creation so a verified login skips the wizard", async () => {
    await useProfiles.getState().createProfile("claude", "Personal");
    expect(seedClaudeOnboarding).toHaveBeenCalledWith("claude", "personal");
  });

  it("seeds onboarding again when reopening login for a claude profile", async () => {
    await useProfiles.getState().createProfile("claude", "Personal");
    vi.mocked(seedClaudeOnboarding).mockClear();
    expect(await useProfiles.getState().loginProfile({ cliId: "claude", slug: "personal" })).toBe(true);
    expect(seedClaudeOnboarding).toHaveBeenCalledWith("claude", "personal");
  });

  it("never seeds onboarding for other CLIs and survives seed failures", async () => {
    await useProfiles.getState().createProfile("codex", "Work");
    expect(seedClaudeOnboarding).not.toHaveBeenCalled();
    vi.mocked(seedClaudeOnboarding).mockRejectedValueOnce(new Error("denied"));
    const profile = await useProfiles.getState().createProfile("claude", "Personal");
    expect(profile).toMatchObject({ cliId: "claude", slug: "personal" });
  });

  it("tells the user to finish Claude setup once the login is detected", async () => {
    vi.mocked(probeCli)
      .mockResolvedValueOnce(JSON.stringify({ loggedIn: false }))
      .mockResolvedValue(JSON.stringify({ loggedIn: true }));
    await useProfiles.getState().addProfile("claude", "Work");
    await vi.waitFor(
      () => {
        expect(useProfiles.getState().loginPending["claude:work"]).toBeUndefined();
      },
      { timeout: 3000 },
    );
    const noticed = useToasts
      .getState()
      .toasts.find((item) => item.title.includes("Claude Code"));
    expect(noticed?.detail).toMatch(/setup/i);
  });

  it("monitors login until the vendor credentials actually appear", async () => {
    vi.mocked(profileHasCredentials)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    await useProfiles.getState().addProfile("codex", "Work");
    expect(useProfiles.getState().loginPending["codex:work"]).toBeTypeOf("number");
    await vi.waitFor(
      () => {
        expect(useProfiles.getState().loginPending["codex:work"]).toBeUndefined();
      },
      { timeout: 3000 },
    );
    expect(useToasts.getState().toasts.some((item) => item.title.includes("Codex"))).toBe(true);
  });

  it("runs the real shell login for opencode (interactive picker in the PTY)", async () => {
    const profile = await useProfiles.getState().addProfile("opencode", "Work");
    expect(profile).toMatchObject({ cliId: "opencode", slug: "work" });
    expect(writeTerminal).toHaveBeenCalledWith("pty-9", new TextEncoder().encode("opencode auth login\n"));
  });

  it("lands in the gemini TUI when the CLI exposes no login argv", async () => {
    const profile = await useProfiles.getState().addProfile("gemini", "Work");
    expect(profile).toMatchObject({ cliId: "gemini", slug: "work" });
    expect(writeTerminal).toHaveBeenCalledWith("pty-9", new TextEncoder().encode("gemini\n"));
  });

  it("explains and rolls back when a custom CLI has no launch override", async () => {
    vi.mocked(ask).mockResolvedValueOnce("Mine");
    expect(await useProfiles.getState().addProfile("custom")).toBeNull();
    expect(newTab).not.toHaveBeenCalled();
    expect(writeTerminal).not.toHaveBeenCalled();
    expect(useProfiles.getState().profiles).toHaveLength(0);
  });

  it("rolls the profile back when the login tab cannot open", async () => {
    newTab.mockRejectedValueOnce(new Error("no worktree"));
    expect(await useProfiles.getState().addProfile("codex", "Work")).toBeNull();
    expect(useProfiles.getState().profiles).toHaveLength(0);
  });

  it("rolls the profile back when starting the login step fails", async () => {
    vi.mocked(writeTerminal).mockRejectedValueOnce(new Error("pty gone"));
    expect(await useProfiles.getState().addProfile("codex", "Work")).toBeNull();
    expect(useProfiles.getState().profiles).toHaveLength(0);
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

describe("loginProfile", () => {
  it("re-opens the login tab for an existing profile and keeps the record", async () => {
    await useProfiles.getState().addProfile("claude", "Personal");
    vi.mocked(writeTerminal).mockClear();
    expect(await useProfiles.getState().loginProfile({ cliId: "claude", slug: "personal" })).toBe(true);
    expect(newTab).toHaveBeenCalledTimes(2);
    expect(writeTerminal).toHaveBeenCalledWith(
      "pty-9",
      new TextEncoder().encode("claude auth login && claude\n"),
    );
    expect(useProfiles.getState().profiles).toHaveLength(1);
  });

  it("fails closed on unknown profiles without opening a tab", async () => {
    expect(
      await useProfiles.getState().loginProfile({ cliId: "claude", slug: "ghost" }),
    ).toBe(false);
    expect(newTab).not.toHaveBeenCalled();
  });
});

describe("renameProfile", () => {
  it("renames the display label without changing the profile slug", async () => {
    await useProfiles.getState().createProfile("codex", "Work");

    expect(useProfiles.getState().renameProfile({ cliId: "codex", slug: "work" }, "Primary Work")).toBe(true);
    expect(useProfiles.getState().profiles[0]).toMatchObject({
      slug: "work",
      name: "Primary Work",
    });
  });

  it("rejects blank names and names that collide with another profile slug", async () => {
    await useProfiles.getState().createProfile("codex", "Work");
    await useProfiles.getState().createProfile("codex", "Personal");

    expect(useProfiles.getState().renameProfile({ cliId: "codex", slug: "work" }, "  ")).toBe(false);
    expect(useProfiles.getState().renameProfile({ cliId: "codex", slug: "work" }, "Personal")).toBe(false);
    expect(useProfiles.getState().profiles[0].name).toBe("Work");
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

describe("removeAccount", () => {
  it("deletes profile data before dropping the account and its defaults", async () => {
    await useProfiles.getState().createProfile("codex", "Work");
    const ref = { cliId: "codex" as const, slug: "work" };
    useProfiles.getState().setGlobalDefault(ref);
    useProfiles.getState().setCliDefault("codex", ref);
    useProfiles.getState().setProfileUsage(ref, { window: "5h", percent: 45 });

    expect(await useProfiles.getState().removeAccount(ref)).toBe(true);
    expect(removeProfileData).toHaveBeenCalledWith("codex", "work");
    expect(useProfiles.getState().profiles).toHaveLength(0);
    expect(useProfiles.getState().globalDefault).toBeNull();
    expect(useProfiles.getState().cliDefaults).toEqual({});
    expect(useProfiles.getState().usage["codex:work"]).toBeUndefined();
  });

  it("keeps the account when credential removal fails", async () => {
    await useProfiles.getState().createProfile("codex", "Work");
    vi.mocked(removeProfileData).mockRejectedValueOnce(new Error("permission denied"));

    expect(
      await useProfiles.getState().removeAccount({ cliId: "codex", slug: "work" }),
    ).toBe(false);
    expect(useProfiles.getState().profiles).toHaveLength(1);
    const toasts = useToasts.getState().toasts;
    expect(toasts[toasts.length - 1]?.title).toBe("permission denied");
  });

  it("keeps the account when native removal confirmation is declined", async () => {
    await useProfiles.getState().createProfile("codex", "Work");
    vi.mocked(removeProfileData).mockResolvedValueOnce(false);

    expect(await useProfiles.getState().removeAccount({ cliId: "codex", slug: "work" })).toBe(false);
    expect(useProfiles.getState().profiles).toHaveLength(1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("clears every Muse row's status when removing shared Muse credentials", async () => {
    await useProfiles.getState().createProfile("muse", "Work");
    await useProfiles.getState().createProfile("muse", "Personal");
    useProfiles.getState().setCliProbe("muse", { linked: true, identity: null });
    useProfiles.getState().setProfileUsage(
      { cliId: "muse", slug: "personal" },
      { window: "5h", percent: 30 },
    );

    expect(await useProfiles.getState().removeAccount({ cliId: "muse", slug: "work" })).toBe(true);
    expect(useProfiles.getState().cliProbes.muse).toEqual({ linked: false, identity: null });
    expect(useProfiles.getState().usage["muse:personal"]).toBeUndefined();
    expect(useProfiles.getState().profiles).toHaveLength(1);
  });
});

describe("profile usage", () => {
  it("records, clamps, and clears live usage without touching the profile", async () => {
    await useProfiles.getState().addProfile("codex", "Work");
    const ref = { cliId: "codex" as const, slug: "work" };
    useProfiles.getState().setProfileUsage(ref, { window: "5h", percent: 72.4 });
    expect(useProfiles.getState().usage["codex:work"]).toEqual({ window: "5h", percent: 72 });
    useProfiles.getState().setProfileUsage(ref, { window: "5h", percent: 140 });
    expect(useProfiles.getState().usage["codex:work"]?.percent).toBe(100);
    useProfiles.getState().setProfileUsage(ref, null);
    expect(useProfiles.getState().usage["codex:work"]).toBeUndefined();
    expect(useProfiles.getState().profiles).toHaveLength(1);
  });

  it("drops usage with the profile on rollback", async () => {
    await useProfiles.getState().addProfile("codex", "Work");
    const ref = { cliId: "codex" as const, slug: "work" };
    useProfiles.getState().setProfileUsage(ref, { window: "5h", percent: 10 });
    useProfiles.getState().removeProfile(ref);
    expect(useProfiles.getState().usage["codex:work"]).toBeUndefined();
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
        { cliId: "toString", slug: "x", name: "Inherited", createdAt: 2 },
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

  it("strips unknown fields from restored profiles and defaults before persisting", async () => {
    vi.mocked(loadSetting).mockResolvedValue({
      profiles: [{ cliId: "codex", slug: "work", name: "Work", createdAt: 1, token: "secret" }],
      globalDefault: { cliId: "codex", slug: "work", password: "secret" },
      cliDefaults: { codex: { cliId: "codex", slug: "work", apiKey: "secret" } },
    });

    await useProfiles.getState().load();
    expect(useProfiles.getState().profiles).toEqual([
      { cliId: "codex", slug: "work", name: "Work", createdAt: 1 },
    ]);
    expect(useProfiles.getState().globalDefault).toEqual({ cliId: "codex", slug: "work" });
    expect(useProfiles.getState().cliDefaults).toEqual({ codex: { cliId: "codex", slug: "work" } });

    await new Promise((resolve) => setTimeout(resolve, 350));
    const calls = vi.mocked(saveSetting).mock.calls;
    const saved = calls[calls.length - 1]?.[1];
    expect(JSON.stringify(saved)).not.toMatch(/secret|token|password|apiKey/i);
    expect(saved).toEqual({
      profiles: [{ cliId: "codex", slug: "work", name: "Work", createdAt: 1 }],
      globalDefault: { cliId: "codex", slug: "work" },
      cliDefaults: { codex: { cliId: "codex", slug: "work" } },
    });
  });

  it("records profile loading errors so Settings can offer retry", async () => {
    vi.mocked(loadSetting).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(useProfiles.getState().load()).rejects.toThrow("storage unavailable");
    expect(useProfiles.getState().loadError).toBe("storage unavailable");
    expect(useProfiles.getState().loaded).toBe(false);
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
