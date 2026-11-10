import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { BusyButton } from "./BusyButton";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((run) => {
    resolve = run;
  });
  return { promise, resolve };
}

it("disables with a loader while the action runs, then re-enables", async () => {
  const gate = deferred<string>();
  render(<BusyButton onExecute={() => gate.promise}>Log in</BusyButton>);
  const button = screen.getByRole("button", { name: "Log in" });
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(document.querySelector(".spin")).not.toBeNull();
  // Extra clicks while busy are ignored, never double-run.
  fireEvent.click(button);
  gate.resolve("done");
  await screen.findByRole("button", { name: "Log in" });
  expect(screen.getByRole("button", { name: "Log in" })).toBeEnabled();
  expect(document.querySelector(".spin")).toBeNull();
});

it("recovers to enabled when the action rejects", async () => {
  render(
    <BusyButton
      onExecute={() => {
        throw new Error("nope");
      }}
    >
      Retry
    </BusyButton>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "Retry" })).toBeEnabled();
  expect(document.querySelector(".spin")).toBeNull();
});
