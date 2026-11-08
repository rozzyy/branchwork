import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DiffModel, Hunk } from "../ipc/bindings";
import { DiffRenderer } from "./DiffRenderer";

function hunk(newStart: number, lines: Hunk["lines"] = []): Hunk {
  return {
    oldStart: newStart,
    newStart,
    oldLines: lines.filter((line) => line.kind !== "add").length,
    newLines: lines.filter((line) => line.kind !== "del").length,
    lines,
  };
}

function model(hunks: Hunk[]): DiffModel {
  return { hunks, binary: false, truncated: false, bytes: 128 };
}

const changedHunk = hunk(3, [
  { kind: "del", old: 3, new: null, text: "old value", intra: [{ start: 4, end: 9, kind: "del" }] },
  { kind: "add", old: null, new: 3, text: "new value", intra: [{ start: 4, end: 9, kind: "add" }] },
]);

describe("DiffRenderer", () => {
  it("renders split and inline line layouts, pairing a del/add run into one row", () => {
    const split = render(<DiffRenderer model={model([changedHunk])} mode="split" area="unstaged" />);
    expect(split.container.querySelector(".diff-inline-line")).toBeNull();
    const rows = split.container.querySelectorAll(".diff-split-line");
    expect(rows).toHaveLength(1); // del + add share one row, not two staggered rows
    const cells = rows[0].querySelectorAll(".diff-cell");
    expect(cells[0]).toHaveTextContent("old value");
    expect(cells[1]).toHaveTextContent("new value");

    const inline = render(<DiffRenderer model={model([changedHunk])} mode="inline" area="unstaged" />);
    expect(inline.container.querySelector(".diff-inline-line")).not.toBeNull();
    expect(inline.container.querySelector(".diff-split-line")).toBeNull();
    expect(inline.container.querySelector(".diff-cell-del")?.textContent).toContain("−");
    expect(inline.container.querySelector(".diff-cell-add")?.textContent).toContain("+");
  });

  it("renders intraline spans as marked text", () => {
    const { container } = render(
      <DiffRenderer model={model([changedHunk])} mode="inline" area="unstaged" />,
    );
    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
      "value",
      "value",
    ]);
  });

  it("dims off-area hunks and labels each hunk's area", () => {
    const { container } = render(
      <DiffRenderer
        area="unstaged"
        hunkAreas={["staged", "unstaged"]}
        mode="inline"
        model={model([changedHunk, hunk(10, changedHunk.lines)])}
      />,
    );
    const hunks = container.querySelectorAll(".diff-hunk");
    expect(hunks[0]).toHaveAttribute("data-dimmed", "true");
    expect(hunks[1]).toHaveAttribute("data-dimmed", "false");
    expect(within(hunks[0] as HTMLElement).getByText("staged")).toBeInTheDocument();
    expect(within(hunks[1] as HTMLElement).getByText("unstaged")).toBeInTheDocument();
  });

  it.each([
    ["binary", { binary: true, truncated: false }, "Binary file; text diff is unavailable."],
    ["truncated", { binary: false, truncated: true }, "File exceeds the 1 MB diff limit."],
  ] as const)("shows a %s summary instead of hunks", (_name, flags, reason) => {
    render(
      <DiffRenderer
        area="all"
        fileName="src/main.ts"
        mode="split"
        model={{ ...model([changedHunk]), ...flags }}
      />,
    );
    const summary = screen.getByRole("status");
    expect(summary).toHaveTextContent("src/main.ts");
    expect(summary).toHaveTextContent("128 B");
    expect(summary).toHaveTextContent(reason);
    expect(screen.queryByText("@@ -3,1 +3,1 @@")).not.toBeInTheDocument();
  });

  it("omits line-staging controls when the diff has no staging handler", () => {
    render(
      <DiffRenderer
        area="all"
        fileName="src/main.ts"
        mode="inline"
        model={model([changedHunk])}
      />,
    );
    expect(screen.queryByRole("button", { name: "Stage selected lines" })).not.toBeInTheDocument();
  });

  it("collapses long context runs and expands them on click", () => {
    const lines = Array.from({ length: 8 }, (_, index) => ({
      kind: "context" as const,
      old: index + 1,
      new: index + 1,
      text: `line ${index + 1}`,
      intra: null,
    }));
    const { container } = render(
      <DiffRenderer area="unstaged" mode="inline" model={model([hunk(1, lines)])} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "⋯ 8 unchanged lines · click to show" }));
    expect(container.querySelectorAll(".diff-inline-line")).toHaveLength(8);
  });

  it("places one overview tick per hunk", () => {
    const { container } = render(
      <DiffRenderer
        area="all"
        mode="inline"
        model={model([changedHunk, hunk(10, changedHunk.lines), hunk(20, changedHunk.lines)])}
      />,
    );
    expect(container.querySelectorAll(".diff-ruler-tick")).toHaveLength(3);
  });

  it("windows hunks via IntersectionObserver: off-screen hunks render as spacers until they intersect", () => {
    class FakeIntersectionObserver {
      static instances: FakeIntersectionObserver[] = [];
      elements: Element[] = [];
      callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        FakeIntersectionObserver.instances.push(this);
      }
      observe(el: Element) {
        this.elements.push(el);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    // Each hunk is well past the initial render budget on its own, so only hunk 0 starts active.
    const bigLines = Array.from({ length: 100 }, (_, index) => ({
      kind: "context" as const,
      old: index + 1,
      new: index + 1,
      text: `far line ${index + 1}`,
      intra: null,
    }));
    const hunks = [hunk(1, bigLines), hunk(200, bigLines), hunk(400, bigLines)];
    render(<DiffRenderer area="all" mode="inline" model={model(hunks)} />);

    expect(screen.getByText("@@ -1,100 +1,100 @@")).toBeInTheDocument();
    expect(screen.queryByText("@@ -400,100 +400,100 @@")).not.toBeInTheDocument();

    const observer = FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1];
    act(() => {
      observer.callback(
        [{ target: observer.elements[2], isIntersecting: true } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
    });

    expect(screen.getByText("@@ -400,100 +400,100 @@")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("windows rows inside a single very large hunk and follows the scroller", () => {
    const lines = Array.from({ length: 1_000 }, (_, index) => ({
      kind: "add" as const,
      old: null,
      new: index + 1,
      text: `added line ${index + 1}`,
      intra: null,
    }));
    const { container } = render(
      <DiffRenderer area="unstaged" mode="inline" model={model([hunk(1, lines)])} />,
    );
    const scroller = container.querySelector(".diff-hunks") as HTMLDivElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
    expect(container.querySelectorAll(".diff-line").length).toBeLessThan(100);

    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 20 * 800 });
    fireEvent.scroll(scroller);

    expect(container.querySelectorAll(".diff-line").length).toBeLessThan(150);
    const numbers = [...container.querySelectorAll(".diff-line-number")].map((node) => node.textContent);
    expect(numbers).toContain("801");
    expect(numbers).not.toContain("1");
  });

  it("dispatches hunk and line actions with stable identifiers", () => {
    const onRequestHunkAction = vi.fn();
    const onToggleLine = vi.fn();
    render(
      <DiffRenderer
        area="unstaged"
        mode="inline"
        model={model([changedHunk])}
        onRequestHunkAction={onRequestHunkAction}
        onToggleLine={onToggleLine}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "＋ Stage hunk" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle changed line 1" }));
    expect(onRequestHunkAction).toHaveBeenCalledWith(changedHunk, "stage", 0);
    expect(onToggleLine).toHaveBeenCalledWith(changedHunk, "0:0");
  });
});
