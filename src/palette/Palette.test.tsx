import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Palette } from "./Palette";
import { usePalette } from "./store";
import { useStage } from "../state/stage";
import { initialStage } from "../stage/stageModel";
import { useToasts } from "../ui/toast";
import { useWorktrees } from "../state/worktrees";
import { useChanges } from "../state/changes";
import { undoLast } from "../ipc/undo";
import { ask } from "../ui/dialog";

vi.mock("../ipc/undo", () => ({ undoLast: vi.fn() }));
vi.mock("../ui/dialog", () => ({ ask: vi.fn() }));

const initialChanges = useChanges.getState();

beforeEach(() => {
  useStage.setState({ ...initialStage });
  usePalette.setState({ open: true, query: "" });
  useToasts.setState({ toasts: [] });
  useWorktrees.setState({ activePath: "/repos/main" });
  useChanges.setState({
    worktree: null,
    entries: { staged: [], unstaged: [] },
    selection: null,
    diff: null,
    selectedLineIds: [],
    dmode: "split",
    refresh: initialChanges.refresh,
    select: initialChanges.select,
    dispatch: initialChanges.dispatch,
  });
  vi.mocked(undoLast).mockReset();
  vi.mocked(ask).mockReset();
});

it("filters commands and runs the selected one with Enter", async () => {
  render(<Palette />);
  await userEvent.type(screen.getByRole("combobox"), "go changes");
  expect(screen.getAllByRole("option")[0]).toHaveTextContent("Go to Changes");
  await userEvent.keyboard("{Enter}");
  expect(useStage.getState().panes).toEqual(["changes"]);
  expect(usePalette.getState().open).toBe(false);
});

it("moves the selection with arrow keys", async () => {
  render(<Palette />);
  await userEvent.type(screen.getByRole("combobox"), "split bottom history");
  await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  expect(useStage.getState()).toMatchObject({ panes: ["home", "history"], dir: "v" });
});

it("turns a trailing ? into an Ask Claude command", async () => {
  render(<Palette />);
  await userEvent.type(screen.getByRole("combobox"), "what changed?");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option")).toHaveTextContent("Ask Claude: what changed?");
});

it("closes on Escape", async () => {
  render(<Palette />);
  await userEvent.keyboard("{Escape}");
  expect(usePalette.getState().open).toBe(false);
});

it("registers undo.last_action for the active worktree", async () => {
  render(<Palette />);
  await userEvent.type(screen.getByRole("combobox"), "undo last action");
  expect(screen.getByRole("option")).toHaveTextContent("Undo last action");
  await userEvent.keyboard("{Enter}");
  expect(undoLast).toHaveBeenCalledWith("/repos/main");
});

it.each([
  { query: "open changes", title: "Open Changes", screenId: "changes" as const },
  { query: "open files", title: "Open Files", screenId: "files" as const },
  { query: "open blame", title: "Open Blame", screenId: "history" as const },
])("renders and runs $query", async ({ query, title, screenId }) => {
  render(<Palette />);
  await userEvent.type(screen.getByRole("combobox"), query);
  expect(screen.getByRole("option")).toHaveTextContent(title);
  await userEvent.keyboard("{Enter}");
  expect(useStage.getState().panes).toEqual([screenId]);
  if (query === "open blame") expect((await import("../state/history")).useHistory.getState().mode).toBe("file");
});

it("toggles the selected file between staged and unstaged diffs", async () => {
  const select = vi.fn();
  useChanges.setState({
    selection: { path: "src/app.ts", area: "staged" },
    select,
  });
  render(<Palette />);
  await userEvent.type(screen.getByRole("combobox"), "toggle staged view");
  expect(screen.getByRole("option")).toHaveTextContent("Toggle staged view");
  await userEvent.keyboard("{Enter}");
  expect(select).toHaveBeenCalledWith({ path: "src/app.ts", area: "unstaged" });
});

it("confirms before dispatching discard-all for the active worktree", async () => {
  const dispatch = vi.fn().mockResolvedValue(true);
  useChanges.setState({
    worktree: "/repos/main",
    entries: { staged: [], unstaged: [
      { path: "src/app.ts", oldPath: null, indexStatus: "", worktreeStatus: "M", bytes: 10, large: false },
      { path: "README.md", oldPath: null, indexStatus: "", worktreeStatus: "M", bytes: 12, large: false },
    ] },
    refresh: vi.fn().mockResolvedValue(undefined),
    dispatch,
  });
  vi.mocked(ask).mockResolvedValue(true);

  render(<Palette />);
  await userEvent.type(screen.getByRole("combobox"), "discard all changes");
  expect(screen.getByRole("option")).toHaveTextContent("Discard all changes");
  await userEvent.keyboard("{Enter}");

  await waitFor(() => {
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      title: "Discard all changes?",
      ok: "Discard all",
      danger: true,
      meta: "src/app.ts\nREADME.md",
    }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "discard-paths",
      paths: ["src/app.ts", "README.md"],
      discardUntracked: true,
    });
  });
});
