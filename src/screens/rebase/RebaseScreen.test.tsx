import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import {
  gitPushForceWithLease,
  rebaseAbort,
  rebaseContinue,
  rebaseInteractive,
  rebasePlan,
  type RebasePlan,
} from "../../ipc/rebase";
import { useGitBusy } from "../../state/gitActions";
import { useStage } from "../../state/stage";
import { useWorktrees } from "../../state/worktrees";
import { ask } from "../../ui/dialog";
import { useConflicts } from "../conflicts/conflictsState";
import { conflictList } from "../../ipc/conflicts";
import { RebaseView } from "./RebaseScreen";
import { autoSquash, rowsFromPlan, useRebaseUi } from "./rebaseState";

vi.mock("../../ipc/rebase", () => ({
  rebasePlan: vi.fn(),
  rebaseInteractive: vi.fn(),
  rebaseContinue: vi.fn(),
  rebaseAbort: vi.fn(),
  gitPushForceWithLease: vi.fn(),
  onRebaseProgress: vi.fn(async () => () => {}),
}));
vi.mock("../conflicts/conflictsState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conflicts/conflictsState")>();
  return actual;
});
vi.mock("../../ipc/conflicts", () => ({ conflictList: vi.fn(async () => ({ operation: "none", truncated: false, files: [] })), conflictRead: vi.fn() }));
vi.mock("../../ui/dialog", () => ({ ask: vi.fn() }));

const WT = "/repos/main";
const BASE = "b".repeat(40);
const commit = (n: number, subject: string, isMerge = false) => ({
  sha: String(n).repeat(40),
  shortSha: String(n).repeat(7),
  subject,
  authorName: "Me",
  authorEmail: "me@example.com",
  timestamp: 0,
  isMerge,
});
const plan = (overrides: Partial<RebasePlan> = {}): RebasePlan => ({
  branch: "main",
  base: BASE,
  commits: [commit(1, "add a"), commit(2, "add b"), commit(3, "fixup! add a")],
  truncated: false,
  pushed: false,
  ...overrides,
});

async function setup(loaded = plan()) {
  vi.mocked(rebasePlan).mockResolvedValue(loaded);
  act(() => {
    useWorktrees.setState({ activePath: WT, worktrees: [{ path: WT, branch: "main", head: "h", ahead: 0, behind: 0, dirtyCount: 0, state: "clean" }] });
    useRebaseUi.setState({ base: { worktree: WT, sha: BASE }, pushed: {}, needsLeasePush: {} });
  });
  render(<RebaseView />);
  await screen.findByRole("listitem", { name: "add a" });
}

const rowNames = () => screen.getAllByRole("listitem").filter((item) => item.classList.contains("rebase-row")).map((item) => item.getAttribute("aria-label"));

beforeEach(() => {
  vi.clearAllMocks();
  useGitBusy.setState({ running: {} });
  useConflicts.setState({ worktree: WT, list: { operation: "none", truncated: false, files: [] }, selected: null, file: null, choices: {}, history: [], error: null });
  useStage.setState({ go: vi.fn() });
});

it("renders the plan oldest first and edits actions and reword messages", async () => {
  await setup();
  expect(rebasePlan).toHaveBeenCalledWith(WT, BASE);
  expect(rowNames()).toEqual(["add a", "add b", "fixup! add a"]);

  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Action for 2222222" }), "reword");
  const message = screen.getByRole("textbox", { name: "New message for 2222222" });
  await userEvent.clear(message);
  await userEvent.type(message, "B reworded");
  expect(within(screen.getByRole("complementary", { name: "Rebase summary" })).getByText("B reworded")).toBeInTheDocument();
});

it("reorders with Move up / Move down and auto-squashes fixup! commits", async () => {
  await setup();
  await userEvent.click(screen.getByRole("button", { name: "Move 2222222 up" }));
  expect(rowNames()).toEqual(["add b", "add a", "fixup! add a"]);

  const squashed = autoSquash(rowsFromPlan(plan({ commits: [commit(1, "add a"), commit(2, "add b"), commit(3, "fixup! add a")] })));
  expect(squashed.map((row) => [row.subject, row.action])).toEqual([["add a", "pick"], ["fixup! add a", "fixup"], ["add b", "pick"]]);
  await userEvent.click(screen.getByRole("button", { name: "Auto-squash fixup!/squash!" }));
  expect(rowNames()).toEqual(["add b", "add a", "fixup! add a"]);
  expect(screen.getByText("2 of 3 commits")).toBeInTheDocument();

  // Regression (review): a fixup without a target stays in place, nested prefixes resolve to the
  // innermost subject, and a dropped row stays dropped.
  const edge = autoSquash(rowsFromPlan(plan({ commits: [commit(1, "fixup! gone"), commit(2, "add a"), commit(3, "add b"), commit(4, "squash! fixup! add a")] })));
  expect(edge.map((row) => [row.subject, row.action])).toEqual([["fixup! gone", "pick"], ["add a", "pick"], ["squash! fixup! add a", "squash"], ["add b", "pick"]]);
  const dropped = rowsFromPlan(plan()).map((row) => (row.subject === "fixup! add a" ? { ...row, action: "drop" as const } : row));
  expect(autoSquash(dropped).map((row) => [row.subject, row.action])).toEqual([["add a", "pick"], ["add b", "pick"], ["fixup! add a", "drop"]]);
});

it("starts with the ordered steps", async () => {
  vi.mocked(rebaseInteractive).mockResolvedValue({ status: "done", backupRef: "refs/branchwork/backup/main/1", undoable: true });
  await setup();
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Action for 3333333" }), "drop");

  await userEvent.click(screen.getByRole("button", { name: "Start rebase" }));

  await waitFor(() =>
    expect(rebaseInteractive).toHaveBeenCalledWith(WT, {
      base: BASE,
      steps: [
        { sha: "1".repeat(40), action: { kind: "pick" } },
        { sha: "2".repeat(40), action: { kind: "pick" } },
        { sha: "3".repeat(40), action: { kind: "drop" } },
      ],
    }),
  );
});

it("disables Start for a merge or truncated plan and for a first squash", async () => {
  await setup(plan({ commits: [commit(1, "add a"), commit(2, "merge", true)] }));
  expect(screen.getByRole("button", { name: "Start rebase" })).toBeDisabled();
  expect(screen.getByText("The range contains a merge commit; rebasing merges isn't supported here.")).toBeInTheDocument();
});

it("disables Start for a truncated plan", async () => {
  await setup(plan({ truncated: true }));
  expect(screen.getByRole("button", { name: "Start rebase" })).toBeDisabled();
  expect(rebaseInteractive).not.toHaveBeenCalled();
});

it("refuses a first squash and warns about a pushed branch", async () => {
  await setup(plan({ pushed: true }));
  expect(screen.getByRole("note")).toHaveTextContent("already pushed");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Action for 1111111" }), "squash");
  expect(screen.getByRole("button", { name: "Start rebase" })).toBeDisabled();
});

it("offers a confirmed force-with-lease push after rebasing a pushed branch", async () => {
  vi.mocked(rebaseInteractive).mockResolvedValue({ status: "done", backupRef: "r", undoable: true });
  vi.mocked(gitPushForceWithLease).mockResolvedValue(undefined);
  await setup(plan({ pushed: true }));
  await userEvent.click(screen.getByRole("button", { name: "Start rebase" }));

  const push = await screen.findByRole("button", { name: "Push with --force-with-lease" });
  vi.mocked(ask).mockResolvedValueOnce(null);
  await userEvent.click(push);
  expect(gitPushForceWithLease).not.toHaveBeenCalled();
  vi.mocked(ask).mockResolvedValueOnce(true);
  await userEvent.click(push);
  await waitFor(() => expect(gitPushForceWithLease).toHaveBeenCalledWith(WT));
  expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ danger: true }));
  // The base is cleared, so the old plan isn't shown again.
  expect(await screen.findByText("Pick a commit in Graph and choose Rebase from here.")).toBeInTheDocument();
});

it("runs Start → conflict → in-progress panel → Continue → done with the lease offer", async () => {
  vi.mocked(rebaseInteractive).mockResolvedValue({ status: "conflict", backupRef: "r", undoable: true });
  vi.mocked(rebaseContinue).mockResolvedValue({ status: "done", backupRef: null, undoable: false });
  vi.mocked(conflictList).mockResolvedValueOnce({ operation: "rebase", truncated: false, files: [] });
  await setup(plan({ pushed: true }));

  await userEvent.click(screen.getByRole("button", { name: "Start rebase" }));
  const continueButton = await screen.findByRole("button", { name: "Continue rebase" });
  expect(screen.getByRole("button", { name: "Abort rebase" })).toBeEnabled();

  vi.mocked(conflictList).mockResolvedValueOnce({ operation: "none", truncated: false, files: [] });
  await userEvent.click(continueButton);
  await waitFor(() => expect(rebaseContinue).toHaveBeenCalledWith(WT));
  expect(await screen.findByRole("button", { name: "Push with --force-with-lease" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Start rebase" })).not.toBeInTheDocument();
});

it("shows Continue and a confirmed Abort while a rebase is in progress", async () => {
  vi.mocked(rebaseContinue).mockResolvedValue({ status: "done", backupRef: null, undoable: false });
  vi.mocked(rebaseAbort).mockResolvedValue(undefined);
  // The reload after Continue still reports the rebase (e.g. it stopped again).
  vi.mocked(conflictList).mockResolvedValue({ operation: "rebase", truncated: false, files: [] });
  act(() => {
    useWorktrees.setState({ activePath: WT, worktrees: [] });
    useConflicts.setState({ worktree: WT, list: { operation: "rebase", truncated: false, files: [] } });
  });
  render(<RebaseView />);

  await userEvent.click(screen.getByRole("button", { name: "Continue rebase" }));
  await waitFor(() => expect(rebaseContinue).toHaveBeenCalledWith(WT));
  vi.mocked(ask).mockResolvedValueOnce(true);
  await userEvent.click(screen.getByRole("button", { name: "Abort rebase" }));
  await waitFor(() => expect(rebaseAbort).toHaveBeenCalledWith(WT));
});
