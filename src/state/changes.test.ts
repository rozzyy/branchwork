import { readStatus, type StatusSummary } from "../ipc/status";
import { readDiff } from "../ipc/diff";
import { useChanges } from "./changes";
import { useWorktrees } from "./worktrees";

vi.mock("../ipc/status", () => ({ readStatus: vi.fn() }));
vi.mock("../ipc/diff", () => ({ readDiff: vi.fn() }));

const stagedEntry = { path: "a.ts", oldPath: null, indexStatus: "M", worktreeStatus: "", bytes: 1, large: false };
const unstagedEntry = { path: "b.ts", oldPath: null, indexStatus: "", worktreeStatus: "M", bytes: 2, large: false };

function summary(overrides: Partial<StatusSummary> = {}): StatusSummary {
  return { staged: [stagedEntry], unstaged: [unstagedEntry], ...overrides };
}

beforeEach(() => {
  vi.mocked(readStatus).mockReset().mockResolvedValue(summary());
  vi.mocked(readDiff).mockReset();
  useChanges.setState({
    worktree: null,
    entries: { staged: [], unstaged: [] },
    loading: false,
    error: null,
    selection: null,
    diff: null,
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
