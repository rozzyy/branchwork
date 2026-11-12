import { describe, expect, it } from "vitest";
import { dropPositionIsInside, formatDroppedPaths } from "./fileDrop";

describe("native terminal file drops", () => {
  it("inserts quoted paths without submitting the prompt", () => {
    expect(formatDroppedPaths(["/tmp/my image.png", "/tmp/a'b.txt"])).toBe(
      "'/tmp/my image.png' '/tmp/a'\\''b.txt'",
    );
    expect(formatDroppedPaths(["/tmp/file\nexit"])).toBeNull();
  });

  it("bounds the number and length of dropped paths", () => {
    expect(formatDroppedPaths(Array.from({ length: 9 }, (_, index) => `/tmp/${index}`))).toBeNull();
    expect(formatDroppedPaths([`/${"x".repeat(2048)}`])).toBeNull();
  });

  it("targets the pane under the physical drop point", () => {
    expect(dropPositionIsInside(300, 200, { left: 100, top: 50, right: 200, bottom: 150 }, 2)).toBe(true);
    expect(dropPositionIsInside(500, 200, { left: 100, top: 50, right: 200, bottom: 150 }, 2)).toBe(false);
  });
});
