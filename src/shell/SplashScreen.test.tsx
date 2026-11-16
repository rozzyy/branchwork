import { act, render, screen } from "@testing-library/react";
import { SplashScreen } from "./SplashScreen";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.clearAllTimers(); });

it("shows the logo mark and app name, then fades out", () => {
  render(<SplashScreen />);
  const splash = screen.getByRole("status", { name: "Branchwork" });
  expect(splash.querySelector(".splash-mark")).toBeInTheDocument();
  expect(screen.getByText("Branchwork")).toBeInTheDocument();
  expect(splash.querySelector(".splash-bar")).toBeInTheDocument();

  act(() => { vi.advanceTimersByTime(800); });
  expect(splash).toHaveClass("splash-leaving");

  act(() => { vi.advanceTimersByTime(320); });
  expect(screen.queryByRole("status", { name: "Branchwork" })).not.toBeInTheDocument();
});
