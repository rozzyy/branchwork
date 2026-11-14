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
import { useFiles } from "../../state/files";
import { toast } from "../../ui/toast";
import { gitFetch, gitPull, gitPush } from "../../ipc/sync";
import { gitCheckout } from "../../ipc/gitops";
import { useDialog } from "../../ui/dialog";
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
vi.mock("../../ipc/sync", () => ({ gitFetch: vi.fn(), gitPull: vi.fn(), gitPush: vi.fn() }));
vi.mock("../../ipc/gitops", () => ({ gitCheckout: vi.fn() }));

const modified = { path: "src/auth/callback.ts", oldPath: null, indexStatus: "", worktreeStatus: "M", bytes: 1, large: false };
const deleted = { path: "src/auth/old.ts", oldPath: null, indexStatus: "", worktreeStatus: "D", bytes: 1, large: false };
const staged = { path: "src/staged.ts", oldPath: null, indexStatus: "A", worktreeStatus: "", bytes: 1, large: false };

function statusSummary(overrides: Partial<StatusSummary> = {}): StatusSummary {
  return { staged: [staged], unstaged: [modified, deleted], ...overrides };
}

async function setup(summary = statusSummary(), stashes: StashEntry[] = [], expectClean = false) {
  vi.mocked(readStatus).mockResolvedValue(summary);
  vi.mocked(readDiff).mockResolvedValue({ hunks: [], binary: false, truncated: false, bytes: 0 });
  vi.mocked(commit).mockResolvedValue(false);
  vi.mocked(commitAndPush).mockResolvedValue(false);
  vi.mocked(commitAndSync).mockResolvedValue(false);
  vi.mocked(stagePaths).mockResolvedValue(undefined);
  vi.mocked(unstagePaths).mockResolvedValue(undefined);
  vi.mocked(discardPaths).mockResolvedValue(false);
  vi.mocked(stashList).mockResolvedValue(stashes);
  vi.mocked(stashPush).mockResolvedValue(undefined);
  vi.mocked(stashApply).mockResolvedValue(undefined);
  vi.mocked(stashPop).mockResolvedValue(undefined);
  vi.mocked(stashDrop).mockResolvedValue(false);
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
  if (expectClean) await screen.findByRole("button", { name: "Open History" });
  else await screen.findByText("callback.ts");
}

beforeEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("offers History when the working tree is clean", async () => {
  await setup({ staged: [], unstaged: [] }, [], true);
  await userEvent.click(screen.getByRole("button", { name: "Open History" }));
  expect(useStage.getState().go).toHaveBeenCalledWith("history");
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

it("shows loading feedback while the active worktree is being resolved", () => {
  act(() => useWorktrees.setState({ activePath: null, loading: true }));
  render(<ChangesView />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading changes…");
  act(() => useWorktrees.setState({ loading: false }));
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

it("opens the file in the Files store and navigates when a row is double-clicked", async () => {
  await setup();
  act(() => useFiles.setState({ open: [], current: null }));

  fireEvent.doubleClick(screen.getByText("callback.ts"));

  await waitFor(() => {
    expect(useFiles.getState().open).toContain("src/auth/callback.ts");
    expect(useFiles.getState().current).toBe("src/auth/callback.ts");
    expect(useStage.getState().go).toHaveBeenCalledWith("files");
  });
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
  expect(generate).toHaveAttribute("title", t("ui.deferred_m7"));
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
    expect(discardPaths).toHaveBeenCalledWith("/repos/main", ["src/auth/callback.ts"], true),
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

it("runs pull, push, fetch, and pop latest stash from the Changes ⋯ menu", async () => {
  await setup(statusSummary(), [{ index: 0, message: "WIP", time: 0, branch: "main" }]);
  vi.mocked(gitPull).mockResolvedValue(false);
  vi.mocked(gitPush).mockResolvedValue(undefined);
  vi.mocked(gitFetch).mockResolvedValue(undefined);
  await waitFor(() => expect(useChanges.getState().stashes).toHaveLength(1));

  for (const [name, command] of [["Pull", gitPull], ["Push", gitPush], ["Fetch", gitFetch]] as const) {
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: new RegExp(`^\\W*${name}$`) }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("/repos/main"));
  }
  await userEvent.click(screen.getByRole("button", { name: "More" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Pop latest stash/ }));
  await waitFor(() => expect(stashPop).toHaveBeenCalledWith("/repos/main", 0));
});

it("checks out a branch from the Changes ⋯ Checkout… prompt", async () => {
  await setup();
  vi.mocked(gitCheckout).mockResolvedValue(true);
  await userEvent.click(screen.getByRole("button", { name: "More" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Checkout…/ }));

  expect(useDialog.getState().current?.title).toBe("Check out branch");
  act(() => useDialog.getState().current?.resolve("feature/login"));

  await waitFor(() =>
    expect(gitCheckout).toHaveBeenCalledWith("/repos/main", { kind: "branch", name: "feature/login" }),
  );
});

it("renders Staged Changes section with count 0 when no files are staged", async () => {
  await setup(statusSummary({ staged: [] }));
  const stagedSection = screen.getByRole("button", { name: /Staged Changes/i });
  expect(within(stagedSection).getByText("0")).toBeVisible();
});

it("stages all unstaged files from Changes section header action", async () => {
  await setup();
  const stageAllButton = screen.getByRole("button", { name: "Stage all" });
  await userEvent.click(stageAllButton);
  await waitFor(() =>
    expect(stagePaths).toHaveBeenCalledWith("/repos/main", [
      "src/auth/callback.ts",
      "src/auth/old.ts",
    ]),
  );
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Stage complete" }));
});
