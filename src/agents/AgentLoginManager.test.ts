import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentLoginManager, type LoginManagerDeps } from "./AgentLoginManager";

function setup() {
  let output!: (event: { sessionId: string; data: number[] }) => void;
  let exit!: (event: { sessionId: string; exitCode: number | null; signal: string | null }) => void;
  let error!: (event: { sessionId: string; message: string }) => void;
  const deps: LoginManagerDeps = {
    spawn: vi.fn(async (ref) => ({ sessionId: `pty-${ref.slug}` })),
    attach: vi.fn(async () => undefined),
    onOutput: vi.fn(async (callback) => { output = callback; return vi.fn(); }),
    onExit: vi.fn(async (callback) => { exit = callback; return vi.fn(); }),
    onError: vi.fn(async (callback) => { error = callback; return vi.fn(); }),
    close: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
  };
  return { manager: createAgentLoginManager(deps), deps, output: (event: Parameters<typeof output>[0]) => output(event), exit: (event: Parameters<typeof exit>[0]) => exit(event), error: (event: Parameters<typeof error>[0]) => error(event) };
}

afterEach(() => vi.useRealTimers());

describe("AgentLoginManager", () => {
  it("limits active logins per profile and across the app", async () => {
    const { manager } = setup();
    const a = { cliId: "codex" as const, slug: "a" };
    const b = { cliId: "claude" as const, slug: "b" };
    await manager.start(a);
    await expect(manager.start(a)).rejects.toThrow(/already running/i);
    await manager.start(b);
    await expect(manager.start({ cliId: "muse", slug: "c" })).rejects.toThrow(/too many/i);
    await manager.cancel(a);
    expect(manager.activeCount).toBe(1);
  });

  it("opens only provider-allowlisted HTTPS URLs and keeps PTY output private", async () => {
    const { manager, output, deps } = setup();
    await manager.start({ cliId: "codex", slug: "work" });
    output({ sessionId: "pty-work", data: [...new TextEncoder().encode("https://auth.openai.com/oauth/authorize?state=abc")] });
    output({ sessionId: "pty-work", data: [...new TextEncoder().encode("https://evil.example/steal")] });
    await vi.waitFor(() => expect(deps.openUrl).toHaveBeenCalledTimes(1));
    expect(deps.openUrl).toHaveBeenCalledWith("https://auth.openai.com/oauth/authorize?state=abc");
  });

  it("attaches the hidden PTY so buffered startup output can be processed", async () => {
    const { manager, deps } = setup();
    await manager.start({ cliId: "codex", slug: "work" });
    expect(deps.attach).toHaveBeenCalledWith("pty-work", expect.any(Number));
  });

  it("closes the PTY after the fixed timeout and on process exit", async () => {
    vi.useFakeTimers();
    const { manager, deps, exit } = setup();
    await manager.start({ cliId: "claude", slug: "work" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.close).toHaveBeenCalledWith("pty-work");
    await manager.start({ cliId: "codex", slug: "next" });
    exit({ sessionId: "pty-next", exitCode: 0, signal: null });
    await vi.waitFor(() => expect(manager.activeCount).toBe(0));
  });

  it("cancels a login and clears its retained output", async () => {
    const { manager, deps, output } = setup();
    const ref = { cliId: "codex" as const, slug: "work" };
    await manager.start(ref);
    output({ sessionId: "pty-work", data: [...new TextEncoder().encode("private auth output")] });
    await manager.cancel(ref);
    expect(deps.close).toHaveBeenCalledWith("pty-work");
    expect(manager.activeCount).toBe(0);
    await manager.cancel(ref);
    expect(deps.close).toHaveBeenCalledTimes(1);
  });

  it("removes an earlier listener if a later listener cannot be registered", async () => {
    const { manager, deps } = setup();
    const unlistenOutput = vi.fn();
    vi.mocked(deps.onOutput).mockResolvedValueOnce(unlistenOutput);
    vi.mocked(deps.onExit).mockRejectedValueOnce(new Error("listener failed"));
    await expect(manager.start({ cliId: "codex", slug: "work" })).rejects.toThrow();
    expect(unlistenOutput).toHaveBeenCalledTimes(1);
    expect(manager.activeCount).toBe(0);
  });
});
