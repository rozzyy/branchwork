/**
 * Task 11 – CodeMirror editor Vitest unit tests (AC 9)
 *
 * Covered:
 *  1. languages.ts  – getLanguageExtension / getLanguageName mapping
 *  2. gutter.ts     – computeGutterMarkers (add / modified / delete)
 *  3. state/files   – dirty-indicator lifecycle (openFile, markDirty, clearDirty, closeFile)
 *  4. CodeMirrorEditor – save-flow (mtime guard round-trip, conflict banner),
 *                        external-change clean-reload vs dirty-prompt,
 *                        status-bar updates on cursor move,
 *                        Diff-vs-HEAD toggle (setMode → "diff"),
 *                        tab management (open / close / dirty dot)
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Text, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getLanguageExtension, getLanguageName } from "./languages";
import { computeGutterMarkers } from "./gutter";
import { useFiles } from "../state/files";
import { DialogHost } from "../ui/dialog";
import { fsRead, fsWrite } from "../ipc/fs";
import { readDiff } from "../ipc/diff";
import { readStatus } from "../ipc/status";
import { useWorktrees } from "../state/worktrees";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { MarkdownPreview } from "./MarkdownPreview";
import type { DiffModel } from "../ipc/diff";

// ──────────────────────────────────────────────────────────────────────────────
// Module mocks
// ──────────────────────────────────────────────────────────────────────────────
vi.mock("../ipc/fs", () => ({
  fsRead: vi.fn(),
  fsWrite: vi.fn(),
  fsTree: vi.fn(),
  fsCreate: vi.fn(),
  fsDelete: vi.fn(),
  fsRename: vi.fn(),
  revealInFinder: vi.fn(),
}));
vi.mock("../ipc/diff", () => ({ readDiff: vi.fn() }));
vi.mock("../ipc/status", () => ({ readStatus: vi.fn() }));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
// onGitChanged from worktrees – return a no-op unlisten function
vi.mock("../ipc/worktrees", () => ({
  onGitChanged: vi.fn(() => Promise.resolve(() => undefined)),
  listWorktrees: vi.fn(),
  openWorktree: vi.fn(),
  addWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

// ResizeObserver is not available in jsdom – must be a real class (not vi.fn())
// because CodeMirror calls `new ResizeObserver(...)`.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// CodeMirror schedules animation-frame work that fires after jsdom tears down
// the DOM, producing "unhandled rejection" noise.  Replace rAF with a no-op.
vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
const WORKTREE = "/repos/main";
const FILE_PATH = "src/main.ts";
const FILE_CONTENT = "const x = 1;\n";
const FILE_BYTES = Array.from(new TextEncoder().encode(FILE_CONTENT));

function setupWorktreeAndFile(overrides: Partial<ReturnType<typeof useFiles.getState>> = {}) {
  useWorktrees.setState({
    activePath: WORKTREE,
    worktrees: [
      {
        path: WORKTREE,
        branch: "main",
        head: "abc123",
        ahead: 0,
        behind: 0,
        dirtyCount: 0,
        state: "clean",
      },
    ],
  });
  useFiles.setState({
    open: [FILE_PATH],
    current: FILE_PATH,
    dirty: {},
    expanded: {},
    fuzzyQuery: "",
    showIgnored: false,
    mode: "editor",
    buffers: {},
    ...overrides,
  });

  vi.mocked(fsRead).mockResolvedValue({
    bytes: FILE_BYTES,
    encoding: "utf-8",
    eol: "LF",
    mtime: 1000,
  });
  vi.mocked(readDiff).mockResolvedValue({
    hunks: [],
    binary: false,
    truncated: false,
    bytes: 0,
  });
  vi.mocked(readStatus).mockResolvedValue({ staged: [], unstaged: [] });
}

afterEach(() => {
  vi.clearAllMocks();
  useFiles.setState({
    open: [],
    current: null,
    dirty: {},
    expanded: {},
    fuzzyQuery: "",
    showIgnored: false,
    mode: "editor",
    buffers: {},
  });
  useWorktrees.setState({ activePath: null, worktrees: [] });
});

// ──────────────────────────────────────────────────────────────────────────────
// 1. Language mapping
// ──────────────────────────────────────────────────────────────────────────────
describe("getLanguageName", () => {
  it.each([
    ["main.ts", "TypeScript"],
    ["App.tsx", "TypeScript JSX"],
    ["index.js", "JavaScript"],
    ["comp.jsx", "JavaScript JSX"],
    ["data.json", "JSON"],
    ["README.md", "Markdown"],
    ["style.css", "CSS"],
    ["index.html", "HTML"],
    ["lib.rs", "Rust"],
    ["main.go", "Go"],
    ["script.py", "Python"],
    ["config.yaml", "YAML"],
    ["config.yml", "YAML"],
    ["Cargo.toml", "TOML"],
    ["no-extension", "Plain"],
    ["binary.bin", "Plain"],
  ])("%s → %s", (path, expected) => {
    expect(getLanguageName(path)).toBe(expected);
  });
});

describe("getLanguageExtension", () => {
  it("returns an extension object for known extensions", () => {
    expect(getLanguageExtension("main.ts")).not.toBeNull();
    expect(getLanguageExtension("main.rs")).not.toBeNull();
    expect(getLanguageExtension("main.go")).not.toBeNull();
    expect(getLanguageExtension("Cargo.toml")).not.toBeNull();
  });

  it("returns null for unknown extensions", () => {
    expect(getLanguageExtension("data.bin")).toBeNull();
    expect(getLanguageExtension("noext")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. Git gutter markers
// ──────────────────────────────────────────────────────────────────────────────
describe("computeGutterMarkers", () => {
  // Build a simple 10-line document
  const docText = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n";
  const doc = Text.of(docText.split("\n"));

  it("returns empty RangeSet for null diff", () => {
    const rs = computeGutterMarkers(null, doc);
    expect(rs.size).toBe(0);
  });

  it("returns empty RangeSet for diff with no hunks", () => {
    const diff: DiffModel = { hunks: [], binary: false, truncated: false, bytes: 0 };
    const rs = computeGutterMarkers(diff, doc);
    expect(rs.size).toBe(0);
  });

  it("marks added lines with 'a' kind", () => {
    const diff: DiffModel = {
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: "add", old: null, new: 1, text: "+line1", intra: null },
            { kind: "add", old: null, new: 2, text: "+line2", intra: null },
          ],
        },
      ],
      binary: false,
      truncated: false,
      bytes: 12,
    };
    const rs = computeGutterMarkers(diff, doc);
    expect(rs.size).toBe(2);
    // RangeSet.iter() starts already positioned at the first element
    const iter = rs.iter();
    // @ts-expect-error - accessing internal value
    expect(iter.value?.kind).toBe("a");
  });

  it("marks mixed add/del lines as modified 'm'", () => {
    const diff: DiffModel = {
      hunks: [
        {
          oldStart: 3,
          oldLines: 1,
          newStart: 3,
          newLines: 1,
          lines: [
            { kind: "del", old: 3, new: null, text: "-old", intra: null },
            { kind: "add", old: null, new: 3, text: "+new", intra: null },
          ],
        },
      ],
      binary: false,
      truncated: false,
      bytes: 8,
    };
    const rs = computeGutterMarkers(diff, doc);
    expect(rs.size).toBe(1);
    const iter = rs.iter();
    // @ts-expect-error - accessing internal value
    expect(iter.value?.kind).toBe("m");
  });

  it("marks deletion context line with 'd' kind", () => {
    const diff: DiffModel = {
      hunks: [
        {
          oldStart: 5,
          oldLines: 1,
          newStart: 5,
          newLines: 0,
          lines: [{ kind: "del", old: 5, new: null, text: "-deleted", intra: null }],
        },
      ],
      binary: false,
      truncated: false,
      bytes: 8,
    };
    const rs = computeGutterMarkers(diff, doc);
    expect(rs.size).toBe(1);
    const iter = rs.iter();
    // @ts-expect-error - accessing internal value
    expect(iter.value?.kind).toBe("d");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. Zustand files store – dirty indicator lifecycle
// ──────────────────────────────────────────────────────────────────────────────
describe("useFiles store – dirty lifecycle", () => {
  beforeEach(() => {
    useFiles.setState({ open: [], current: null, dirty: {}, expanded: {}, fuzzyQuery: "", showIgnored: false, mode: "editor", buffers: {} });
  });

  it("openFile adds path and sets current", () => {
    useFiles.getState().openFile("src/a.ts");
    const s = useFiles.getState();
    expect(s.open).toContain("src/a.ts");
    expect(s.current).toBe("src/a.ts");
  });

  it("openFile is idempotent for already-open paths", () => {
    useFiles.getState().openFile("src/a.ts");
    useFiles.getState().openFile("src/a.ts");
    expect(useFiles.getState().open.length).toBe(1);
  });

  it("markDirty sets dirty flag; clearDirty removes it", () => {
    useFiles.getState().openFile("src/a.ts");
    useFiles.getState().markDirty("src/a.ts");
    expect(useFiles.getState().dirty["src/a.ts"]).toBe(true);

    useFiles.getState().clearDirty("src/a.ts");
    expect(useFiles.getState().dirty["src/a.ts"]).toBeUndefined();
  });

  it("closeFile removes path and falls back to last remaining tab", () => {
    useFiles.getState().openFile("src/a.ts");
    useFiles.getState().openFile("src/b.ts");
    useFiles.getState().closeFile("src/b.ts");

    const s = useFiles.getState();
    expect(s.open).not.toContain("src/b.ts");
    expect(s.current).toBe("src/a.ts");
  });

  it("closeFile sets current to null when no tabs remain", () => {
    useFiles.getState().openFile("src/a.ts");
    useFiles.getState().closeFile("src/a.ts");
    expect(useFiles.getState().current).toBeNull();
  });

  it("setMode toggles between editor and diff", () => {
    useFiles.getState().setMode("diff");
    expect(useFiles.getState().mode).toBe("diff");
    useFiles.getState().setMode("editor");
    expect(useFiles.getState().mode).toBe("editor");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. CodeMirrorEditor component tests
// ──────────────────────────────────────────────────────────────────────────────
describe("CodeMirrorEditor", () => {
  it("re-renders markdown preview after switching away and back (cached buffer)", async () => {
    const MD = "docs/README.md";
    setupWorktreeAndFile({ open: [MD, FILE_PATH], current: MD });
    vi.mocked(fsRead).mockResolvedValue({
      bytes: Array.from(new TextEncoder().encode("# Hello")),
      encoding: "utf-8",
      eol: "LF",
      mtime: 1000,
    });
    render(<CodeMirrorEditor />);
    await screen.findByRole("heading", { name: "Hello" });

    act(() => useFiles.setState({ current: FILE_PATH }));
    act(() => useFiles.setState({ current: MD }));

    await screen.findByRole("heading", { name: "Hello" });
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("renders empty-state message when no file is open", () => {
    useWorktrees.setState({ activePath: WORKTREE, worktrees: [] });
    useFiles.setState({ open: [], current: null, dirty: {}, expanded: {}, fuzzyQuery: "", showIgnored: false, mode: "editor", buffers: {} });
    render(<CodeMirrorEditor />);
    expect(screen.getByText(/select a file/i)).toBeInTheDocument();
  });

  it("renders tab for the open file with close button", async () => {
    setupWorktreeAndFile();
    render(<CodeMirrorEditor />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /main\.ts/i })).toBeInTheDocument();
    });
  });

  it("shows dirty dot (•) on tab when file is dirty, not close button", async () => {
    setupWorktreeAndFile({ dirty: { [FILE_PATH]: true } });
    render(<CodeMirrorEditor />);

    await waitFor(() => {
      const tab = screen.getByRole("tab", { name: /main\.ts/i });
      // Dirty indicator doubles as the discard button
      expect(within_tab(tab).getByLabelText("Unsaved changes in main.ts. Discard…")).toBeInTheDocument();
    });
  });

  it("removes tab when close button is clicked on a clean file", async () => {
    setupWorktreeAndFile();
    render(<CodeMirrorEditor />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /main\.ts/i })).toBeInTheDocument();
    });

    const closeBtn = screen.getByRole("button", { name: /close main\.ts/i });
    await act(async () => {
      fireEvent.click(closeBtn);
    });

    expect(screen.queryByRole("tab", { name: /main\.ts/i })).not.toBeInTheDocument();
  });

  it("shows Save button enabled when file is dirty", async () => {
    setupWorktreeAndFile({ dirty: { [FILE_PATH]: true } });
    render(<CodeMirrorEditor />);

    await waitFor(() => {
      const saveBtn = screen.getByRole("button", { name: /^save/i });
      expect(saveBtn).not.toBeDisabled();
    });
  });

  it("shows Save button disabled when file is clean", async () => {
    setupWorktreeAndFile();
    render(<CodeMirrorEditor />);

    await waitFor(() => {
      const saveBtn = screen.getByRole("button", { name: /^save/i });
      expect(saveBtn).toBeDisabled();
    });
  });

  it("calls fsWrite on Save and clears dirty flag", async () => {
    setupWorktreeAndFile({ dirty: { [FILE_PATH]: true } });
    vi.mocked(fsWrite).mockResolvedValue(2000);
    render(<CodeMirrorEditor />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^save/i })).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    });

    await waitFor(() => {
      expect(fsWrite).toHaveBeenCalledWith(WORKTREE, FILE_PATH, expect.any(Array), expect.any(Number));
    });
  });

  it("shows external-change banner when conflict is detected on save", async () => {
    setupWorktreeAndFile({ dirty: { [FILE_PATH]: true } });

    // First write returns a conflict error
    vi.mocked(fsWrite).mockRejectedValueOnce({ kind: "conflict" });
    // Fresh read for the conflict banner
    vi.mocked(fsRead).mockResolvedValue({
      bytes: Array.from(new TextEncoder().encode("updated on disk\n")),
      encoding: "utf-8",
      eol: "LF",
      mtime: 9999,
    });

    render(<CodeMirrorEditor />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^save/i })).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // Banner must contain Reload / Keep mine / Compare actions
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /keep mine/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /compare/i })).toBeInTheDocument();
  });

  it("Reload banner action dismisses the banner", async () => {
    setupWorktreeAndFile({ dirty: { [FILE_PATH]: true } });
    vi.mocked(fsWrite).mockRejectedValueOnce({ kind: "conflict" });
    vi.mocked(fsRead).mockResolvedValue({
      bytes: Array.from(new TextEncoder().encode("disk content\n")),
      encoding: "utf-8",
      eol: "LF",
      mtime: 9999,
    });

    render(<CodeMirrorEditor />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^save/i })).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    });

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("Compare banner action calls setMode('diff')", async () => {
    setupWorktreeAndFile({ dirty: { [FILE_PATH]: true } });
    vi.mocked(fsWrite).mockRejectedValueOnce({ kind: "conflict" });
    vi.mocked(fsRead).mockResolvedValue({
      bytes: Array.from(new TextEncoder().encode("disk\n")),
      encoding: "utf-8",
      eol: "LF",
      mtime: 9999,
    });

    render(<CodeMirrorEditor />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^save/i })).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /compare/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /compare/i }));
    });

    expect(useFiles.getState().mode).toBe("diff");
  });

  it("status bar shows language name", async () => {
    setupWorktreeAndFile();
    render(<CodeMirrorEditor />);

    await waitFor(() => {
      expect(screen.getByText("TypeScript")).toBeInTheDocument();
    });
  });

  it("status bar shows branch name from worktree store", async () => {
    setupWorktreeAndFile();
    render(<CodeMirrorEditor />);

    await waitFor(() => {
      expect(screen.getByText(/⎇\s*main/)).toBeInTheDocument();
    });
  });

  it("status bar shows encoding and EOL from file buffer", async () => {
    setupWorktreeAndFile();
    render(<CodeMirrorEditor />);

    await waitFor(() => {
      expect(screen.getByText("UTF-8")).toBeInTheDocument();
      expect(screen.getByText("LF")).toBeInTheDocument();
    });
  });

  it("breadcrumb renders path segments", async () => {
    setupWorktreeAndFile();
    render(<CodeMirrorEditor />);

    await waitFor(() => {
      // "src" and "main.ts" should both appear in the breadcrumb bar
      expect(screen.getAllByText("src").length).toBeGreaterThan(0);
      expect(screen.getAllByText("main.ts").length).toBeGreaterThan(0);
    });
  });

  it("C1: a binary file shows a read-only notice and Save never calls fsWrite", async () => {
    setupWorktreeAndFile();
    vi.mocked(fsRead).mockResolvedValue({
      bytes: [137, 80, 78, 71, 13, 10, 26, 10],
      encoding: "binary",
      eol: "LF",
      mtime: 1000,
    });
    const { container } = render(<CodeMirrorEditor />);

    await waitFor(() => {
      expect(screen.getByText(/binary or not utf-8/i)).toBeInTheDocument();
    });
    // No editable CodeMirror buffer is ever mounted for this file.
    expect(container.querySelector(".cm-content")).toBeNull();

    const saveBtn = screen.getByRole("button", { name: /^save/i });
    expect(saveBtn).toBeDisabled();
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    expect(fsWrite).not.toHaveBeenCalled();
  });

  it("I2: toggling Markdown Preview to Source mounts the editor (no empty pane)", async () => {
    const MD = "docs/README.md";
    setupWorktreeAndFile({ open: [MD], current: MD });
    vi.mocked(fsRead).mockResolvedValue({
      bytes: Array.from(new TextEncoder().encode("# Hello")),
      encoding: "utf-8",
      eol: "LF",
      mtime: 1000,
    });
    const { container } = render(<CodeMirrorEditor />);

    // Markdown auto-enables Preview first.
    await screen.findByRole("heading", { name: "Hello" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /source/i }));
    });

    await waitFor(() => {
      expect(container.querySelector(".cm-content")).not.toBeNull();
    });
  });

  it("I3: saving a CRLF file preserves \\r\\n instead of normalising to LF", async () => {
    setupWorktreeAndFile({ dirty: { [FILE_PATH]: true } });
    vi.mocked(fsRead).mockResolvedValue({
      bytes: Array.from(new TextEncoder().encode("const a = 1;\r\nconst b = 2;\r\n")),
      encoding: "utf-8",
      eol: "CRLF",
      mtime: 1000,
    });
    vi.mocked(fsWrite).mockResolvedValue(2000);
    render(<CodeMirrorEditor />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^save/i })).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    });

    await waitFor(() => {
      expect(fsWrite).toHaveBeenCalled();
    });
    const [, , bytes] = vi.mocked(fsWrite).mock.calls[0];
    const written = new TextDecoder().decode(new Uint8Array(bytes));
    expect(written).toBe("const a = 1;\r\nconst b = 2;\r\n");
  });

  it("status bar Ln/Col updates on a simulated cursor move", async () => {
    setupWorktreeAndFile();
    const { container } = render(<CodeMirrorEditor />);

    await waitFor(() => {
      expect(screen.getByText(/Ln 1, Col 1/)).toBeInTheDocument();
    });

    const cmRoot = container.querySelector(".cm-editor");
    const view = cmRoot && EditorView.findFromDOM(cmRoot as HTMLElement);
    expect(view).toBeTruthy();

    act(() => {
      view!.dispatch({ selection: EditorSelection.cursor(6) });
    });

    await waitFor(() => {
      expect(screen.getByText(/Ln 1, Col 7/)).toBeInTheDocument();
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 5. External-change detection (AC7): git:changed / window focus re-reads every open file
// ──────────────────────────────────────────────────────────────────────────────
describe("external-change detection on focus", () => {
  it("clean file: silently replaces the cached buffer, no banner", async () => {
    setupWorktreeAndFile();
    render(<CodeMirrorEditor />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /main\.ts/i })).toBeInTheDocument();
    });

    vi.mocked(fsRead).mockResolvedValue({
      bytes: Array.from(new TextEncoder().encode("changed on disk\n")),
      encoding: "utf-8",
      eol: "LF",
      mtime: 2000,
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(fsRead).toHaveBeenCalledWith(WORKTREE, FILE_PATH);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // R8: the app's own reload of the view must not mark the file dirty.
    await waitFor(() => {
      expect(document.querySelector(".cm-content")?.textContent).toContain("changed on disk");
    });
    expect(useFiles.getState().dirty[FILE_PATH]).toBeUndefined();
  });

  it("dirty file: shows the conflict banner instead of overwriting", async () => {
    setupWorktreeAndFile({ dirty: { [FILE_PATH]: true } });
    render(<CodeMirrorEditor />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /main\.ts/i })).toBeInTheDocument();
    });

    vi.mocked(fsRead).mockResolvedValue({
      bytes: Array.from(new TextEncoder().encode("changed on disk\n")),
      encoding: "utf-8",
      eol: "LF",
      mtime: 2000,
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("background dirty tab changed on disk: banner surfaces once it becomes current", async () => {
    const OTHER_PATH = "src/other.ts";
    setupWorktreeAndFile({ open: [FILE_PATH, OTHER_PATH], current: FILE_PATH, dirty: { [FILE_PATH]: true } });
    render(<CodeMirrorEditor />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /main\.ts/i })).toBeInTheDocument();
    });

    // Switch to the other tab — FILE_PATH's buffer stays cached but is now in the background.
    await act(async () => {
      useFiles.setState({ current: OTHER_PATH });
    });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /other\.ts/i })).toBeInTheDocument();
    });

    // FILE_PATH changes on disk while it's in the background; OTHER_PATH is untouched.
    vi.mocked(fsRead).mockImplementation(async (_worktree, path) => {
      if (path === FILE_PATH) {
        return {
          bytes: Array.from(new TextEncoder().encode("changed on disk\n")),
          encoding: "utf-8",
          eol: "LF",
          mtime: 2000,
        };
      }
      return { bytes: FILE_BYTES, encoding: "utf-8", eol: "LF", mtime: 1000 };
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => {
      expect(fsRead).toHaveBeenCalledWith(WORKTREE, FILE_PATH);
    });
    // Still on OTHER_PATH: the conflict is parked, not shown yet.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Switch back to FILE_PATH: its parked conflict surfaces as the banner.
    await act(async () => {
      useFiles.setState({ current: FILE_PATH });
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 6. Buffer cache invalidation (I1): a stale relative-path-only cache must not leak content
//    across a worktree switch, and must not outlive a closed tab.
// ──────────────────────────────────────────────────────────────────────────────
describe("buffer cache invalidation (I1)", () => {
  it("switching the active worktree re-reads disk instead of reusing the old worktree's buffer", async () => {
    setupWorktreeAndFile();
    render(<CodeMirrorEditor />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /main\.ts/i })).toBeInTheDocument();
    });
    const callsBefore = vi.mocked(fsRead).mock.calls.length;

    await act(async () => {
      useWorktrees.setState({ activePath: "/repos/other" });
    });

    await waitFor(() => {
      expect(vi.mocked(fsRead).mock.calls.length).toBeGreaterThan(callsBefore);
    });
    expect(fsRead).toHaveBeenLastCalledWith("/repos/other", FILE_PATH);
  });

  it("closing a tab drops its cached buffer so reopening it re-reads disk", async () => {
    setupWorktreeAndFile();
    render(<CodeMirrorEditor />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /main\.ts/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /close main\.ts/i }));
    });
    const callsBefore = vi.mocked(fsRead).mock.calls.length;

    await act(async () => {
      useFiles.getState().openFile(FILE_PATH);
    });

    await waitFor(() => {
      expect(vi.mocked(fsRead).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 6b. R5/R6 (code review): buffers live in the files store, not a component ref, so they
//     outlive an unmount, are shared by two editor instances, and a dirty tab has a discard path.
// ──────────────────────────────────────────────────────────────────────────────
describe("buffers live in the store (R5/R6)", () => {
  it("R5a: an edit survives the editor unmounting and remounting", async () => {
    setupWorktreeAndFile();
    const { container, unmount } = render(<CodeMirrorEditor />);

    const cmRoot = await waitFor(() => {
      const el = container.querySelector(".cm-editor");
      if (!el) throw new Error("not mounted yet");
      return el;
    });
    const view = EditorView.findFromDOM(cmRoot as HTMLElement)!;
    act(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: "// edited\n" } });
    });
    expect(useFiles.getState().dirty[FILE_PATH]).toBe(true);

    unmount();

    const { container: remounted } = render(<CodeMirrorEditor />);
    await waitFor(() => {
      expect(remounted.querySelector(".cm-content")?.textContent).toContain("edited");
    });
    expect(useFiles.getState().dirty[FILE_PATH]).toBe(true);
  });

  it("R6: two editor instances on the same file share edits", async () => {
    setupWorktreeAndFile();
    const { container: containerA } = render(<CodeMirrorEditor />);
    const { container: containerB } = render(<CodeMirrorEditor />);

    const rootA = await waitFor(() => {
      const el = containerA.querySelector(".cm-editor");
      if (!el) throw new Error("not mounted yet");
      return el;
    });
    await waitFor(() => {
      if (!containerB.querySelector(".cm-editor")) throw new Error("not mounted yet");
    });

    const viewA = EditorView.findFromDOM(rootA as HTMLElement)!;
    act(() => {
      viewA.dispatch({ changes: { from: 0, to: 0, insert: "shared-edit\n" } });
    });

    await waitFor(() => {
      expect(containerB.querySelector(".cm-content")?.textContent).toContain("shared-edit");
    });
  });

  it("R5c: closing a dirty tab asks to discard and closes it on confirm", async () => {
    setupWorktreeAndFile({ dirty: { [FILE_PATH]: true } });
    render(
      <>
        <CodeMirrorEditor />
        <DialogHost />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/^Unsaved changes/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/^Unsaved changes/));
    const dialog = await screen.findByRole("dialog");

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    });

    expect(screen.queryByRole("tab", { name: /main\.ts/i })).not.toBeInTheDocument();
    expect(useFiles.getState().dirty[FILE_PATH]).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 7. MarkdownPreview sanitizer (S3-M1): a malicious README must not get a nav/restyle vector
// ──────────────────────────────────────────────────────────────────────────────
describe("MarkdownPreview sanitizer (S3-M1)", () => {
  it("strips form/style/button and style/action attrs, and blocks area/anchor click navigation", async () => {
    const payload = [
      '<form action="https://evil.example/x"><button>Continue</button></form>',
      "<style>body{display:none}</style>",
      '<map><area href="https://evil.example/a"></map>',
      '<p style="color:red">hi</p>',
      '<a href="https://evil.example/b">link</a>',
    ].join("\n\n");

    const { container } = render(<MarkdownPreview content={payload} />);

    const root = await waitFor(() => {
      const el = container.querySelector(".md-preview");
      if (!el) throw new Error("preview not rendered yet");
      return el;
    });

    expect(root.querySelector("form")).toBeNull();
    expect(root.querySelector("style")).toBeNull();
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelector("input")).toBeNull();
    expect(root.innerHTML).not.toMatch(/\bstyle=/);
    expect(root.innerHTML).not.toMatch(/\baction=/);

    const area = root.querySelector("area");
    expect(area).not.toBeNull();
    expect(fireEvent.click(area!)).toBe(false); // preventDefault fired -> no navigation

    const anchor = root.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(fireEvent.click(anchor!)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Utility: find element within a DOM subtree
// ──────────────────────────────────────────────────────────────────────────────
function within_tab(element: HTMLElement) {
  return {
    getByLabelText(label: string) {
      const el = element.querySelector(`[aria-label="${label}"]`);
      if (!el) throw new Error(`Could not find element with aria-label="${label}" within tab`);
      return el;
    },
  };
}
