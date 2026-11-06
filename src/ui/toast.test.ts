import { toast, useToasts } from "./toast";

beforeEach(() => useToasts.setState({ toasts: [] }));

it("adds a toast and auto-dismisses it after 4.2s", () => {
  vi.useFakeTimers();
  toast({ title: "Saved" });
  expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(["Saved"]);
  vi.advanceTimersByTime(4200);
  expect(useToasts.getState().toasts).toEqual([]);
  vi.useRealTimers();
});

it("dismisses a toast by id", () => {
  const id = toast({ title: "A" });
  toast({ title: "B" });
  useToasts.getState().dismiss(id);
  expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(["B"]);
});
