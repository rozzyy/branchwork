import { fireEvent, render, screen, within } from "@testing-library/react";
import { TitleBar } from "./TitleBar";
import { useRepos } from "../state/repos";
import type { Project } from "../ipc/catalog";

const projects: Project[] = [
  { id: "p1", owner: null, name: "Alpha", localPath: "/a", groupId: null },
  { id: "p2", owner: null, name: "Beta", localPath: "/b", groupId: null },
];

beforeEach(() => {
  useRepos.setState({ groups: [], projects: [], activeGroupId: null, activeProjectId: null, openProjectIds: [], status: "idle", error: null });
});

it("renders nothing when there are no projects", () => {
  render(<TitleBar />);
  expect(screen.queryByRole("list", { name: "Projects" })).toBeNull();
});

it("renders a tab per project and selects on click", () => {
  useRepos.setState({ projects, activeProjectId: "p1", openProjectIds: ["p1", "p2"], status: "ready" });
  const { container } = render(<TitleBar />);
  const tabs = Array.from(container.querySelectorAll(".project-tab"));
  expect(tabs.map((tab) => tab.textContent)).toEqual(["Alpha", "Beta"]);
  expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute("aria-current", "true");

  fireEvent.click(screen.getByRole("button", { name: "Beta" }));
  expect(useRepos.getState().activeProjectId).toBe("p2");
});

it("only shows open tabs", () => {
  useRepos.setState({ projects, activeProjectId: "p1", openProjectIds: ["p1"], status: "ready" });
  const { container } = render(<TitleBar />);
  expect(Array.from(container.querySelectorAll(".project-tab")).map((tab) => tab.textContent)).toEqual(["Alpha"]);
});

it("the project list has one item per project, each with exactly a project button and a close button, and marks the active one", () => {
  useRepos.setState({ projects, activeProjectId: "p1", openProjectIds: ["p1", "p2"], status: "ready" });
  render(<TitleBar />);
  const list = screen.getByRole("list", { name: "Projects" });
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  for (const item of items) {
    expect(within(item).getAllByRole("button")).toHaveLength(2); // the project button and its × close button
  }
  expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute("aria-current", "true");
  expect(screen.getByRole("button", { name: "Beta" })).not.toHaveAttribute("aria-current");
});

it("clicking the close button hides the tab and does not select it", () => {
  useRepos.setState({ projects, activeProjectId: "p1", openProjectIds: ["p1", "p2"], status: "ready" });
  const { container } = render(<TitleBar />);
  fireEvent.click(screen.getByRole("button", { name: "Close tab Beta" }));
  expect(Array.from(container.querySelectorAll(".project-tab")).map((tab) => tab.textContent)).toEqual(["Alpha"]);
  expect(useRepos.getState().activeProjectId).toBe("p1");
});
