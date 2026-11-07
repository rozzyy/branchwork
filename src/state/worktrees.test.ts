import { listPins, type Project } from "../ipc/catalog";
import { loadSetting } from "../ipc/settings";
import { listWorktrees, type Worktree } from "../ipc/worktrees";
import { useWorktrees } from "./worktrees";

vi.mock("../ipc/catalog", () => ({ listPins: vi.fn(), pinWorktree: vi.fn(), unpinWorktree: vi.fn() }));
vi.mock("../ipc/settings", () => ({ loadSetting: vi.fn(), saveSetting: vi.fn() }));
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
