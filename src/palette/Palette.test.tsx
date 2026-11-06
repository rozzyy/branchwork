import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Palette } from "./Palette";
import { usePalette } from "./store";
import { useStage } from "../state/stage";
import { initialStage } from "../stage/stageModel";
import { useToasts } from "../ui/toast";

beforeEach(() => {
  useStage.setState({ ...initialStage });
  usePalette.setState({ open: true, query: "" });
  useToasts.setState({ toasts: [] });
});

it("filters commands and runs the selected one with Enter", async () => {
  render(<Palette />);
  await userEvent.type(screen.getByRole("combobox"), "go changes");
  expect(screen.getAllByRole("option")[0]).toHaveTextContent("Go to Changes");
  await userEvent.keyboard("{Enter}");
  expect(useStage.getState().panes).toEqual(["changes"]);
  expect(usePalette.getState().open).toBe(false);
});

it("moves the selection with arrow keys", async () => {
  render(<Palette />);
  await userEvent.type(screen.getByRole("combobox"), "split bottom graph");
  await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  expect(useStage.getState()).toMatchObject({ panes: ["launchpad", "graph"], dir: "v" });
});

it("turns a trailing ? into an Ask Claude command", async () => {
  render(<Palette />);
  await userEvent.type(screen.getByRole("combobox"), "what changed?");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option")).toHaveTextContent("Ask Claude: what changed?");
});

it("closes on Escape", async () => {
  render(<Palette />);
  await userEvent.keyboard("{Escape}");
  expect(usePalette.getState().open).toBe(false);
});
