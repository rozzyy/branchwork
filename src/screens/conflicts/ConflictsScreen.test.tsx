import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import {
  conflictAbort,
  conflictContinue,
  conflictList,
  conflictRead,
  conflictResolve,
  type ConflictFile,
  type ConflictList,
} from "../../ipc/conflicts";
import { useStage } from "../../state/stage";
import { useWorktrees } from "../../state/worktrees";
import { ask } from "../../ui/dialog";
import { useGitBusy } from "../../state/gitActions";
import { ConflictsToolbar, ConflictsView } from "./ConflictsScreen";
import { useConflicts } from "./conflictsState";

vi.mock("../../ipc/conflicts", () => ({
  conflictList: vi.fn(),
  conflictRead: vi.fn(),
  conflictResolve: vi.fn(),
  conflictAbort: vi.fn(),
  conflictContinue: vi.fn(),
}));
vi.mock("../../ui/dialog", () => ({ ask: vi.fn() }));

const WT = "/repos/main";
const list = (paths: { path: string; kind?: ConflictFile["kind"] }[], operation: ConflictList["operation"] = "merge"): ConflictList => ({
  operation,
  truncated: false,
  files: paths.map(({ path, kind }) => ({ path, kind: kind ?? "bothModified" })),
});
const textFile: ConflictFile = {
  path: "cart.ts",
  kind: "bothModified",
  summary: null,
  stamp: "b:o:t",
  regions: [
    { kind: "context", text: "head\n" },
    { kind: "conflict", index: 0, ours: "ours-1\n", base: "base-1\n", theirs: "theirs-1\n" },
    { kind: "context", text: "middle\n" },
    { kind: "conflict", index: 1, ours: "ours-2\n", base: "base-2\n", theirs: "theirs-2\n" },
  ],
};

async function setup(initial: ConflictList, file: ConflictFile = textFile) {
  vi.mocked(conflictList).mockResolvedValue(initial);
  vi.mocked(conflictRead).mockResolvedValue(file);
  act(() => {
    useWorktrees.setState({
      activePath: WT,
      worktrees: [{ path: WT, branch: "main", head: "h", ahead: 0, behind: 0, dirtyCount: 1, state: "conflict" }],
    });
  });
  await act(async () => { await useConflicts.getState().load(WT); });
  render(<><ConflictsToolbar /><ConflictsView /></>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useGitBusy.setState({ running: {} });
  useConflicts.setState({ worktree: null, list: null, selected: null, file: null, choices: {}, history: [], error: null });
  useStage.setState({ go: vi.fn() });
});

it("renders file tabs and the Ours / Result / Theirs columns", async () => {
  await setup(list([{ path: "cart.ts" }, { path: "discount.ts" }]));

  expect(screen.getByRole("tab", { name: /cart\.ts/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: /discount\.ts/ })).toBeInTheDocument();
  expect(screen.getByText("Ours")).toBeInTheDocument();
  expect(screen.getByText("Result")).toBeInTheDocument();
  expect(screen.getByText("Theirs")).toBeInTheDocument();
  expect(screen.getByRole("status", { name: "" })).toHaveTextContent("2 left");
  expect(screen.getByText("2 unresolved")).toBeInTheDocument();
});

it("chooses ours, theirs, both and manual text, and undo reverts the last choice", async () => {
  await setup(list([{ path: "cart.ts" }]));

  await userEvent.click(screen.getByRole("button", { name: "Use ours for conflict 1" }));
  expect(within(screen.getByTestId("result-0")).getByText("ours-1")).toBeInTheDocument();
  expect(screen.getByText("1 unresolved")).toBeInTheDocument();

  await userEvent.click(within(screen.getByTestId("result-0")).getByRole("button", { name: "Both" }));
  expect(within(screen.getByTestId("result-0")).getByText("theirs-1")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(within(screen.getByTestId("result-0")).queryByText("theirs-1")).not.toBeInTheDocument();
  expect(within(screen.getByTestId("result-0")).getByText("ours-1")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Use theirs for conflict 2" }));
  await userEvent.click(within(screen.getByTestId("result-1")).getByRole("button", { name: "Edit" }));
  const editor = screen.getByRole("textbox", { name: "Edit the result of conflict 2" });
  await userEvent.clear(editor);
  await userEvent.type(editor, "manual-2");
  await userEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(within(screen.getByTestId("result-1")).getByText("manual-2")).toBeInTheDocument();
  expect(screen.queryByText(/unresolved$/)).not.toBeInTheDocument();
});

it("saves the resolution with the stamp and ordered choices, then reloads", async () => {
  await setup(list([{ path: "cart.ts" }]));
  vi.mocked(conflictResolve).mockResolvedValue(undefined);
  const save = screen.getByRole("button", { name: "Save resolution" });
  expect(save).toBeDisabled();

  await userEvent.click(screen.getByRole("button", { name: "Use theirs for conflict 2" }));
  await userEvent.click(screen.getByRole("button", { name: "Use ours for conflict 1" }));
  vi.mocked(conflictList).mockResolvedValue(list([], "merge"));
  await userEvent.click(save);

  await waitFor(() =>
    expect(conflictResolve).toHaveBeenCalledWith(WT, "cart.ts", "b:o:t", {
      kind: "regions",
      choices: [{ kind: "ours" }, { kind: "theirs" }],
    }),
  );
  await waitFor(() => expect(screen.getByText("All conflicts are resolved")).toBeInTheDocument());
});

it("offers whole-file choices for summarized files, with Accept deletion when deleted", async () => {
  const deleted: ConflictFile = {
    path: "gone.txt",
    kind: "deletedByThem",
    summary: { reason: "deletedByThem", oursBytes: 12, theirsBytes: null },
    stamp: "b:o:-",
    regions: [],
  };
  await setup(list([{ path: "gone.txt", kind: "deletedByThem" }]), deleted);
  vi.mocked(conflictResolve).mockResolvedValue(undefined);

  expect(screen.getByText("Changed on this branch, deleted on the other")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use ours" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Use theirs" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Accept deletion" }));

  await waitFor(() =>
    expect(conflictResolve).toHaveBeenCalledWith(WT, "gone.txt", "b:o:-", { kind: "file", side: "delete" }),
  );
});

it("asks before aborting and aborts only on confirm", async () => {
  await setup(list([{ path: "cart.ts" }]));
  vi.mocked(conflictAbort).mockResolvedValue(undefined);

  vi.mocked(ask).mockResolvedValueOnce(null);
  await userEvent.click(screen.getByRole("button", { name: "Abort" }));
  expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: "Abort the merge?", danger: true }));
  expect(conflictAbort).not.toHaveBeenCalled();

  vi.mocked(ask).mockResolvedValueOnce(true);
  await userEvent.click(screen.getByRole("button", { name: "Abort" }));
  await waitFor(() => expect(conflictAbort).toHaveBeenCalledWith(WT));
});

it("enables Mark resolved & commit only when no files remain, then continues and opens Graph", async () => {
  await setup(list([{ path: "cart.ts" }]));
  expect(screen.getByRole("button", { name: "✓ Mark resolved & commit" })).toBeDisabled();

  vi.mocked(conflictList).mockResolvedValue(list([], "cherryPick"));
  vi.mocked(conflictContinue).mockResolvedValue(undefined);
  await act(async () => { await useConflicts.getState().load(WT); });
  const finish = screen.getByRole("button", { name: "✓ Mark resolved & commit" });
  expect(finish).toBeEnabled();
  await userEvent.click(finish);

  await waitFor(() => expect(conflictContinue).toHaveBeenCalledWith(WT));
  await waitFor(() => expect(useStage.getState().go).toHaveBeenCalledWith("history"));
});

// Regression: any failed save re-read the file and wiped the user's choices.
it("keeps choices after a failed save and re-reads only on a stale stamp", async () => {
  await setup(list([{ path: "cart.ts" }]));
  await userEvent.click(screen.getByRole("button", { name: "Use ours for conflict 1" }));
  await userEvent.click(screen.getByRole("button", { name: "Use theirs for conflict 2" }));

  vi.mocked(conflictResolve).mockRejectedValueOnce({ kind: "io", message: "disk full", detail: null, recoverable: false });
  await userEvent.click(screen.getByRole("button", { name: "Save resolution" }));
  await waitFor(() => expect(conflictResolve).toHaveBeenCalledTimes(1));
  expect(conflictRead).toHaveBeenCalledTimes(1);
  expect(within(screen.getByTestId("result-0")).getByText("ours-1")).toBeInTheDocument();

  vi.mocked(conflictResolve).mockRejectedValueOnce({ kind: "conflict", message: "changed", detail: null, recoverable: true });
  await userEvent.click(screen.getByRole("button", { name: "Save resolution" }));
  await waitFor(() => expect(conflictRead).toHaveBeenCalledTimes(2));
});
