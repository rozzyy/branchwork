import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import { useStage } from "../state/stage";
import { initialStage } from "../stage/stageModel";

beforeEach(() => useStage.setState({ ...initialStage }));

it("⌘-click opens a right split, ⌥-click a bottom split", async () => {
  render(<Sidebar />);
  fireEvent.click(screen.getByRole("button", { name: /Changes/ }), { metaKey: true });
  expect(useStage.getState().panes).toEqual(["launchpad", "changes"]);
  useStage.setState({ ...initialStage });
  fireEvent.click(screen.getByRole("button", { name: /Graph/ }), { altKey: true });
  expect(useStage.getState()).toMatchObject({ panes: ["launchpad", "graph"], dir: "v" });
});

it("context menu offers split directions", async () => {
  render(<Sidebar />);
  fireEvent.contextMenu(screen.getByRole("button", { name: /Agents/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Split left/ }));
  expect(useStage.getState().panes).toEqual(["agents", "launchpad"]);
});

it("shows position glyphs for both split screens", () => {
  useStage.setState({ ...initialStage, panes: ["agents", "changes"] });
  render(<Sidebar />);
  expect(screen.getByRole("button", { name: /Agents/ })).toHaveTextContent("◧");
  expect(screen.getByRole("button", { name: /Changes/ })).toHaveTextContent("◨");
});
