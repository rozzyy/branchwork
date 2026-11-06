import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GroupSwitcher, GroupSwitcherAddButton, useSwitcher } from "./GroupSwitcher";
import { DialogHost } from "../ui/dialog";
import { useRepos } from "../state/repos";
import { useToasts } from "../ui/toast";
import {
  cloneRepository,
  deleteGroup as deleteGroupIpc,
  deleteProject as deleteProjectIpc,
  isRepository,
  openRepository,
  pickFolder,
  saveGroup as saveGroupIpc,
  saveProject as saveProjectIpc,
  type Group,
  type Project,
} from "../ipc/catalog";

vi.mock("../ipc/catalog", () => ({
  saveGroup: vi.fn(),
  deleteGroup: vi.fn(),
  saveProject: vi.fn(),
  deleteProject: vi.fn(),
  isRepository: vi.fn(),
  openRepository: vi.fn(),
  pickFolder: vi.fn(),
  cloneRepository: vi.fn(),
}));

const groups: Group[] = [{ id: "g1", name: "Acme", color: "oklch(.68 .19 250)", clonePathTemplate: "~/clients/{repo}" }];
const projects: Project[] = [
  { id: "p1", owner: "acme", name: "api", localPath: "/repos/api", groupId: "g1" },
  { id: "p2", owner: null, name: "scratch", localPath: "/repos/scratch", groupId: null },
];

function setup() {
  useRepos.setState({ groups, projects, activeGroupId: "g1", activeProjectId: "p1", status: "ready", error: null });
  return render(
    <>
      <GroupSwitcher />
      <GroupSwitcherAddButton />
      <DialogHost />
    </>,
  );
}

beforeEach(() => {
  useRepos.setState({ groups: [], projects: [], activeGroupId: null, activeProjectId: null, collapsedGroupIds: [], status: "idle", error: null });
  useToasts.setState({ toasts: [] });
  useSwitcher.setState({ open: false });
  vi.mocked(saveGroupIpc).mockResolvedValue(undefined);
  vi.mocked(deleteGroupIpc).mockResolvedValue(true);
  vi.mocked(saveProjectIpc).mockResolvedValue(undefined);
  vi.mocked(deleteProjectIpc).mockResolvedValue(true);
  vi.mocked(openRepository).mockReset();
  vi.mocked(isRepository).mockResolvedValue(false);
  vi.mocked(pickFolder).mockReset();
  vi.mocked(cloneRepository).mockReset();
});

it("search filters groups and projects, including Ungrouped", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  const popover = await screen.findByRole("dialog", { name: "Search groups and projects" });
  const search = within(popover).getByRole("textbox", { name: "Search groups and projects" });

  await userEvent.type(search, "scratch");
  expect(within(popover).queryByText("Acme")).not.toBeInTheDocument();
  expect(within(popover).queryByText("acme/api")).not.toBeInTheDocument();
  expect(within(popover).getByText("Ungrouped")).toBeInTheDocument();
  expect(within(popover).getByText("scratch")).toBeInTheDocument();
});

it("a project with an unknown groupId appears under Ungrouped", async () => {
  const orphan: Project = { id: "p-orphan", owner: null, name: "orphan", localPath: "/repos/orphan", groupId: "ghost" };
  useRepos.setState({ groups, projects: [...projects, orphan], activeGroupId: "g1", activeProjectId: "p1", status: "ready", error: null });
  render(
    <>
      <GroupSwitcher />
      <GroupSwitcherAddButton />
      <DialogHost />
    </>,
  );
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  const popover = await screen.findByRole("dialog", { name: "Search groups and projects" });

  const ungroupedSection = within(popover).getByText("Ungrouped").closest(".group-sec") as HTMLElement;
  expect(within(ungroupedSection).getByText("orphan")).toBeInTheDocument();
  const acmeSection = within(popover).getByRole("button", { name: "Acme" }).closest(".group-sec") as HTMLElement;
  expect(within(acmeSection).queryByText("orphan")).not.toBeInTheDocument();
});

it("selecting a project selects it and closes the popover", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  await userEvent.click(await screen.findByText("scratch"));
  expect(useRepos.getState().activeProjectId).toBe("p2");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("Open repository registers the chosen project under Ungrouped", async () => {
  vi.mocked(pickFolder).mockResolvedValue("/repos/new-repo");
  vi.mocked(openRepository).mockResolvedValue({ id: "new", owner: null, name: "new-repo", localPath: "/x/new-repo", groupId: null });
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Open repository…" }));

  expect(pickFolder).toHaveBeenCalledWith("Open repository");
  await waitFor(() => expect(openRepository).toHaveBeenCalledWith("/repos/new-repo"));
  expect(saveProjectIpc).not.toHaveBeenCalled();
  expect(useRepos.getState().projects.find((project) => project.id === "new")?.groupId).toBeNull();
  expect(useRepos.getState().activeProjectId).toBe("new");
  expect(useRepos.getState().activeGroupId).toBeNull();
});

it("cancelling the folder picker does nothing", async () => {
  vi.mocked(pickFolder).mockResolvedValue(null);
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Open repository…" }));

  await waitFor(() => expect(pickFolder).toHaveBeenCalled());
  expect(openRepository).not.toHaveBeenCalled();
});

it("adds a repository to a group, expands the section, and selects it", async () => {
  vi.mocked(pickFolder).mockResolvedValue("/repos/new-repo");
  vi.mocked(openRepository).mockResolvedValue({ id: "new", owner: null, name: "new-repo", localPath: "/repos/new-repo", groupId: null });
  setup();
  act(() => useRepos.setState({ collapsedGroupIds: ["g1"] }));
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  const popover = await screen.findByRole("dialog", { name: "Search groups and projects" });
  const section = within(popover).getByRole("button", { name: "Add repository to Acme" }).closest(".group-sec") as HTMLElement;

  await userEvent.click(within(section).getByRole("button", { name: "Add repository to Acme" }));

  expect(pickFolder).toHaveBeenCalledWith("Open repository");
  await waitFor(() => expect(openRepository).toHaveBeenCalledWith("/repos/new-repo"));
  await waitFor(() =>
    expect(saveProjectIpc).toHaveBeenCalledWith({
      id: "new",
      owner: null,
      name: "new-repo",
      localPath: "/repos/new-repo",
      groupId: "g1",
    }),
  );
  expect(useRepos.getState().activeProjectId).toBe("new");
  expect(useRepos.getState().activeGroupId).toBe("g1");
  expect(useRepos.getState().collapsedGroupIds).not.toContain("g1");
  expect(within(section).getByText("new-repo")).toBeInTheDocument();
});

it("cancelling Add repository leaves projects and selection unchanged", async () => {
  vi.mocked(pickFolder).mockResolvedValue(null);
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  const popover = await screen.findByRole("dialog", { name: "Search groups and projects" });
  await userEvent.click(within(popover).getByRole("button", { name: "Add repository to Acme" }));

  await waitFor(() => expect(pickFolder).toHaveBeenCalled());
  expect(openRepository).not.toHaveBeenCalled();
  expect(saveProjectIpc).not.toHaveBeenCalled();
  expect(useRepos.getState().activeProjectId).toBe("p1");
});

it("clone entry point prefills the destination from the group's clone path template", async () => {
  vi.mocked(cloneRepository).mockResolvedValue({ id: "new", owner: null, name: "new-repo", localPath: "/x/new-repo", groupId: null });
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Clone repository…" }));
  const urlDialog = await screen.findByRole("dialog", { name: "Clone repository" });
  await userEvent.type(within(urlDialog).getByRole("textbox"), "https://github.com/acme/new-repo.git{Enter}");

  const destDialog = await screen.findByRole("dialog", { name: "Clone destination" });
  const destInput = within(destDialog).getByRole("textbox") as HTMLInputElement;
  expect(destInput.value).toBe("~/clients/new-repo");
  await userEvent.keyboard("{Escape}"); // cancel; retry with a repo name containing regex replacement patterns

  await userEvent.click(await screen.findByRole("button", { name: "Clone repository…" }));
  const urlDialog2 = await screen.findByRole("dialog", { name: "Clone repository" });
  await userEvent.type(within(urlDialog2).getByRole("textbox"), "https://github.com/acme/weird-$&-repo.git{Enter}");

  const destDialog2 = await screen.findByRole("dialog", { name: "Clone destination" });
  const destInput2 = within(destDialog2).getByRole("textbox") as HTMLInputElement;
  expect(destInput2.value).toBe("~/clients/weird-$&-repo");

  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(cloneRepository).toHaveBeenCalledWith("https://github.com/acme/weird-$&-repo.git", "~/clients/weird-$&-repo"));
});

it("new group form hides clone-folder controls and saves the default clone folder", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  await userEvent.click(await screen.findByRole("button", { name: "New group" }));

  expect(screen.queryByRole("textbox", { name: "Folder for new clones" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Browse…" })).not.toBeInTheDocument();

  await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Clients");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(saveGroupIpc).toHaveBeenCalledWith(expect.objectContaining({ name: "Clients", clonePathTemplate: "~/clients/{repo}" })),
  );
});

it("editing a group: cancelling Browse keeps its existing clone folder", async () => {
  vi.mocked(pickFolder).mockResolvedValue(null);
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Edit group" }));

  const folderInput = screen.getByRole("textbox", { name: "Folder for new clones" }) as HTMLInputElement;
  await userEvent.click(screen.getByRole("button", { name: "Browse…" }));
  await waitFor(() => expect(pickFolder).toHaveBeenCalled());
  expect(folderInput.value).toBe("~/clients");
});

it("editing a group displays its clone folder without the /{repo} suffix", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Edit group" }));

  const folderInput = screen.getByRole("textbox", { name: "Folder for new clones" }) as HTMLInputElement;
  expect(folderInput.value).toBe("~/clients");
});

it("shows a warning when the browsed clone folder is a repository", async () => {
  vi.mocked(pickFolder).mockResolvedValue("/repos/existing");
  vi.mocked(isRepository).mockResolvedValue(true);
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Edit group" }));

  await userEvent.click(screen.getByRole("button", { name: "Browse…" }));

  expect(await screen.findByText("This folder is a Git repository. To add it to the group, save the group and use Add repository.")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Folder for new clones" })).toHaveValue("/repos/existing");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(saveGroupIpc).toHaveBeenCalledWith(
      expect.objectContaining({ id: "g1", name: "Acme", clonePathTemplate: "/repos/existing/{repo}" }),
    ),
  );
});

it("does not show a repository warning for an ordinary clone folder", async () => {
  vi.mocked(pickFolder).mockResolvedValue("/repos/parent/new-clones");
  vi.mocked(isRepository).mockResolvedValue(false);
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Edit group" }));

  await userEvent.click(screen.getByRole("button", { name: "Browse…" }));

  await waitFor(() => expect(isRepository).toHaveBeenCalledWith("/repos/parent/new-clones"));
  expect(screen.queryByText("This folder is a Git repository. To add it to the group, save the group and use Add repository.")).not.toBeInTheDocument();
});

it("deleting a group ungroups its projects, and Undo restores it", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Delete group" }));
  const confirmDialog = await screen.findByRole("dialog", { name: /Delete/ });
  await userEvent.click(within(confirmDialog).getByRole("button", { name: "Delete group" }));

  await waitFor(() => expect(useRepos.getState().groups).toEqual([]));
  expect(useRepos.getState().projects.find((p) => p.id === "p1")?.groupId).toBeNull();

  const action = useToasts.getState().toasts[0]?.action;
  expect(action).toBeTruthy();
  await act(async () => action!.run());
  await waitFor(() => expect(useRepos.getState().groups).toEqual(groups));
  expect(useRepos.getState().projects.find((p) => p.id === "p1")?.groupId).toBe("g1");
});

it("removing a project: confirm hides the row, Undo brings it back", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  const row = screen.getByText("acme/api").closest(".group-row") as HTMLElement;
  await userEvent.click(within(row).getByRole("button", { name: "Move to…" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove from Branchwork…" }));

  const confirmDialog = await screen.findByRole("dialog", { name: /Remove/ });
  await userEvent.click(within(confirmDialog).getByRole("button", { name: "Remove" }));

  await waitFor(() => expect(deleteProjectIpc).toHaveBeenCalledWith("p1"));
  expect(screen.queryByText("acme/api")).not.toBeInTheDocument();

  const action = useToasts.getState().toasts[0]?.action;
  expect(action).toBeTruthy();
  await act(async () => action!.run());
  await waitFor(() => expect(screen.getByText("acme/api")).toBeInTheDocument());
});

it("cancelling the remove confirmation leaves the project in place", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  const row = screen.getByText("acme/api").closest(".group-row") as HTMLElement;
  await userEvent.click(within(row).getByRole("button", { name: "Move to…" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove from Branchwork…" }));

  const confirmDialog = await screen.findByRole("dialog", { name: /Remove/ });
  await userEvent.click(within(confirmDialog).getByRole("button", { name: "Cancel" }));

  expect(deleteProjectIpc).not.toHaveBeenCalled();
  expect(screen.getByText("acme/api")).toBeInTheDocument();
});

it("collapsing a group hides its project rows and flips aria-expanded", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  const popover = await screen.findByRole("dialog", { name: "Search groups and projects" });
  const toggle = within(popover).getByRole("button", { name: "Acme" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(within(popover).getByText("acme/api")).toBeInTheDocument();

  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(within(popover).queryByText("acme/api")).not.toBeInTheDocument();
  expect(within(popover).getByText("Acme · 1")).toBeInTheDocument();

  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(within(popover).getByText("acme/api")).toBeInTheDocument();
});

it("search shows matches inside a collapsed group without changing its collapsed state", async () => {
  setup();
  act(() => useRepos.setState({ activeGroupId: null, activeProjectId: "p2" })); // active project outside g1, so selecting p1 below is a real switch
  await userEvent.click(screen.getByRole("button", { name: /Ungrouped/ }));
  const popover = await screen.findByRole("dialog", { name: "Search groups and projects" });
  const toggle = within(popover).getByRole("button", { name: "Acme" });
  await userEvent.click(toggle);
  expect(useRepos.getState().collapsedGroupIds).toEqual(["g1"]);

  const search = within(popover).getByRole("textbox", { name: "Search groups and projects" });
  await userEvent.type(search, "api");
  expect(within(popover).getByText("acme/api")).toBeInTheDocument();

  await userEvent.click(within(popover).getByText("acme/api"));
  expect(useRepos.getState().activeProjectId).toBe("p1");
  expect(useRepos.getState().collapsedGroupIds).toEqual(["g1"]);
});

it("the chip's accessible name is distinct from the group-section toggle's", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Acme/ }));
  await screen.findByRole("dialog", { name: "Search groups and projects" });
  expect(screen.getAllByRole("button", { name: "Acme" })).toHaveLength(1); // only the section toggle, not the chip too
});

it("clicking the chip again closes the popover", async () => {
  setup();
  const chip = screen.getByRole("button", { name: /Acme/ });
  await userEvent.click(chip);
  await screen.findByRole("dialog", { name: "Search groups and projects" });

  await userEvent.click(chip);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(chip).toHaveAttribute("aria-expanded", "false");
});

it("Escape closes the popover and refocuses the chip", async () => {
  setup();
  const chip = screen.getByRole("button", { name: /Acme/ });
  await userEvent.click(chip);
  await screen.findByRole("dialog", { name: "Search groups and projects" });

  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(chip).toHaveFocus();
});
