import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { readCompareFileDiff, readCompareWorktrees } from "../../ipc/compare";
import { useWorktrees } from "../../state/worktrees";
import { CompareDialog } from "./CompareDialog";

vi.mock("../../ipc/compare", () => ({
  readCompareWorktrees: vi.fn(),
  readCompareFileDiff: vi.fn(),
  readComparePatch: vi.fn(),
}));
vi.mock("../../diff/DiffRenderer", () => ({ DiffRenderer: ({ fileName }: { fileName?: string }) => <div>{fileName}</div> }));

beforeEach(() => {
  vi.clearAllMocks();
  useWorktrees.setState({ worktrees: [
    { path: "/repo/main", branch: "main" } as never,
    { path: "/repo/race", branch: "race/fix" } as never,
  ] });
  vi.mocked(readCompareWorktrees).mockResolvedValue({
    files: [{ path: "src/app.ts", oldPath: null, status: "modified", additions: 2, deletions: 1, binary: false, truncated: false }],
    truncated: false,
    untrackedExcluded: true,
  });
  vi.mocked(readCompareFileDiff).mockResolvedValue({ hunks: [], binary: false, truncated: false, bytes: 0 });
});

it("loads a bounded file summary and the selected file diff", async () => {
  render(<CompareDialog open onClose={vi.fn()} />);
  expect(await screen.findByRole("button", { name: /src\/app.ts/ })).toBeVisible();
  await waitFor(() => expect(readCompareFileDiff).toHaveBeenCalledWith("/repo/main", "/repo/race", "src/app.ts", true));
  expect(screen.getByText("Untracked files are excluded from this comparison.")).toBeVisible();
  expect(screen.getByText("+0 added · −0 removed · 1 changed")).toBeVisible();
});

it("reloads the comparison when the tracked-uncommitted option changes", async () => {
  render(<CompareDialog open onClose={vi.fn()} />);
  await screen.findByRole("button", { name: /src\/app.ts/ });
  fireEvent.click(screen.getByRole("checkbox", { name: "Include tracked uncommitted changes" }));
  await waitFor(() => expect(readCompareWorktrees).toHaveBeenLastCalledWith("/repo/main", "/repo/race", false));
});
