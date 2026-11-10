import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSidebar } from "./ProjectSidebar";
import { useRepos } from "../state/repos";
import { useSidebar } from "../state/sidebar";
import { useSwitcher } from "./GroupSwitcher";
import type { Group, Project } from "../ipc/catalog";

const groups: Group[] = [{ id: "g1", name: "Acme", color: "oklch(.68 .19 250)", clonePathTemplate: "~/clients/{repo}" }];
const projects: Project[] = [
  { id: "p1", owner: "acme", name: "api", localPath: "/repos/api", groupId: "g1" },
  { id: "p2", owner: null, name: "scratch", localPath: "/repos/scratch", groupId: null },
];

beforeEach(() => {
  useRepos.setState({
    groups,
    projects,
    activeGroupId: "g1",
    activeProjectId: "p1",
    collapsedGroupIds: [],
    status: "ready",
    error: null,
  });
  useSidebar.setState({ collapsed: false, projectRailOpen: true });
  useSwitcher.setState({ open: false });
});

it("filters groups and projects from the rail search", async () => {
  const { container } = render(<ProjectSidebar />);
  await userEvent.type(screen.getByRole("searchbox", { name: "Search groups and projects" }), "scratch");

  expect(screen.getByText("scratch")).toBeInTheDocument();
  const scroll = container.querySelector(".project-sidebar-scroll") as HTMLElement;
  expect(scroll.querySelector(".project-sidebar-project-name")?.textContent).toBe("scratch");
  expect(scroll.querySelector(".project-sidebar-group-name")?.textContent).toBe("Ungrouped");
});

it("selects projects and persists collapsed group state", () => {
  const { container } = render(<ProjectSidebar />);
  fireEvent.click(screen.getByRole("button", { name: /scratch/ }));
  expect(useRepos.getState().activeProjectId).toBe("p2");
  expect(useRepos.getState().activeGroupId).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Collapse Acme" }));
  expect(useRepos.getState().collapsedGroupIds).toContain("g1");
  expect(container.querySelector(".project-sidebar-projects#project-group-g1")).toHaveAttribute("hidden");
  fireEvent.click(screen.getByRole("button", { name: "Expand Acme" }));
  expect(screen.getByText("api")).toBeInTheDocument();
});

it("opens existing group management and project-add flows from the rail", async () => {
  render(<ProjectSidebar />);
  await userEvent.click(screen.getByRole("button", { name: "Manage Acme" }));
  await userEvent.click(await screen.findByRole("button", { name: "Edit group" }));
  expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Acme");

  await waitFor(() => expect(useSwitcher.getState().open).toBe(true));
});

it("opens the existing repository open and clone actions from Project", async () => {
  render(<ProjectSidebar />);
  await userEvent.click(screen.getByRole("button", { name: "Project" }));
  expect(await screen.findByRole("button", { name: "Open repository…" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clone repository…" })).toBeInTheDocument();
});

it("keeps the rail hidden when its persisted visibility is off", () => {
  useSidebar.setState({ projectRailOpen: false });
  const { container } = render(<ProjectSidebar />);
  expect(container.querySelector(".project-sidebar")).toHaveAttribute("hidden");
});
