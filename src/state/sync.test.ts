import { beforeEach, vi } from "vitest";
import { gitPull, gitPush } from "../ipc/sync";
import { undoLast } from "../ipc/undo";
import { useDock } from "../terminal/dock";
import { toast } from "../ui/toast";
import { runGitAction, useGitBusy } from "./gitActions";
import { runSync } from "./sync";

vi.mock("../ipc/sync", () => ({ gitFetch: vi.fn(), gitPull: vi.fn(), gitPush: vi.fn() }));
vi.mock("../ipc/undo", () => ({ undoLast: vi.fn() }));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  useGitBusy.setState({ running: {} });
});

it("offers Open terminal to authenticate and stderr details on an auth failure", async () => {
  const openHere = vi.fn().mockResolvedValue(undefined);
  useDock.setState({ openHere });
  vi.mocked(gitPush).mockRejectedValue({
    kind: "gitAuth",
    message: "Git push failed: authentication required",
    detail: "fatal: Authentication failed for 'https://example.com/repo.git'",
    recoverable: true,
  });

  expect(await runSync("/repos/main", "push")).toBe(false);

  const shown = vi.mocked(toast).mock.calls[0][0];
  expect(shown.details).toContain("Authentication failed");
  expect(shown.action?.label).toBe("Open terminal to authenticate");
  shown.action?.run();
  expect(openHere).toHaveBeenCalledWith("/repos/main");
  expect(useGitBusy.getState().running).toEqual({});
});

it("offers Undo after a pull that moved HEAD", async () => {
  vi.mocked(gitPull).mockResolvedValue(true);

  expect(await runSync("/repos/main", "pull")).toBe(true);

  const shown = vi.mocked(toast).mock.calls[0][0];
  expect(shown.action?.label).toBe("Undo");
  shown.action?.run();
  expect(undoLast).toHaveBeenCalledWith("/repos/main");
});

// Regression: a double-clicked cherry-pick ran twice and left a non-undoable entry on top.
it("refuses a second git write in the same worktree while one is running", async () => {
  let finish: (value: boolean) => void = () => {};
  const write = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));

  const first = runGitAction("/repos/main", "Cherry-pick", write);
  expect(await runGitAction("/repos/main", "Cherry-pick", write)).toBe(false);
  expect(await runSync("/repos/main", "pull")).toBe(false);
  finish(true);

  expect(await first).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
  expect(gitPull).not.toHaveBeenCalled();
});
