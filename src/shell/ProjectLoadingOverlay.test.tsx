import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectLoadingOverlay } from "./ProjectLoadingOverlay";

afterEach(() => vi.useRealTimers());

describe("ProjectLoadingOverlay", () => {
  it("blocks the main area while loading and fades away when loading ends", () => {
    vi.useFakeTimers();
    const view = render(<ProjectLoadingOverlay loading />);
    expect(screen.getByRole("status", { name: "Loading project…" })).toBeInTheDocument();
    expect(document.querySelector(".spin")).toBeInTheDocument();

    view.rerender(<ProjectLoadingOverlay loading={false} />);
    expect(screen.getByRole("status")).toHaveClass("leaving");
    act(() => vi.advanceTimersByTime(140));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
