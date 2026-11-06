import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ask, DialogHost } from "./dialog";

it("resolves true when confirmed", async () => {
  render(<DialogHost />);
  let p!: Promise<unknown>;
  act(() => { p = ask({ title: "Push 2 commits?", ok: "Push" }); });
  await userEvent.click(await screen.findByRole("button", { name: "Push" }));
  await expect(p).resolves.toBe(true);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("resolves null on Escape", async () => {
  render(<DialogHost />);
  let p!: Promise<unknown>;
  act(() => { p = ask({ title: "Discard?", danger: true }); });
  await screen.findByRole("dialog");
  await userEvent.keyboard("{Escape}");
  await expect(p).resolves.toBeNull();
});

it("returns the trimmed input value on Enter", async () => {
  render(<DialogHost />);
  let p!: Promise<unknown>;
  act(() => { p = ask({ title: "New file", input: "src/a.ts" }); });
  const box = await screen.findByRole("textbox");
  await userEvent.clear(box);
  await userEvent.type(box, "  src/b.ts {Enter}");
  await expect(p).resolves.toBe("src/b.ts");
});
