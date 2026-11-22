import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ViewsMenu } from "./ViewsMenu";
import { useStage, stageSnapshot } from "../state/stage";
import { initialStage, layoutOf } from "../stage/stageModel";
import { useSessions } from "../agents/sessions";

beforeEach(() => {
  useStage.setState(stageSnapshot(initialStage));
  useSessions.setState({ loaded: true, sessions: [] });
});

it("offers every screen under Views and navigates to the selected screen", async () => {
  const user = userEvent.setup();
  render(<ViewsMenu />);

  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Views" }));

  for (const name of ["Home", "Changes", "History", "Files", "Agents", "Terminal", "GitHub", "Browser", "Resolve conflicts", "Settings"]) {
    expect(screen.getByRole("menuitem", { name })).toBeVisible();
  }
  await user.click(screen.getByRole("menuitem", { name: "Changes" }));
  expect(useStage.getState().panes).toEqual(["changes"]);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("opens the screen modal from the new-tab button and creates the selected tab", async () => {
  const user = userEvent.setup();
  render(<ViewsMenu mode="newTab" />);

  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "New tab" }));
  expect(useStage.getState().tabs).toHaveLength(1);
  expect(screen.getByRole("menu", { name: "Views" })).toBeVisible();

  await user.click(screen.getByRole("menuitem", { name: "Changes" }));
  expect(useStage.getState().tabs).toHaveLength(2);
  expect(useStage.getState().panes).toEqual(["changes"]);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("preserves modifier-click split behavior", async () => {
  render(<ViewsMenu />);
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Changes" }), { metaKey: true });
  expect(useStage.getState().panes).toEqual(["home", "changes"]);

  useStage.setState(stageSnapshot(initialStage));
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "History" }), { altKey: true });
  expect(useStage.getState()).toMatchObject({ panes: ["home", "history"], dir: "v" });
});

it("keeps context-menu split and new-tab actions available", async () => {
  const user = userEvent.setup();
  render(<ViewsMenu />);
  act(() => {
    useStage.getState().go("agents");
    useStage.getState().openSplit("changes", "right");
  });
  const active = useStage.getState().activeTabId;

  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  fireEvent.contextMenu(screen.getByRole("menuitem", { name: "History" }));
  await user.click(screen.getByRole("menuitem", { name: "Open in new tab" }));
  expect(useStage.getState().panes).toEqual(["history"]);
  act(() => useStage.getState().activateTab(active));
  expect(useStage.getState().panes).toEqual(["agents", "changes"]);

  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  fireEvent.contextMenu(screen.getByRole("menuitem", { name: "History" }));
  await user.click(screen.getByRole("menuitem", { name: "Split left" }));
  expect(useStage.getState().panes).toEqual(["agents", "history", "changes"]);
});

it("shows pane indicators and waiting-agent badges", () => {
  useStage.setState(stageSnapshot(layoutOf(["agents", "changes"])));
  useSessions.setState({
    sessions: [{
      id: "a1",
      cliId: "codex",
      profile: { cliId: "codex", slug: "work" },
      worktreePath: "/wt/a",
      sessionId: "pty-1",
      slot: "auto",
      error: null,
      sharedWithDock: false,
      status: "waiting",
      limitHit: false,
      conversationId: null,
      savers: { rtk: "unsupported", caveman: "unsupported" },
    }],
  });
  render(<ViewsMenu />);
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  expect(screen.getByRole("status", { name: "1 agents waiting for input" })).toHaveTextContent("1");
  expect(screen.getByRole("menuitem", { name: /Agents/ })).toHaveTextContent("◧");
  expect(screen.getByRole("menuitem", { name: /Changes/ })).toHaveTextContent("◨");
});
