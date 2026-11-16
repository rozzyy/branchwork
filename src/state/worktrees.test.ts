import { listPins, type Project } from "../ipc/catalog";
import { loadSetting } from "../ipc/settings";
import { listWorktrees, type Worktree } from "../ipc/worktrees";
import { useWorktrees } from "./worktrees";
import { useFiles } from "./files";

vi.mock("../ipc/catalog", () => ({ listPins: vi.fn(), pinWorktree: vi.fn(), unpinWorktree: vi.fn() }));
vi.mock("../ipc/settings", () => ({ loadSetting: vi.fn(), saveSetting: vi.fn(() => Promise.resolve()) }));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
vi.mock("../ipc/worktrees", () => ({ listWorktrees: vi.fn() }));

const project = { id: "p1", localPath: "/repo" } as Project;
const worktree = { path: "/repo" } as Worktree;

it("keeps existing rows visible (no loading state) on a same-project refresh", async () => {
  vi.mocked(listWorktrees).mockResolvedValue([worktree]);
  vi.mocked(listPins).mockResolvedValue([]);
  vi.mocked(loadSetting).mockResolvedValue(null);
  await useWorktrees.getState().load(project);

  const refresh = useWorktrees.getState().load(project);
  expect(useWorktrees.getState().loading).toBe(false);
  expect(useWorktrees.getState().worktrees).toEqual([worktree]);
  await refresh;
});

it("refuses to switch worktree while an editor buffer is dirty", async () => {
  const other = { path: "/repo-b" } as Worktree;
  vi.mocked(listWorktrees).mockResolvedValue([worktree, other]);
  vi.mocked(listPins).mockResolvedValue([]);
  vi.mocked(loadSetting).mockResolvedValue(null);
  await useWorktrees.getState().load(project);
  useWorktrees.getState().select("/repo");
  useFiles.setState({ dirty: { "a.ts": true } });

  useWorktrees.getState().select("/repo-b");
  expect(useWorktrees.getState().activePath).toBe("/repo");

  useFiles.setState({ dirty: {} });
  useWorktrees.getState().select("/repo-b");
  expect(useWorktrees.getState().activePath).toBe("/repo-b");
});

it("refuses to load a different project while an editor buffer is dirty (R5b)", async () => {
  vi.mocked(listWorktrees).mockResolvedValue([worktree]);
  vi.mocked(listPins).mockResolvedValue([]);
  vi.mocked(loadSetting).mockResolvedValue(null);
  await useWorktrees.getState().load(project);
  useFiles.setState({ dirty: { "a.ts": true } });

  const other = { id: "p2", localPath: "/repo2" } as Project;
  await useWorktrees.getState().load(other);
  expect(useWorktrees.getState().projectId).toBe("p1");

  useFiles.setState({ dirty: {} });
  vi.mocked(listWorktrees).mockResolvedValue([{ path: "/repo2" } as Worktree]);
  await useWorktrees.getState().load(other);
  expect(useWorktrees.getState().projectId).toBe("p2");
});

it("loads and caches a second project's worktrees without disturbing the active one", async () => {
  const projectA = { id: "pa", localPath: "/a" } as Project;
  const projectB = { id: "pb", localPath: "/b" } as Project;
  vi.mocked(listWorktrees).mockImplementation(async (id: string) =>
    id === "pa" ? [{ path: "/a" } as Worktree] : ([{ path: "/b" }, { path: "/b/wt-1" }] as Worktree[]),
  );
  vi.mocked(listPins).mockResolvedValue([]);
  vi.mocked(loadSetting).mockResolvedValue(null);
  await useWorktrees.getState().load(projectA);

  const cached = await useWorktrees.getState().ensureProjectWorktrees(projectB);
  expect(cached).toEqual({ worktrees: [{ path: "/b" }, { path: "/b/wt-1" }], activePath: "/b" });
  expect(useWorktrees.getState().projectId).toBe("pa");
  expect(useWorktrees.getState().worktrees).toEqual([{ path: "/a" }]);
  expect(useWorktrees.getState().activePath).toBe("/a");

  vi.mocked(listWorktrees).mockClear();
  await useWorktrees.getState().ensureProjectWorktrees(projectB);
  expect(listWorktrees).not.toHaveBeenCalled();
});

it("worktreePathsFor resolves the pinned project's paths without touching global state", async () => {
  const projectA = { id: "pa", localPath: "/a" } as Project;
  const projectB = { id: "pb", localPath: "/b" } as Project;
  vi.mocked(listWorktrees).mockImplementation(async (id: string) =>
    id === "pa" ? [{ path: "/a" } as Worktree] : ([{ path: "/b" }, { path: "/b/wt-1" }] as Worktree[]),
  );
  vi.mocked(listPins).mockResolvedValue([]);
  vi.mocked(loadSetting).mockResolvedValue(null);
  await useWorktrees.getState().load(projectA);
  await useWorktrees.getState().ensureProjectWorktrees(projectB);

  expect(useWorktrees.getState().worktreePathsFor(projectA)).toEqual(["/a"]);
  expect(useWorktrees.getState().worktreePathsFor(projectB)).toEqual(["/b", "/b/wt-1"]);
  expect(useWorktrees.getState().worktreePathsFor({ id: "px", localPath: "/x" } as Project)).toEqual(["/x"]);
  expect(useWorktrees.getState().projectId).toBe("pa");
});

it("selectCachedWorktree switches only the cached project", async () => {
  const projectA = { id: "pa", localPath: "/a" } as Project;
  const projectB = { id: "pb", localPath: "/b" } as Project;
  vi.mocked(listWorktrees).mockImplementation(async (id: string) =>
    id === "pa" ? [{ path: "/a" } as Worktree] : ([{ path: "/b" }, { path: "/b/wt-1" }] as Worktree[]),
  );
  vi.mocked(listPins).mockResolvedValue([]);
  vi.mocked(loadSetting).mockResolvedValue(null);
  await useWorktrees.getState().load(projectA);
  await useWorktrees.getState().ensureProjectWorktrees(projectB);

  useWorktrees.getState().selectCachedWorktree("pb", "/b/wt-1");
  expect(useWorktrees.getState().byProject["pb"]?.activePath).toBe("/b/wt-1");
  expect(useWorktrees.getState().activePath).toBe("/a");

  useWorktrees.getState().selectCachedWorktree("pb", "/nope");
  expect(useWorktrees.getState().byProject["pb"]?.activePath).toBe("/b/wt-1");
});

it("selectCachedWorktree refuses while an editor buffer is dirty", async () => {
  const projectB = { id: "pc", localPath: "/c" } as Project;
  vi.mocked(listWorktrees).mockResolvedValue([{ path: "/c" }, { path: "/c/wt-1" }] as Worktree[]);
  vi.mocked(listPins).mockResolvedValue([]);
  vi.mocked(loadSetting).mockResolvedValue(null);
  await useWorktrees.getState().ensureProjectWorktrees(projectB);
  expect(useWorktrees.getState().byProject["pc"]?.activePath).toBe("/c");

  useFiles.setState({ dirty: { "x.ts": true } });
  useWorktrees.getState().selectCachedWorktree("pc", "/c/wt-1");
  expect(useWorktrees.getState().byProject["pc"]?.activePath).toBe("/c");
  useFiles.setState({ dirty: {} });
  useWorktrees.getState().selectCachedWorktree("pc", "/c/wt-1");
  expect(useWorktrees.getState().byProject["pc"]?.activePath).toBe("/c/wt-1");
});
