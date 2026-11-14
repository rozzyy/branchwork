import { fireEvent, render, screen } from "@testing-library/react";
import { HistoryToolbar, HistoryView } from "./HistoryScreen";
import { openHistory, useHistory } from "../../state/history";
import { useStage } from "../../state/stage";

vi.mock("../graph/GraphScreen", () => ({
  GraphToolbar: () => <div>Graph toolbar</div>,
  GraphView: () => <div>Graph view</div>,
}));
vi.mock("../blame/BlameScreen", () => ({
  BlameToolbar: () => <div>Blame toolbar</div>,
  BlameView: () => <div>Blame view</div>,
}));
vi.mock("../rebase/RebaseScreen", () => ({
  RebaseToolbar: () => <div>Rewrite toolbar</div>,
  RebaseView: () => <div>Rewrite view</div>,
}));

beforeEach(() => {
  useStage.setState({ ...useStage.getState(), panes: ["home"], focus: 0 });
  useHistory.setState({ mode: "graph", file: null });
});

it("switches History modes and renders the matching view", () => {
  render(<><HistoryToolbar /><HistoryView /></>);
  expect(screen.getByText("Graph view")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "File history · blame" }));
  expect(screen.getByText("Blame view")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Rewrite history" }));
  expect(screen.getByText("Rewrite view")).toBeInTheDocument();
});

it("openHistory selects File history for the requested path", () => {
  openHistory("file", { path: "a.ts", line: 7 });
  expect(useHistory.getState()).toMatchObject({ mode: "file", file: { path: "a.ts", line: 7 } });
  expect(useStage.getState().panes).toEqual(["history"]);
});
