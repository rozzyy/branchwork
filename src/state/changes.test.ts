import { readStatus, type StatusSummary } from "../ipc/status";
import { readDiff } from "../ipc/diff";
import {
  commit,
  commitAndPush,
  commitAndSync,
  discardPaths,
  revertHunk,
  stageHunks,
  stageLines,
  stagePaths,
  unstageHunks,
  unstagePaths,
} from "../ipc/changes";
import {
  stashApply,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
} from "../ipc/stash";
import { toast } from "../ui/toast";
import { undoLast } from "../ipc/undo";
import { useChanges } from "./changes";
import { useWorktrees } from "./worktrees";

vi.mock("../ipc/status", () => ({ readStatus: vi.fn() }));
vi.mock("../ipc/diff", () => ({ readDiff: vi.fn() }));
vi.mock("../ipc/changes", () => ({
  commit: vi.fn(),
  commitAndPush: vi.fn(),
  commitAndSync: vi.fn(),
  stagePaths: vi.fn(),
  unstagePaths: vi.fn(),
  discardPaths: vi.fn(),
  stageHunks: vi.fn(),
  unstageHunks: vi.fn(),
  stageLines: vi.fn(),
  revertHunk: vi.fn(),
}));
vi.mock("../ipc/stash", () => ({
  stashList: vi.fn(),
  stashPush: vi.fn(),
  stashApply: vi.fn(),
  stashPop: vi.fn(),
  stashDrop: vi.fn(),
}));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
vi.mock("../ipc/undo", () => ({ undoLast: vi.fn() }));

const stagedEntry = { path: "a.ts", oldPath: null, indexStatus: "M", worktreeStatus: "", bytes: 1, large: false };
const unstagedEntry = { path: "b.ts", oldPath: null, indexStatus: "", worktreeStatus: "M", bytes: 2, large: false };

function summary(overrides: Partial<StatusSummary> = {}): StatusSummary {
  return { staged: [stagedEntry], unstaged: [unstagedEntry], ...overrides };
}

beforeEach(() => {
  vi.mocked(readStatus).mockReset().mockResolvedValue(summary());
  vi.mocked(readDiff).mockReset();
  for (const fn of [
    stagePaths,
    unstagePaths,
    stageHunks,
    unstageHunks,
    stageLines,
    revertHunk,
  ]) {
    vi.mocked(fn).mockReset().mockResolvedValue(undefined);
  }
  for (const fn of [commit, commitAndPush, commitAndSync, discardPaths]) {
    vi.mocked(fn).mockReset().mockResolvedValue(false);
  }
  vi.mocked(stashList).mockReset().mockResolvedValue([]);
  for (const fn of [stashPush, stashApply, stashPop]) {
    vi.mocked(fn).mockReset().mockResolvedValue(undefined);
  }
  vi.mocked(stashDrop).mockReset().mockResolvedValue(false);
  vi.mocked(toast).mockReset();
  useChanges.setState({
    worktree: null,
    entries: { staged: [], unstaged: [] },
    stashes: [],
    loading: false,
    error: null,
    selection: null,
    diff: null,
    selectedLineIds: [],
    dmode: "split",
  });
  useWorktrees.setState({ activePath: null });
});

afterEach(() => {
  vi.useRealTimers();
});

it("refresh populates both staged and unstaged lists", async () => {
  await useChanges.getState().refresh("/repos/main");
  expect(useChanges.getState()).toMatchObject({
    worktree: "/repos/main",
    entries: { staged: [stagedEntry], unstaged: [unstagedEntry] },
    loading: false,
    error: null,
  });
});

it("re-fetches after a debounced git:changed event for the tracked worktree", async () => {
  vi.useFakeTimers();
  await useChanges.getState().refresh("/repos/main");
  expect(readStatus).toHaveBeenCalledTimes(1);

  useChanges.getState().handleGitChanged("/repos/other"); // different worktree: ignored
  useChanges.getState().handleGitChanged("/repos/main");
  useChanges.getState().handleGitChanged("/repos/main"); // rapid second event collapses into one fetch
  expect(readStatus).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(250);
  expect(readStatus).toHaveBeenCalledTimes(2);
});

it("keeps the selection when the selected file is still present after refresh", async () => {
  vi.mocked(readDiff).mockResolvedValue({ hunks: [], binary: false, truncated: false, bytes: 0 });
  await useChanges.getState().refresh("/repos/main");
  useChanges.getState().select({ path: "a.ts", area: "staged" });
  await vi.waitFor(() => expect(useChanges.getState().diff).not.toBeNull());

  await useChanges.getState().refresh("/repos/main");
  expect(useChanges.getState().selection).toEqual({ path: "a.ts", area: "staged" });
});

it("resets the selection when the selected file no longer exists in either section", async () => {
  vi.mocked(readDiff).mockResolvedValue({ hunks: [], binary: false, truncated: false, bytes: 0 });
  await useChanges.getState().refresh("/repos/main");
  useChanges.getState().select({ path: "a.ts", area: "staged" });
  await vi.waitFor(() => expect(useChanges.getState().diff).not.toBeNull());

  vi.mocked(readStatus).mockResolvedValue(summary({ staged: [] }));
  await useChanges.getState().refresh("/repos/main");
  expect(useChanges.getState().selection).toBeNull();
  expect(useChanges.getState().diff).toBeNull();
});

it("keeps fresh entries and clears loading when select() runs during an in-flight refresh", async () => {
  let resolveStatus!: (value: StatusSummary) => void;
  vi.mocked(readStatus).mockImplementation(
    () => new Promise((resolve) => (resolveStatus = resolve)),
  );
  vi.mocked(readDiff).mockResolvedValue({ hunks: [], binary: false, truncated: false, bytes: 0 });

  const refreshDone = useChanges.getState().refresh("/repos/main"); // status fetch now in flight
  useChanges.getState().select({ path: "a.ts", area: "staged" }); // user clicks mid-refresh
  resolveStatus(summary({ unstaged: [unstagedEntry, { ...unstagedEntry, path: "new.ts" }] }));
  await refreshDone;

  expect(useChanges.getState().loading).toBe(false);
  expect(useChanges.getState().entries.unstaged.map((e) => e.path)).toEqual(["b.ts", "new.ts"]);
});

it("cancels a pending debounce timer on worktree switch so it never retargets the store", async () => {
  vi.useFakeTimers();
  useWorktrees.setState({ activePath: "/repos/a" });
  await useChanges.getState().refresh("/repos/a");
  useChanges.getState().handleGitChanged("/repos/a");

  useWorktrees.setState({ activePath: "/repos/b" }); // switch before the debounce fires
  await vi.advanceTimersByTimeAsync(250);

  expect(readStatus).toHaveBeenCalledTimes(1); // the stale timer never re-fetched "/repos/a"
  expect(useChanges.getState().worktree).toBe("/repos/b");
});

it("clears entries and selection when the active worktree changes in the worktrees store", async () => {
  vi.mocked(readDiff).mockResolvedValue({ hunks: [], binary: false, truncated: false, bytes: 0 });
  useWorktrees.setState({ activePath: "/repos/main" });
  await useChanges.getState().refresh("/repos/main");
  useChanges.getState().select({ path: "a.ts", area: "staged" });
  await vi.waitFor(() => expect(useChanges.getState().diff).not.toBeNull());

  useWorktrees.setState({ activePath: "/repos/other" }); // drive the switch through the real store
  expect(useChanges.getState()).toMatchObject({
    worktree: "/repos/other",
    entries: { staged: [], unstaged: [] },
    selection: null,
    diff: null,
  });
});

it("dispatch stages paths, refreshes, and toasts success", async () => {
  await useChanges.getState().refresh("/repos/main");
  vi.mocked(readStatus).mockClear();

  await useChanges.getState().dispatch({ type: "stage-paths", paths: ["b.ts"] });

  expect(stagePaths).toHaveBeenCalledWith("/repos/main", ["b.ts"]);
  expect(readStatus).toHaveBeenCalledWith("/repos/main");
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Stage complete", icon: "✓" }));
});

it("dispatch toasts failures without dropping the worktree", async () => {
  await useChanges.getState().refresh("/repos/main");
  vi.mocked(stagePaths).mockRejectedValueOnce({ kind: "Validation", message: "path escapes worktree" });

  await useChanges.getState().dispatch({ type: "stage-paths", paths: ["../x"] });

  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Couldn't stage: path escapes worktree", icon: "!" }),
  );
  expect(useChanges.getState().worktree).toBe("/repos/main");
});

it("dispatch stages selected lines and clears the selection afterward", async () => {
  await useChanges.getState().refresh("/repos/main");
  useChanges.setState({ selectedLineIds: ["0:1", "1:0"] });

  await useChanges.getState().dispatch({
    type: "stage-lines",
    path: "b.ts",
    lineIds: ["0:1", "1:0"],
    area: "unstaged",
  });

  expect(stageLines).toHaveBeenCalledWith("/repos/main", "b.ts", ["0:1", "1:0"], "unstaged");
  expect(useChanges.getState().selectedLineIds).toEqual([]);
});

it("dispatch commits with typed options, refreshes, and reports success", async () => {
  await useChanges.getState().refresh("/repos/main");
  vi.mocked(readStatus).mockClear();
  const options = { message: "feat: commit", amend: false, stageAll: false };

  const succeeded = await useChanges.getState().dispatch({ type: "commit", options });

  expect(succeeded).toBe(true);
  expect(commit).toHaveBeenCalledWith("/repos/main", options);
  expect(readStatus).toHaveBeenCalledWith("/repos/main");
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Commit complete", icon: "✓" }));
});

it("dispatch commits and pushes, and reports a failed push", async () => {
  await useChanges.getState().refresh("/repos/main");
  const options = { message: "feat: push", amend: false, stageAll: false };
  vi.mocked(commitAndPush).mockRejectedValueOnce({ kind: "GitAuth", message: "authentication required" });

  const succeeded = await useChanges.getState().dispatch({ type: "commit-and-push", options });

  expect(succeeded).toBe(false);
  expect(commitAndPush).toHaveBeenCalledWith("/repos/main", options);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Couldn't commit & push: authentication required",
      icon: "!",
    }),
  );
});

it("dispatch syncs without a message and labels the toast as Sync", async () => {
  await useChanges.getState().refresh("/repos/main");

  await useChanges.getState().dispatch({
    type: "commit-and-sync",
    options: { message: "", amend: false, stageAll: false },
  });

  expect(commitAndSync).toHaveBeenCalledWith("/repos/main", {
    message: "",
    amend: false,
    stageAll: false,
  });
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Sync complete" }));
});

it("refresh loads stashes for the tracked worktree", async () => {
  const stash = { index: 0, message: "On main: wip", time: 1, branch: "main" };
  vi.mocked(stashList).mockResolvedValue([stash]);

  await useChanges.getState().refresh("/repos/main");

  await vi.waitFor(() => expect(useChanges.getState().stashes).toEqual([stash]));
});

it("dispatch pushes a stash with options and refreshes", async () => {
  await useChanges.getState().refresh("/repos/main");
  vi.mocked(stashList).mockClear();

  const succeeded = await useChanges.getState().dispatch({
    type: "stash-push",
    options: { message: "wip", includeUntracked: true },
  });

  expect(succeeded).toBe(true);
  expect(stashPush).toHaveBeenCalledWith("/repos/main", {
    message: "wip",
    includeUntracked: true,
  });
  expect(stashList).toHaveBeenCalledWith("/repos/main");
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Stash complete" }));
});

it("dispatch applies and pops stashes by index", async () => {
  await useChanges.getState().refresh("/repos/main");

  await useChanges.getState().dispatch({ type: "stash-apply", index: 2 });
  await useChanges.getState().dispatch({ type: "stash-pop", index: 1 });

  expect(stashApply).toHaveBeenCalledWith("/repos/main", 2);
  expect(stashPop).toHaveBeenCalledWith("/repos/main", 1);
});

it("dispatch drop toasts an enabled Undo action and invokes undo_last", async () => {
  await useChanges.getState().refresh("/repos/main");
  vi.mocked(stashDrop).mockResolvedValue(true);

  await useChanges.getState().dispatch({ type: "stash-drop", index: 0 });

  expect(stashDrop).toHaveBeenCalledWith("/repos/main", 0);
  const dropped = vi
    .mocked(toast)
    .mock.calls.find(([entry]) => entry.title === "Stash dropped");
  expect(dropped).toBeDefined();
  expect(dropped![0].action?.label).toBe("Undo");
  expect(dropped![0].action?.enabled).toBe(true);

  dropped![0].action!.run();
  expect(undoLast).toHaveBeenCalledWith("/repos/main");
});
