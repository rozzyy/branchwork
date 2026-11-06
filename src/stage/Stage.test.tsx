import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Stage } from "./Stage";
import { useStage } from "../state/stage";
import { initialStage } from "./stageModel";

beforeEach(() => useStage.setState({ ...initialStage }));

it("opens a split from the ⊞ menu and closes it from the pane", async () => {
  render(<Stage />);
  await userEvent.click(screen.getByRole("button", { name: /Split with/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Changes/ }));
  expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Launchpad", "Changes"]);
  expect(screen.getByRole("separator")).toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: "Close pane" })[1]);
  expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Launchpad"]);
});

it("opens a bottom split from the direction icon", async () => {
  render(<Stage />);
  await userEvent.click(screen.getByRole("button", { name: /Split with/ }));
  const item = screen.getByRole("menuitem", { name: /Graph/ });
  await userEvent.click(item.querySelector('[title="Split bottom"]')!);
  expect(useStage.getState().panes).toEqual(["launchpad", "graph"]);
  expect(useStage.getState().dir).toBe("v");
});
