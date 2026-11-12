import { act, render, screen } from "@testing-library/react";
import { subscribeUndoState } from "../ipc/undo";
import { Toaster, useToasts } from "./toast";

const eventState = vi.hoisted(() => ({
  callback: null as null | ((event: { payload: { undoable: boolean } }) => void),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, callback: typeof eventState.callback) => {
    eventState.callback = callback;
    return vi.fn();
  }),
}));

beforeEach(() => {
  eventState.callback = null;
  useToasts.setState({ toasts: [], lastUndoable: null });
});

it("updates the toast Undo action from op:done undoable state", async () => {
  await subscribeUndoState();
  useToasts.getState().push({
    title: "Deleted file",
    action: { label: "Undo", undo: true, enabled: true, run: vi.fn() },
  });
  render(<Toaster />);

  act(() => eventState.callback?.({ payload: { undoable: false } }));
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();

  act(() => eventState.callback?.({ payload: { undoable: true } }));
  expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
});

it("shows stderr behind a Show details disclosure", async () => {
  useToasts.getState().push({ title: "Push failed", details: "remote: rejected by hook" });
  render(<Toaster />);

  const summary = screen.getByText("Show details");
  expect(summary.closest("details")).not.toHaveAttribute("open");
  act(() => summary.click());
  expect(summary.closest("details")).toHaveAttribute("open");
  expect(screen.getByText("remote: rejected by hook")).toBeInTheDocument();
});
