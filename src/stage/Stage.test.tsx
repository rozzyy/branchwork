import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Stage } from "./Stage";
import { useStage, stageSnapshot } from "../state/stage";
import { initialStage } from "./stageModel";
import { useRepos } from "../state/repos";
import { useGithubAccounts } from "../github/store";
import { useSessions } from "../agents/sessions";
import { StageTabs } from "./StageTabs";

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

it("does not offer a pane project pin", () => {
  const { container } = render(<Stage />);
  expect(container.querySelector(".pane-pin")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Pin pane/ })).not.toBeInTheDocument();
});

it("adds, renames, cancels and closes stage tabs accessibly", async () => {
  render(<StageTabs />);
  await userEvent.click(screen.getByRole("button", { name: "New tab" }));
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Close tab New tab" })).toBeEnabled();

  const newTab = screen.getByRole("tab", { name: "New tab" });
  await userEvent.click(newTab);
  await userEvent.keyboard("{ArrowLeft}");
  expect(useStage.getState().activeTabId).toBe(useStage.getState().tabs[0].id);
  await waitFor(() => expect(screen.getByRole("tab", { name: "Home" })).toHaveFocus());
  await userEvent.keyboard("{ArrowRight}");
  await waitFor(() => expect(useStage.getState().activeTabId).toBe(useStage.getState().tabs[1].id));

  await userEvent.click(screen.getByRole("tab", { name: "New tab" }));
  await userEvent.keyboard("{F2}");
  const input = screen.getByRole("tab", { name: "Tab name" });
  await userEvent.clear(input);
  await userEvent.keyboard("{Enter}");
  expect(screen.getByText("Enter a name from 1 to 40 characters")).toBeInTheDocument();
  await waitFor(() => expect(input).toHaveFocus());
  await userEvent.type(input, "x".repeat(41));
  await userEvent.keyboard("{Enter}");
  expect(screen.getByText("Enter a name from 1 to 40 characters")).toBeInTheDocument();
  await userEvent.clear(input);
  await userEvent.type(input, "Agent review{Enter}");
  await waitFor(() => expect(screen.getByRole("tab", { name: "Agent review" })).toHaveFocus());
  expect(useStage.getState().tabs.find((tab) => tab.id === useStage.getState().activeTabId)?.name).toBe("Agent review");

  await userEvent.click(screen.getByRole("button", { name: "New tab" }));
  await userEvent.dblClick(screen.getByRole("tab", { name: "New tab" }));
  const cancelInput = screen.getByRole("tab", { name: "Tab name" });
  await userEvent.clear(cancelInput);
  await userEvent.type(cancelInput, "Discard me{Escape}");
  await waitFor(() => expect(screen.getByRole("tab", { name: "New tab" })).toHaveFocus());
  expect(useStage.getState().tabs.find((tab) => tab.id === useStage.getState().activeTabId)?.name).toBe("New tab");

  await userEvent.click(screen.getByRole("button", { name: "Close tab New tab" }));
  expect(useStage.getState().tabs).toHaveLength(2);
  expect(useStage.getState().activeTabId).toBe(useStage.getState().tabs[1].id);
});
