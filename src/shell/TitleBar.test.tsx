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

it("shows the theme-adaptive brand mark next to the app name", () => {
  const { container } = render(<TitleBar />);
  const mark = container.querySelector(".app-mark");
  expect(mark).not.toBeNull();
  expect(mark?.getAttribute("aria-hidden")).toBe("true");
  expect(screen.getByText("Branchwork")).toBeInTheDocument();
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
