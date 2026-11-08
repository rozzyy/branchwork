import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readBlame, readFileHistory } from "../../ipc/blame";
import { fsRead, fsTree } from "../../ipc/fs";
import { useFiles } from "../../state/files";
import { useStage } from "../../state/stage";
import { useWorktrees } from "../../state/worktrees";
import { useGraphUi } from "../graph/graphState";
import { BlameToolbar, BlameView, heatStripeColor } from "./BlameScreen";
import { useBlameUi } from "./blameState";

vi.mock("../../ipc/blame", () => ({ readBlame: vi.fn(), readFileHistory: vi.fn() }));
vi.mock("../../ipc/fs", () => ({ fsRead: vi.fn(), fsTree: vi.fn() }));

const worktreePath = "/repos/main";
const filePath = "src/main.ts";
const now = Math.floor(Date.now() / 1000);

const blameResult = {
  lines: [
    { line: 1, sha: "a".repeat(40), author: "Alice A", time: now - 60, summary: "feat: one", ageBucket: "hours" as const },
    { line: 2, sha: "a".repeat(40), author: "Alice A", time: now - 60, summary: "feat: one", ageBucket: "days" as const },
    { line: 3, sha: "b".repeat(40), author: "Bob B", time: now - 90000, summary: "fix: two", ageBucket: "weeks" as const },
    { line: 4, sha: "c".repeat(40), author: "Carol C", time: now - 9000000, summary: "chore: three", ageBucket: "months" as const },
    { line: 5, sha: "c".repeat(40), author: "Carol C", time: now - 90000000, summary: "chore: three", ageBucket: "older" as const },
  ],
  groups: [
    { sha: "a".repeat(40), start: 1, end: 2 },
    { sha: "b".repeat(40), start: 3, end: 3 },
    { sha: "c".repeat(40), start: 4, end: 5 },
  ],
};

const historyResult = [
  { sha: "c".repeat(40), author: "Carol C", message: "chore: three", time: now - 9000000 },
  { sha: "b".repeat(40), author: "Bob B", message: "fix: two", time: now - 90000 },
  { sha: "a".repeat(40), author: "Alice A", message: "feat: one", time: now - 60 },
];

async function setup(current: string | null = filePath) {
  vi.mocked(readBlame).mockResolvedValue(blameResult);
  vi.mocked(readFileHistory).mockResolvedValue(historyResult);
  vi.mocked(fsRead).mockResolvedValue({
    bytes: [...new TextEncoder().encode("one\ntwo\nthree\nfour\nfive")],
    encoding: "utf-8", eol: "LF", mtime: 1,
  });
  vi.mocked(fsTree).mockResolvedValue({ entries: [{ name: "src", isDir: true, status: null, size: 0, mtime: 1 }] });
  useWorktrees.setState({ activePath: worktreePath, worktrees: [{ path: worktreePath, branch: "main", head: "h", ahead: 0, behind: 0, dirtyCount: 0, state: "clean" }] });
  useFiles.setState({ current, open: current ? [current] : [], mode: "editor" });
  useBlameUi.setState({ selectedLine: null });
  useGraphUi.setState({ selection: { kind: "wip" }, selectedCommit: null });
  const go = vi.fn();
  useStage.setState({ go });
  render(<><BlameToolbar /><BlameView /></>);
  if (current) await screen.findByText("one");
  return { go };
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  useWorktrees.setState({ activePath: null, worktrees: [] });
  useFiles.setState({ current: null, open: [] });
});

it("collapses consecutive lines into one gutter row per group", async () => {
  await setup();
  expect(document.querySelectorAll('[data-testid="blame-gutter"]')).toHaveLength(3);
  expect(document.querySelectorAll("[data-blame-line]")).toHaveLength(5);
});

it("maps each age_bucket to its heat stripe color", async () => {
  expect(heatStripeColor("hours")).toBe("var(--red)");
  expect(heatStripeColor("days")).toBe("var(--yel)");
  expect(heatStripeColor("weeks")).toContain("var(--yel)");
  expect(heatStripeColor("months")).toBe("var(--s3)");
  expect(heatStripeColor("older")).toBe("var(--s4)");
  await setup();
  for (const bucket of ["hours", "days", "weeks", "months", "older"]) {
    const stripe = document.querySelector(`[data-age-bucket="${bucket}"]`) as HTMLElement;
    expect(stripe).toBeTruthy();
    expect(stripe.style.background).toBe(heatStripeColor(bucket as never));
  }
});

it("updates the detail panel when a line is clicked", async () => {
  await setup();
  expect(screen.getAllByText("feat: one").length).toBeGreaterThan(0);
  await userEvent.click(document.querySelector('[data-blame-line="4"]') as HTMLElement);
  expect(screen.getAllByText("chore: three").length).toBeGreaterThan(0);
  expect(screen.getByText("LINE 4 LAST CHANGED")).toBeInTheDocument();
  expect(screen.getAllByText("ccccccc").length).toBeGreaterThan(0);
});

it("fires the Graph deep-link with the selected commit SHA", async () => {
  const { go } = await setup();
  await userEvent.click(document.querySelector('[data-blame-line="3"]') as HTMLElement);
  await userEvent.click(screen.getByRole("button", { name: "View commit" }));
  expect(useGraphUi.getState().selection).toEqual({ kind: "commit", sha: "b".repeat(40) });
  expect(go).toHaveBeenCalledWith("graph");
});

it("scrolls the code column to a history item's first group line", async () => {
  await setup();
  const items = document.querySelectorAll(".blame-history-item");
  await userEvent.click(items[2] as HTMLElement);
  expect(useBlameUi.getState().selectedLine).toBe(1);
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});

it("renders the PR button disabled with the deferred tooltip", async () => {
  await setup();
  const pr = screen.getByRole("button", { name: "View PR" }) as HTMLButtonElement;
  expect(pr.disabled).toBe(true);
  expect(pr.title).toBe("Available in M4 (GitHub)");
});

it("shows the empty state with a Pick a file button when no file is selected", async () => {
  const { go } = await setup(null);
  expect(screen.getByText("No file selected")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Pick a file" }));
  expect(go).toHaveBeenCalledWith("files");
});
