import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { WipSummary } from "../../ipc/graph";
import { useChanges } from "../../state/changes";
import { WipInspector } from "./WipInspector";

const wip: WipSummary = {
  worktreePath: "/repos/main",
  head: "head-sha",
  branch: "main",
  stagedFiles: ["src/app.ts"],
  unstagedFiles: ["src/app.ts", "src/edited.ts"],
  untrackedFiles: ["new.ts"],
  conflictedFiles: ["conflict.ts"],
};

const initialChanges = useChanges.getState();
const dispatch = vi.fn();
const onOpenDiff = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
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
    refresh: vi.fn().mockResolvedValue(undefined),
    dispatch,
  });
});

it("lists all WIP groups and opens staged and unstaged file requests in Graph", async () => {
  render(
    <WipInspector
      wip={wip}
      onOpenChanges={vi.fn()}
      onOpenDiff={onOpenDiff}
    />,
  );

  for (const name of ["Staged", "Unstaged", "Untracked", "Conflicted"]) {
    expect(screen.getByRole("heading", { name: new RegExp(name) })).toBeInTheDocument();
  }
  await userEvent.click(screen.getByRole("button", { name: "Open staged diff for src/app.ts" }));
  await userEvent.click(screen.getByRole("button", { name: "Open unstaged diff for src/app.ts" }));
  expect(onOpenDiff).toHaveBeenNthCalledWith(1, "src/app.ts", "staged");
  expect(onOpenDiff).toHaveBeenNthCalledWith(2, "src/app.ts", "unstaged");
});

it("keeps staging in Changes and opens Changes beside", async () => {
  const onOpenChanges = vi.fn();
  render(
    <WipInspector
      wip={wip}
      onOpenChanges={onOpenChanges}
      onOpenDiff={onOpenDiff}
    />,
  );
  expect(screen.queryByRole("button", { name: "Stage new.ts" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Unstage src/app.ts" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Commit…/ }));
  expect(onOpenChanges).toHaveBeenCalledOnce();
});
