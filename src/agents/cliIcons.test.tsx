// Focused tests for the provider marks (M3-15).
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CLI_IDS } from "./registry";
import { CliIcon } from "./cliIcons";

describe("CliIcon", () => {
  it("renders a distinct theme-safe mark for every CLI", () => {
    const seen = new Set<string>();
    for (const id of CLI_IDS) {
      const { container, unmount } = render(<CliIcon id={id} />);
      const svg = container.querySelector("svg.cli-mark");
      expect(svg, `${id} renders a mark`).not.toBeNull();
      // Theme-safe: monochrome currentColor fill, no hardcoded colors.
      expect(svg?.getAttribute("fill")).toBe("currentColor");
      expect(svg?.innerHTML).not.toMatch(/fill="#/);
      const shape = svg?.innerHTML ?? "";
      expect(seen.has(shape), `${id} mark is distinct`).toBe(false);
      seen.add(shape);
      unmount();
    }
    expect(seen.size).toBe(CLI_IDS.length);
  });

  it("exposes the CLI for tests and sizing", () => {
    render(<CliIcon id="codex" size={16} />);
    const svg = document.querySelector('svg[data-cli="codex"]');
    expect(svg?.getAttribute("width")).toBe("16");
  });

  it("marks are decorative for assistive tech", () => {
    const { container } = render(<CliIcon id="claude" />);
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });
});
