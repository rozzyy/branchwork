import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fsCreate, fsDelete, fsRead, fsTree, fsWrite, revealInFinder } from "../../ipc/fs";
import { discardPaths } from "../../ipc/changes";
import { readDiff } from "../../ipc/diff";
import { readStatus } from "../../ipc/status";
import { onGitChanged } from "../../ipc/worktrees";
import { DialogHost } from "../../ui/dialog";
import { useWorktrees } from "../../state/worktrees";
import { useFiles } from "../../state/files";
import { FilesToolbar, FilesView } from "./FilesScreen";

vi.mock("../../ipc/fs", () => ({
  fsTree: vi.fn(),
  fsCreate: vi.fn(),
  fsDelete: vi.fn(),
  fsRead: vi.fn(),
  fsRename: vi.fn(),
  fsWrite: vi.fn(),
  revealInFinder: vi.fn(),
}));
vi.mock("../../ipc/changes", () => ({ discardPaths: vi.fn() }));
vi.mock("../../ipc/diff", () => ({ readDiff: vi.fn() }));
vi.mock("../../ipc/status", () => ({ readStatus: vi.fn() }));
vi.mock("../../ipc/worktrees", () => ({ onGitChanged: vi.fn() }));
vi.mock("../../ui/toast", () => ({ toast: vi.fn() }));

const worktreePath = "/repos/main";
const rootEntries = [
  { name: "src", isDir: true, status: null, size: 0, mtime: 1000 },
  { name: "README.md", isDir: false, status: null, size: 10, mtime: 1000 },
];
const srcEntries = [
  { name: "main.ts", isDir: false, status: null, size: 20, mtime: 1000 },
  { name: "utils.ts", isDir: false, status: null, size: 5, mtime: 1000 },
];

async function setup(fileOverrides: Partial<ReturnType<typeof useFiles.getState>> = {}) {
  vi.mocked(fsTree).mockImplementation(async (_worktreePath, options) => {
    if (options.path === "src") return { entries: srcEntries };
    return { entries: rootEntries };
  });
  vi.mocked(readStatus).mockResolvedValue({
    staged: [],
    unstaged: [{ path: "src/main.ts", oldPath: null, indexStatus: "", worktreeStatus: "M", bytes: 20, large: false }],
  });
  vi.mocked(readDiff).mockResolvedValue({ hunks: [], binary: false, truncated: false, bytes: 0 });
  vi.mocked(discardPaths).mockResolvedValue(false);
  vi.mocked(fsDelete).mockResolvedValue(false);

  useWorktrees.setState({
    activePath: worktreePath,
    worktrees: [{ path: worktreePath, branch: "main", head: "head", ahead: 0, behind: 0, dirtyCount: 1, state: "dirty" }],
  });
  useFiles.setState({
    open: [],
    current: null,
    dirty: {},
    expanded: {},
    fuzzyQuery: "",
    showIgnored: false,
    mode: "editor",
    ...fileOverrides,
  });

  render(
    <>
      <FilesToolbar />
      <FilesView />
      <DialogHost />
    </>,
  );
  await screen.findByText("README.md");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(onGitChanged).mockResolvedValue(() => {});
});

afterEach(() => {
  useWorktrees.setState({ activePath: null, worktrees: [] });
});

it("renders tree rows with status letters and dirty dots", async () => {
  await setup({ expanded: { src: true }, dirty: { "src/main.ts": true } });

  const row = (await screen.findByText("main.ts")).closest(".files-tree-node") as HTMLElement;
  expect(within(row).getByText("M")).toBeInTheDocument();
  expect(row.querySelector(".files-dirty-dot")).toBeInTheDocument();

  const cleanRow = screen.getByText("utils.ts").closest(".files-tree-node") as HTMLElement;
  expect(within(cleanRow).queryByText("M")).not.toBeInTheDocument();
  expect(cleanRow.querySelector(".files-dirty-dot")).not.toBeInTheDocument();
});

it("loads only the root on mount, then fetches a folder's children on first expand (I7)", async () => {
  await setup();
  expect(fsTree).toHaveBeenCalledTimes(1);
  expect(fsTree).toHaveBeenCalledWith(worktreePath, { path: "", showIgnored: false, includeStatus: false });

  await userEvent.click(screen.getByText("src"));
  await screen.findByText("main.ts");
  expect(fsTree).toHaveBeenCalledTimes(2);
  expect(fsTree).toHaveBeenCalledWith(worktreePath, { path: "src", showIgnored: false, includeStatus: false });

  // Collapsing and re-expanding reuses the cached children — no extra fetch.
  await userEvent.click(screen.getByText("src"));
  await userEvent.click(screen.getByText("src"));
  await screen.findByText("main.ts");
  expect(fsTree).toHaveBeenCalledTimes(2);
});

it("a git:changed event for the active worktree refetches the root plus only expanded/loaded folders, not the whole tree (I6/R4)", async () => {
  const handlers: Array<(event: { worktree: string }) => void> = [];
  vi.mocked(onGitChanged).mockImplementation(async (callback) => {
    handlers.push(callback);
    return () => {};
  });
  await setup({ expanded: { src: true } });
  await screen.findByText("main.ts");
  await waitFor(() => expect(handlers).toHaveLength(1));
  vi.mocked(fsTree).mockClear();

  await act(async () => handlers[0]({ worktree: worktreePath }));

  await waitFor(() => expect(fsTree).toHaveBeenCalledTimes(2));
  expect(fsTree).toHaveBeenCalledWith(worktreePath, { path: "", showIgnored: false, includeStatus: false });
  expect(fsTree).toHaveBeenCalledWith(worktreePath, { path: "src", showIgnored: false, includeStatus: false });
});

it("drops a stale reload response that resolves after a newer one (R4)", async () => {
  const handlers: Array<(event: { worktree: string }) => void> = [];
  vi.mocked(onGitChanged).mockImplementation(async (callback) => {
    handlers.push(callback);
    return () => {};
  });
  await setup();
  await waitFor(() => expect(handlers).toHaveLength(1));

  const pendingRootFetches: Array<(value: { entries: typeof rootEntries }) => void> = [];
  vi.mocked(fsTree).mockImplementation(
    (_worktreePath, options) =>
      new Promise((resolve) => {
        if (options.path === "src") resolve({ entries: srcEntries });
        else pendingRootFetches.push(resolve);
      }),
  );

  await act(async () => handlers[0]({ worktree: worktreePath }));
  await act(async () => handlers[0]({ worktree: worktreePath }));
  await waitFor(() => expect(pendingRootFetches).toHaveLength(2));

  // The newer (second) reload resolves first, with fresh data.
  act(() => pendingRootFetches[1]({ entries: [{ name: "NEW.md", isDir: false, status: null, size: 1, mtime: 2 }] }));
  await screen.findByText("NEW.md");

  // The older, slower reload resolving afterwards must not overwrite the newer result.
  await act(async () => pendingRootFetches[0]({ entries: rootEntries }));
  expect(screen.getByText("NEW.md")).toBeInTheDocument();
  expect(screen.queryByText("README.md")).not.toBeInTheDocument();
});

it("the show-ignored toggle re-fetches fs_tree with the flag set", async () => {
  await setup();
  await userEvent.click(screen.getByRole("checkbox", { name: "Show ignored files" }));
  await waitFor(() => {
    expect(fsTree).toHaveBeenCalledWith(worktreePath, { path: "", showIgnored: true, includeStatus: false });
  });
});

it("the context menu shows live items alongside disabled deferred ones", async () => {
  await setup();
  const row = screen.getByText("README.md").closest(".files-tree-node") as HTMLElement;
  fireEvent.contextMenu(row);

  expect(await screen.findByRole("menuitem", { name: /New file/ })).toBeEnabled();
  expect(screen.getByRole("menuitem", { name: /Rename/ })).toBeEnabled();

  const terminalItem = screen.getByRole("menuitem", { name: /Open terminal here/ });
  expect(terminalItem).toBeEnabled();

  const agentItem = screen.getByRole("menuitem", { name: /Ask agent about this/ });
  expect(agentItem).toBeDisabled();
});

it("⌘P search filters the tree via the fuzzy ranker", async () => {
  await setup();
  await userEvent.type(screen.getByPlaceholderText(/Find file/), "main");

  expect(await screen.findByText("main.ts")).toBeInTheDocument();
  expect(screen.queryByText("README.md")).not.toBeInTheDocument();
  expect(screen.queryByText("utils.ts")).not.toBeInTheDocument();
});

it("discarding changes from the context menu asks for confirmation before calling discard_paths", async () => {
  await setup({ expanded: { src: true } });
  const row = (await screen.findByText("main.ts")).closest(".files-tree-node") as HTMLElement;
  fireEvent.contextMenu(row);

  await userEvent.click(screen.getByRole("menuitem", { name: "Discard changes" }));
  const dialog = await screen.findByRole("dialog");
  expect(discardPaths).not.toHaveBeenCalled();

  await userEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
  await waitFor(() => {
    expect(discardPaths).toHaveBeenCalledWith(worktreePath, ["src/main.ts"], false);
  });
});

it("Duplicate refuses a binary file instead of writing a truncated copy", async () => {
  await setup();
  vi.mocked(fsRead).mockResolvedValue({ bytes: [0, 1, 2], encoding: "binary", eol: "LF", mtime: 1000 });
  const row = screen.getByText("README.md").closest(".files-tree-node") as HTMLElement;
  fireEvent.contextMenu(row);

  await userEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));

  await waitFor(() => expect(fsRead).toHaveBeenCalled());
  expect(fsWrite).not.toHaveBeenCalled();
});

it("Duplicate writes the copy without a preceding fsCreate, which would conflict (I4)", async () => {
  await setup();
  vi.mocked(fsRead).mockResolvedValue({ bytes: [1, 2, 3], encoding: "utf-8", eol: "LF", mtime: 1000 });
  vi.mocked(fsWrite).mockResolvedValue(1234);
  const row = screen.getByText("README.md").closest(".files-tree-node") as HTMLElement;
  fireEvent.contextMenu(row);

  await userEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));

  await waitFor(() => {
    expect(fsWrite).toHaveBeenCalledWith(worktreePath, "README.copy.md", [1, 2, 3], 0);
  });
  expect(fsCreate).not.toHaveBeenCalled();
});

it("Open in > Finder dispatches reveal_in_finder with the worktree path and the file's relative path", async () => {
  await setup({ current: "src/main.ts" });
  await userEvent.click(screen.getByRole("button", { name: "↗ Open in ▾" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Finder" }));

  await waitFor(() => {
    expect(revealInFinder).toHaveBeenCalledWith(worktreePath, "src/main.ts");
  });
});

it("Diff vs HEAD mode reads the head diff area and renders the DiffRenderer", async () => {
  await setup({ current: "README.md" });
  vi.mocked(readDiff).mockResolvedValue({
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: "del", old: 1, new: null, text: "old", intra: null },
          { kind: "add", old: null, new: 1, text: "new", intra: null },
        ],
      },
    ],
    binary: false,
    truncated: false,
    bytes: 6,
  });

  await userEvent.click(screen.getByRole("radio", { name: "Diff vs HEAD" }));

  await waitFor(() => {
    expect(readDiff).toHaveBeenCalledWith(worktreePath, "README.md", "head");
  });
  await waitFor(() => {
    expect(document.querySelector(".diff-renderer")).toBeInTheDocument();
  });
});


it("⌘P keeps its results across a git:changed reload while searching (R9)", async () => {
  const handlers: Array<(event: { worktree: string }) => void> = [];
  vi.mocked(onGitChanged).mockImplementation(async (callback) => {
    handlers.push(callback);
    return () => {};
  });
  await setup();
  await waitFor(() => expect(handlers).toHaveLength(1));
  const search = screen.getByLabelText("Find file");
  fireEvent.focus(search);
  await userEvent.type(search, "utils");
  expect(await screen.findByText("utils.ts")).toBeInTheDocument();

  await act(async () => handlers[0]({ worktree: worktreePath }));

  expect(screen.queryByText("No matching files")).not.toBeInTheDocument();
  expect(screen.getByText("utils.ts")).toBeInTheDocument();
});
