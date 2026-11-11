import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ghRepoRemote } from "../../ipc/repo";
import { listPins } from "../../ipc/catalog";
import { listWorktrees } from "../../ipc/worktrees";
import { useGithubAccounts } from "../../github/store";
import { useRepos } from "../../state/repos";
import { useStage } from "../../state/stage";
import { initialStage } from "../../stage/stageModel";
import { useWorktrees } from "../../state/worktrees";
import { Sidebar } from "../../shell/Sidebar";
import { Stage } from "../../stage/Stage";

vi.mock("../../ipc/repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ipc/repo")>();
  return { ...actual, ghRepoRemote: vi.fn() };
});

vi.mock("../../ipc/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ipc/catalog")>();
  return { ...actual, listPins: vi.fn() };
});

vi.mock("../../ipc/worktrees", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ipc/worktrees")>();
  return { ...actual, listWorktrees: vi.fn(), onGitChanged: vi.fn() };
});

beforeEach(() => {
  useStage.setState({ ...initialStage });
  useRepos.setState({
    groups: [],
    projects: [{ id: "p1", owner: null, name: "repo", localPath: "/repo/main", groupId: null }],
    activeProjectId: "p1",
    status: "ready",
  });
  useWorktrees.setState({
    projectId: "p1",
    worktrees: [{ path: "/repo/main", branch: "main" } as never],
    pinnedPaths: [],
    activePath: "/repo/main",
    loading: false,
    error: null,
  });
  useGithubAccounts.setState({
    accounts: ["octocat"],
    defaultAccount: "octocat",
    ownerAccounts: {},
    loaded: true,
  });
  vi.mocked(listPins).mockResolvedValue([]);
  vi.mocked(listWorktrees).mockResolvedValue([{ path: "/repo/main", branch: "main" } as never]);
  vi.mocked(ghRepoRemote).mockReset().mockImplementation(() => new Promise(() => {}));
});

it("paints the Repository destination before starting its pending remote request", async () => {
  render(
    <>
      <Sidebar />
      <Stage />
    </>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Repository" }));

  expect(screen.getByRole("heading", { level: 1, name: "Repository" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Loading repository…");
  expect(ghRepoRemote).not.toHaveBeenCalled();

  await waitFor(() => expect(ghRepoRemote).toHaveBeenCalledWith("/repo/main"));
  expect(screen.getByRole("status")).toHaveTextContent("Loading repository…");
});
