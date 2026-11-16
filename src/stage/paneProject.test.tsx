import { render, screen } from "@testing-library/react";
import { PaneProjectProvider, usePaneProject, usePaneProjectId } from "./paneProject";
import { useRepos } from "../state/repos";
import type { Project } from "../ipc/catalog";

const projects: Project[] = [
  { id: "p1", owner: null, name: "A", localPath: "/a", groupId: null },
  { id: "p2", owner: null, name: "B", localPath: "/b", groupId: null },
];

function Probe() {
  const id = usePaneProjectId();
  const project = usePaneProject();
  return <span data-testid="probe">{`${id ?? "none"}|${project?.name ?? "none"}`}</span>;
}

beforeEach(() => {
  useRepos.setState({
    groups: [],
    projects,
    activeGroupId: null,
    activeProjectId: "p1",
    openProjectIds: ["p1", "p2"],
    collapsedGroupIds: [],
    recentProjectIds: ["p1"],
    status: "ready",
    error: null,
  });
});

it("ignores pane project pins: panes always follow the global project", () => {
  const { unmount } = render(
    <PaneProjectProvider projectId="p2">
      <Probe />
    </PaneProjectProvider>,
  );
  expect(screen.getByTestId("probe")).toHaveTextContent("p1|A");
  unmount();
  render(
    <PaneProjectProvider projectId={null}>
      <Probe />
    </PaneProjectProvider>,
  );
  expect(screen.getByTestId("probe")).toHaveTextContent("p1|A");
});

it("an unknown pinned project id falls back to the global project", () => {
  render(
    <PaneProjectProvider projectId="ghost">
      <Probe />
    </PaneProjectProvider>,
  );
  expect(screen.getByTestId("probe")).toHaveTextContent("p1|A");
});
