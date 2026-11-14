import { fireEvent, render, screen } from "@testing-library/react";
import { TitleBar } from "./TitleBar";
import { useRepos } from "../state/repos";
import { useSettings } from "../state/settings";
import { DEFAULT_THEME } from "../theme/theme";
import type { Group, Project } from "../ipc/catalog";

const groups: Group[] = [{ id: "g1", name: "Team", color: "oklch(.68 .19 250)", clonePathTemplate: "~/clients/{repo}" }];
const projects: Project[] = [
  { id: "p1", owner: "acme", name: "Alpha", localPath: "/a", groupId: "g1" },
  { id: "p2", owner: null, name: "Beta", localPath: "/b", groupId: null },
];

beforeEach(() => {
  useRepos.setState({ groups: [], projects: [], activeGroupId: null, activeProjectId: null, openProjectIds: [], status: "idle", error: null });
});

it("shows the location crumb instead of brand text, matching the redesign prototype", () => {
  const { container } = render(<TitleBar />);
  expect(container.querySelector(".app-mark")).toBeNull();
  expect(screen.queryByText("Branchwork")).toBeNull();
  expect(screen.getByRole("navigation", { name: "Workspace location" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Search or ask… \(end with \?\)/ })).toBeInTheDocument();
});

it("shows the active group and project in the title bar", () => {
  useRepos.setState({ groups, projects, activeGroupId: "g1", activeProjectId: "p1", status: "ready" });
  render(<TitleBar />);
  expect(screen.getByText("Team")).toBeInTheDocument();
  expect(screen.getByText("acme/Alpha")).toBeInTheDocument();
});

it("shows an empty context when no project is selected", () => {
  render(<TitleBar />);
  expect(screen.getByText("No project selected")).toBeInTheDocument();
});

it("does not show the removed project rail toggle", () => {
  render(<TitleBar />);
  expect(screen.queryByRole("button", { name: "Toggle project sidebar" })).not.toBeInTheDocument();
});

it("toggles the theme from the title bar", () => {
  useSettings.setState({ theme: { ...DEFAULT_THEME, mode: "dark" } });
  render(<TitleBar />);
  fireEvent.click(screen.getByRole("button", { name: "Toggle dark / light" }));
  expect(useSettings.getState().theme.mode).toBe("light");
});
