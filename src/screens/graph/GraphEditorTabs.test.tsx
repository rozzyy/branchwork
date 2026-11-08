import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { DiffModel } from "../../ipc/bindings";
import { readDiff } from "../../ipc/diff";
import { readGraphCommitFileDiff } from "../../ipc/graph";
import { useChanges } from "../../state/changes";
import { GraphEditorTabs } from "./GraphEditorTabs";

vi.mock("../../ipc/diff", () => ({ readDiff: vi.fn() }));
vi.mock("../../ipc/graph", () => ({ readGraphCommitFileDiff: vi.fn() }));

const diff: DiffModel = {
  hunks: [{
    oldStart: 1,
    newStart: 1,
    oldLines: 1,
    newLines: 1,
    lines: [
      { kind: "del", old: 1, new: null, text: "old value" },
      { kind: "add", old: null, new: 1, text: "new value" },
    ],
  }],
  binary: false,
  truncated: false,
  bytes: 20,
};

const initialChanges = useChanges.getState();
const dispatch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readDiff).mockResolvedValue(diff);
  vi.mocked(readGraphCommitFileDiff).mockResolvedValue(diff);
  dispatch.mockResolvedValue(true);
  useChanges.setState({
    ...initialChanges,
    worktree: null,
    entries: { staged: [], unstaged: [] },
    stashes: [],
    loading: false,
    error: null,
    selection: null,
    diff: null,
    selectedLineIds: [],
    dispatch,
  });
});

function editor(worktreePath: string) {
  return (
    <GraphEditorTabs
      key={worktreePath}
      projectId="project-1"
      worktreePath={worktreePath}
      renderInspector={(openDiff, openCommitDiff) => (
        <div>
          <button onClick={() => openDiff("src/app.ts", "staged")}>Open staged file</button>
          <button onClick={() => openDiff("src/app.ts", "unstaged")}>Open unstaged file</button>
          <button onClick={() => openDiff("src/edited.ts", "unstaged")}>Open edited file</button>
          <button onClick={() => openCommitDiff("abc123", "src/app.ts")}>Open commit file</button>
          <button onClick={() => openCommitDiff("def456", "src/app.ts")}>Open second commit file</button>
        </div>
      )}
    >
      {() => <div>Graph list</div>}
    </GraphEditorTabs>
  );
}

it("opens distinct staged and unstaged tabs, switches between them, and closes them", async () => {
  render(editor("/repos/main"));

  await userEvent.click(screen.getByRole("button", { name: "Open staged file" }));
  const stagedTab = await screen.findByRole("tab", { name: "src/app.ts (Staged diff)" });
  expect(stagedTab).toHaveAttribute("aria-selected", "true");
  expect(readDiff).toHaveBeenLastCalledWith("/repos/main", "src/app.ts", "staged");

  await userEvent.click(screen.getByRole("button", { name: "Open unstaged file" }));
  const unstagedTab = await screen.findByRole("tab", { name: "src/app.ts (Unstaged diff)" });
  expect(unstagedTab).toHaveAttribute("aria-selected", "true");
  expect(readDiff).toHaveBeenLastCalledWith("/repos/main", "src/app.ts", "unstaged");

  await userEvent.click(stagedTab);
  await waitFor(() => expect(readDiff).toHaveBeenLastCalledWith("/repos/main", "src/app.ts", "staged"));
  await userEvent.click(screen.getByRole("button", { name: "Close staged diff for src/app.ts" }));

  expect(screen.queryByRole("tab", { name: "src/app.ts (Staged diff)" })).not.toBeInTheDocument();
  expect(unstagedTab).toHaveAttribute("aria-selected", "true");
  await waitFor(() => expect(readDiff).toHaveBeenLastCalledWith("/repos/main", "src/app.ts", "unstaged"));

  await userEvent.click(screen.getByRole("button", { name: "Close unstaged diff for src/app.ts" }));
  expect(screen.getByRole("tab", { name: "Graph" })).toHaveAttribute("aria-selected", "true");
});

it("dispatches a diff hunk action and resets tabs when worktree changes", async () => {
  const { rerender } = render(editor("/repos/main"));
  await userEvent.click(screen.getByRole("button", { name: "Open edited file" }));
  await screen.findByText(/new value/);
  fireEvent.click(screen.getByRole("button", { name: "＋ Stage hunk" }));
  await waitFor(() => {
    expect(dispatch).toHaveBeenCalledWith({
      type: "stage-hunks",
      path: "src/edited.ts",
      hunkIndices: [0],
      area: "unstaged",
    });
  });

  rerender(editor("/repos/feature"));
  expect(screen.queryByRole("tab", { name: "src/edited.ts (Unstaged diff)" })).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Graph" })).toHaveAttribute("aria-selected", "true");
});

it("keeps historical diff tabs commit-specific, read-only, and alongside WIP tabs", async () => {
  render(editor("/repos/main"));

  await userEvent.click(screen.getByRole("button", { name: "Open staged file" }));
  const stagedTab = await screen.findByRole("tab", { name: "src/app.ts (Staged diff)" });
  await userEvent.click(screen.getByRole("button", { name: "Open commit file" }));
  await screen.findByRole("tab", { name: "src/app.ts (Commit abc123 diff)" });
  expect(readGraphCommitFileDiff).toHaveBeenLastCalledWith(
    "project-1",
    "/repos/main",
    "abc123",
    "src/app.ts",
  );
  expect(screen.queryByRole("button", { name: "＋ Stage hunk" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Stage selected lines" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Open second commit file" }));
  const commitTabs = screen.getAllByRole("tab", { name: /src\/app\.ts \(Commit .* diff\)/ });
  expect(commitTabs).toHaveLength(2);
  expect(readGraphCommitFileDiff).toHaveBeenLastCalledWith(
    "project-1",
    "/repos/main",
    "def456",
    "src/app.ts",
  );
  await userEvent.click(commitTabs[0]);
  expect(readGraphCommitFileDiff).toHaveBeenLastCalledWith(
    "project-1",
    "/repos/main",
    "abc123",
    "src/app.ts",
  );

  await userEvent.click(screen.getAllByRole("button", { name: "Close commit abc123 diff for src/app.ts" })[0]);
  expect(screen.getAllByRole("tab", { name: /src\/app\.ts \(Commit .* diff\)/ })).toHaveLength(1);
  expect(stagedTab).toBeInTheDocument();
});
