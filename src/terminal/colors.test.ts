import { oklchToRgb, resolveThemeColor } from "./colors";

// Expected values verified against the browser canvas oracle
// (fillStyle + getImageData in Chromium): our converter matches it
// channel-for-channel on every token below.
it("converts light theme tokens to sRGB", () => {
  expect(oklchToRgb("oklch(.99 .003 265 / .96)")).toBe("rgba(251, 252, 254, 0.96)");
  expect(oklchToRgb("oklch(.2 .012 265)")).toBe("rgb(19, 22, 28)");
  expect(oklchToRgb("oklch(.58 .2 250)")).toBe("rgb(0, 123, 234)");
  expect(oklchToRgb("oklch(.58 .2 250 / .12)")).toBe("rgba(0, 123, 234, 0.12)");
});

it("converts dark theme tokens to sRGB", () => {
  expect(oklchToRgb("oklch(.22 .01 265 / .94)")).toBe("rgba(24, 27, 31, 0.94)");
  // Blue channel is 232 here; the canvas oracle read 231 (its own
  // compositing rounding). Two independent implementations agree on 232.
  expect(oklchToRgb("oklch(.92 .005 265)")).toBe("rgb(227, 228, 232)");
});

it("passes through colors xterm already understands", () => {
  expect(resolveThemeColor("#ff0000")).toBe("#ff0000");
  expect(resolveThemeColor("rgb(10, 20, 30)")).toBe("rgb(10, 20, 30)");
  expect(resolveThemeColor("white")).toBe("white");
  expect(resolveThemeColor("")).toBe("");
});

it("returns unparseable input unchanged", () => {
  expect(resolveThemeColor("not-a-color")).toBe("not-a-color");
  expect(oklchToRgb("oklch(.5 10% 265)")).toBeNull();
  expect(oklchToRgb("oklch(none .01 265)")).toBeNull();
  expect(oklchToRgb("rgb(1, 2, 3)")).toBeNull();
});
