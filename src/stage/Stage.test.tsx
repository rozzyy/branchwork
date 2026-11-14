import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Stage } from "./Stage";
import { useStage, stageSnapshot } from "../state/stage";
import { initialStage } from "./stageModel";
import { useRepos } from "../state/repos";
import { useGithubAccounts } from "../github/store";
import { useSessions } from "../agents/sessions";

beforeEach(() => {
  useStage.setState(stageSnapshot(initialStage));
  useRepos.setState({ status: "ready", projects: [], groups: [], activeProjectId: null, activeGroupId: null });
  useGithubAccounts.setState({ loaded: true, accounts: [], defaultAccount: null, ownerAccounts: {} });
  useSessions.setState({ loaded: true, sessions: [] });
});

it("opens a split from Open beside and closes it from the pane", async () => {
  render(<Stage />);
  await userEvent.click(screen.getByRole("button", { name: /Open beside/ }));
  await userEvent.click(screen.getAllByRole("menuitem").find((item) => item.querySelector(".menu-label")?.textContent === "Changes")!);
  expect(screen.getByRole("heading", { level: 1, name: /^Home/ })).toBeInTheDocument();
  expect(screen.getByRole("separator")).toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: "Close pane" })[1]);
  expect(screen.getByRole("heading", { level: 1, name: /^Home/ })).toBeInTheDocument();
});

it("opens a bottom split from the direction icon", async () => {
  render(<Stage />);
  await userEvent.click(screen.getByRole("button", { name: /Open beside/ }));
  const item = screen.getAllByRole("menuitem").find((entry) => entry.querySelector(".menu-label")?.textContent === "History")!;
  await userEvent.click(item.querySelector('[title="Split bottom"]')!);
  expect(useStage.getState().panes).toEqual(["home", "history"]);
  expect(useStage.getState().dir).toBe("v");
});

it("builds three panes from Open beside and closes the middle one", async () => {
  render(<Stage />);
  await userEvent.click(screen.getByRole("button", { name: /Open beside/ }));
  await userEvent.click(screen.getAllByRole("menuitem").find((item) => item.querySelector(".menu-label")?.textContent === "Changes")!);
  // Split the Changes pane (index 1) again from its own control.
  await userEvent.click(screen.getAllByRole("button", { name: "Open beside" })[1]);
  await userEvent.click(screen.getAllByRole("menuitem").find((item) => item.querySelector(".menu-label")?.textContent === "History")!);
  expect(useStage.getState().panes).toEqual(["home", "changes", "history"]);
  expect(screen.getAllByRole("separator")).toHaveLength(2);
  await userEvent.click(screen.getAllByRole("button", { name: "Close pane" })[1]);
  expect(useStage.getState().panes).toEqual(["home", "history"]);
});

it("keeps the existing pane mounted when splitting and closing", async () => {
  const { container } = render(<Stage />);
  const homePane = container.querySelector("[data-stage-pane]");
  act(() => useStage.getState().openSplit("changes", "right"));
  act(() => useStage.getState().openSplit("history", "bottom"));
  expect(container.querySelector(`[data-stage-pane="${homePane?.getAttribute("data-stage-pane")}"]`)).toBe(homePane);
  act(() => useStage.getState().closePane(1));
  expect(container.querySelector(`[data-stage-pane="${homePane?.getAttribute("data-stage-pane")}"]`)).toBe(homePane);
});
