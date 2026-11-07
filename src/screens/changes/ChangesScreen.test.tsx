import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { readDiff } from "../../ipc/diff";
import { readStatus, type StatusSummary } from "../../ipc/status";
import {
  commit,
  commitAndPush,
  commitAndSync,
  discardPaths,
  stagePaths,
  unstagePaths,
} from "../../ipc/changes";
import {
  stashApply,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
  type StashEntry,
} from "../../ipc/stash";
import { t } from "../../i18n/t";
import { useStage } from "../../state/stage";
import { useWorktrees } from "../../state/worktrees";
import { useChanges } from "../../state/changes";
import { toast } from "../../ui/toast";
import { ChangesView } from "./ChangesScreen";

vi.mock("../../ipc/status", () => ({ readStatus: vi.fn() }));
vi.mock("../../ipc/diff", () => ({ readDiff: vi.fn() }));
vi.mock("../../ipc/changes", () => ({
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
vi.mock("../../ipc/stash", () => ({
  stashList: vi.fn(),
  stashPush: vi.fn(),
  stashApply: vi.fn(),
  stashPop: vi.fn(),
  stashDrop: vi.fn(),
}));
vi.mock("../../ui/toast", () => ({ toast: vi.fn() }));

const modified = { path: "src/auth/callback.ts", oldPath: null, indexStatus: "", worktreeStatus: "M", bytes: 1, large: false };
const deleted = { path: "src/auth/old.ts", oldPath: null, indexStatus: "", worktreeStatus: "D", bytes: 1, large: false };
const staged = { path: "src/staged.ts", oldPath: null, indexStatus: "A", worktreeStatus: "", bytes: 1, large: false };

function statusSummary(overrides: Partial<StatusSummary> = {}): StatusSummary {
  return { staged: [staged], unstaged: [modified, deleted], ...overrides };
}

async function setup(summary = statusSummary(), stashes: StashEntry[] = []) {
  vi.mocked(readStatus).mockResolvedValue(summary);
  vi.mocked(readDiff).mockResolvedValue({ hunks: [], binary: false, truncated: false, bytes: 0 });
  vi.mocked(commit).mockResolvedValue(undefined);
  vi.mocked(commitAndPush).mockResolvedValue(undefined);
  vi.mocked(commitAndSync).mockResolvedValue(undefined);
  vi.mocked(stagePaths).mockResolvedValue(undefined);
  vi.mocked(unstagePaths).mockResolvedValue(undefined);
  vi.mocked(discardPaths).mockResolvedValue(undefined);
  vi.mocked(stashList).mockResolvedValue(stashes);
  vi.mocked(stashPush).mockResolvedValue(undefined);
  vi.mocked(stashApply).mockResolvedValue(undefined);
  vi.mocked(stashPop).mockResolvedValue(undefined);
  vi.mocked(stashDrop).mockResolvedValue(undefined);
  act(() => {
    useWorktrees.setState({
      activePath: "/repos/main",
      worktrees: [{ path: "/repos/main", branch: "main", head: "head", ahead: 2, behind: 0, dirtyCount: 2, state: "dirty" }],
    });
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
    useStage.setState({ go: vi.fn() });
  });
  render(<ChangesView />);
  await screen.findByText("callback.ts");
}

beforeEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

afterEach(() => {
  act(() => useWorktrees.setState({ activePath: null }));
});

it("switches between list and tree layouts", async () => {
  await setup();
  const toggle = screen.getByRole("button", { name: "Tree view" });
  expect(screen.getAllByText("src/auth", { selector: ".changes-file-dir" })).toHaveLength(2);

  await userEvent.click(toggle);
  expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText(/src\/auth/, { selector: ".changes-tree-directory" })).toBeVisible();
  expect(screen.queryByText("src/auth", { selector: ".changes-file-dir" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "List view" }));
  expect(screen.getAllByText("src/auth", { selector: ".changes-file-dir" })).toHaveLength(2);
});

it("colors the first-line commit counter at 50, 51, 72, and 73 characters", async () => {
  await setup();
  const input = screen.getByPlaceholderText('Message (⌘↵ to commit in "main")');

  for (const [length, color] of [
    [50, "var(--fg3)"],
    [51, "var(--yel)"],
    [72, "var(--yel)"],
    [73, "var(--red)"],
  ] as const) {
    fireEvent.change(input, { target: { value: "x".repeat(length) } });
    expect(screen.getByText(`${length}/72`).style.color).toBe(color);
  }
});

it("renders status classes and strikes through deleted paths", async () => {
  await setup();
  expect(screen.getByText("callback.ts")).toHaveClass("changes-status-M");
  expect(screen.getByText("old.ts")).toHaveClass("changes-status-D", "changes-file-deleted");
  expect(screen.getByText("D", { selector: ".changes-file-status" })).toHaveClass("changes-status-D");
});

it("opens a file through the files.open intent when a row is double-clicked", async () => {
  await setup();
  const onIntent = vi.fn();
  window.addEventListener("branchwork:files-intent", onIntent);

  fireEvent.doubleClick(screen.getByText("callback.ts"));

  await waitFor(() => {
    expect(onIntent).toHaveBeenCalledOnce();
    expect((onIntent.mock.calls[0][0] as CustomEvent).detail).toEqual({ type: "files.open", path: "src/auth/callback.ts" });
    expect(useStage.getState().go).toHaveBeenCalledWith("files");
  });
  window.removeEventListener("branchwork:files-intent", onIntent);
});

it("lists all six commit actions in the split-button menu", async () => {
  await setup();
  await userEvent.click(screen.getByRole("button", { name: "Commit options" }));

  const menu = screen.getByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
    "✓Commit⌘↵",
    "✓Commit (Amend)",
    "↑Commit & Push",
    "⟳Commit & Sync",
    "⊕Commit All",
    "↶Undo Last Commit⌘Z",
  ]);
});

it("commits the typed message with the primary split-button action", async () => {
  await setup();
  const input = screen.getByPlaceholderText('Message (⌘↵ to commit in "main")');
  await userEvent.type(input, "feat: commit");

  await userEvent.click(screen.getByRole("button", { name: "✓ Commit" }));

  await waitFor(() =>
    expect(commit).toHaveBeenCalledWith("/repos/main", {
      message: "feat: commit",
      amend: false,
      stageAll: false,
    }),
  );
  await waitFor(() => expect(input).toHaveValue(""));
});

it("commits all files from the split-button menu", async () => {
  await setup();
  const input = screen.getByPlaceholderText('Message (⌘↵ to commit in "main")');
  await userEvent.type(input, "feat: everything");

  await userEvent.click(screen.getByRole("button", { name: "Commit options" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Commit All/ }));

  await waitFor(() =>
    expect(commit).toHaveBeenCalledWith("/repos/main", {
      message: "feat: everything",
      amend: false,
      stageAll: true,
    }),
  );
});

it("commits and pushes from the split-button menu", async () => {
  await setup();
  const input = screen.getByPlaceholderText('Message (⌘↵ to commit in "main")');
  await userEvent.type(input, "feat: push");

  await userEvent.click(screen.getByRole("button", { name: "Commit options" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Commit & Push/ }));

  await waitFor(() =>
    expect(commitAndPush).toHaveBeenCalledWith("/repos/main", {
      message: "feat: push",
      amend: false,
      stageAll: false,
    }),
  );
});

it("commits on ⌘↵ from the message box", async () => {
  await setup();
  const input = screen.getByPlaceholderText('Message (⌘↵ to commit in "main")');
  await userEvent.type(input, "feat: keyboard");

  fireEvent.keyDown(input, { key: "Enter", metaKey: true });

  await waitFor(() =>
    expect(commit).toHaveBeenCalledWith("/repos/main", {
      message: "feat: keyboard",
      amend: false,
      stageAll: false,
    }),
  );
});

it("syncs without a new message from the branch line and keeps the draft", async () => {
  await setup();
  const input = screen.getByPlaceholderText('Message (⌘↵ to commit in "main")');
  await userEvent.type(input, "draft message");

  await userEvent.click(screen.getByRole("button", { name: "⟳ Sync" }));

  await waitFor(() =>
    expect(commitAndSync).toHaveBeenCalledWith("/repos/main", {
      message: "",
      amend: false,
      stageAll: false,
    }),
  );
  expect(input).toHaveValue("draft message");
});

it("renders the disabled Generate button with the deferred tooltip", async () => {
  await setup();
  const generate = screen.getByRole("button", { name: "Generate commit message" });
  expect(generate).toBeDisabled();
  expect(generate).toHaveAttribute("title", t("ui.deferred_m6"));
});

it("shows an empty stash count chip", async () => {
  await setup();
  const stashes = screen.getByRole("button", { name: /Stashes/ });
  expect(within(stashes).getByText("0")).toBeVisible();
});

it("stages, unstages, and discards from file-row hover actions", async () => {
  await setup();

  const unstagedRow = screen.getByText("callback.ts").closest(".changes-file-row");
  expect(unstagedRow).not.toBeNull();
  await userEvent.click(within(unstagedRow as HTMLElement).getByRole("button", { name: "Stage" }));
  await waitFor(() => expect(stagePaths).toHaveBeenCalledWith("/repos/main", ["src/auth/callback.ts"]));
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Stage complete" }));

  const stagedRow = screen.getByText("staged.ts").closest(".changes-file-row");
  expect(stagedRow).not.toBeNull();
  await userEvent.click(within(stagedRow as HTMLElement).getByRole("button", { name: "Unstage" }));
  await waitFor(() => expect(unstagePaths).toHaveBeenCalledWith("/repos/main", ["src/staged.ts"]));

  await userEvent.click(within(unstagedRow as HTMLElement).getByRole("button", { name: "Discard changes" }));
  await waitFor(() =>
    expect(discardPaths).toHaveBeenCalledWith("/repos/main", ["src/auth/callback.ts"], false),
  );
});

it("renders stashes with the count chip", async () => {
  const entries: StashEntry[] = [
    { index: 0, message: "On main: wip", time: 2, branch: "main" },
    { index: 1, message: "WIP on main: older", time: 1, branch: "main" },
  ];
  await setup(undefined, entries);

  const stashes = screen.getByRole("button", { name: /Stashes/ });
  expect(within(stashes).getByText("2")).toBeVisible();
  expect(screen.getByText("stash@{0}")).toBeVisible();
  expect(screen.getByText("On main: wip")).toBeVisible();
  expect(screen.getByText("stash@{1}")).toBeVisible();
});

it("applies, pops, and drops stashes from row actions", async () => {
  await setup(undefined, [{ index: 0, message: "On main: wip", time: 1, branch: "main" }]);
  const row = screen.getByText("stash@{0}").closest(".changes-stash-row");
  expect(row).not.toBeNull();

  await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Apply stash" }));
  await waitFor(() => expect(stashApply).toHaveBeenCalledWith("/repos/main", 0));

  await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Pop stash" }));
  await waitFor(() => expect(stashPop).toHaveBeenCalledWith("/repos/main", 0));

  await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Drop stash" }));
  await waitFor(() => expect(stashDrop).toHaveBeenCalledWith("/repos/main", 0));
});

it("stashes all changes from the Changes ⋯ menu", async () => {
  await setup();
  await userEvent.click(screen.getByRole("button", { name: "More" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Stash all changes/ }));

  await waitFor(() =>
    expect(stashPush).toHaveBeenCalledWith("/repos/main", { includeUntracked: true }),
  );
});
