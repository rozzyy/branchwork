import { test, expect, type Page, type Locator } from "@playwright/test";

function stage(page: Page): Locator {
  return page.locator(".stage");
}

function pane(page: Page, index: 0 | 1): Locator {
  return page.locator(`[data-pane="${index}"]`);
}

function paneHeading(page: Page, index: 0 | 1, name: string): Locator {
  return pane(page, index).getByRole("heading", { level: 1, name, exact: true });
}

/**
 * HTML5 drag-and-drop from a sidebar item onto the stage.
 * Playwright has no native support for the custom `application/x-branchwork-screen`
 * MIME type, so we share one DataTransfer handle across synthetic dragstart/dragover/drop
 * events (the documented Playwright recipe for custom-data drag-and-drop).
 */
async function dragSidebarOnto(page: Page, screenLabel: string, target: Locator, point: { x: number; y: number }) {
  const source = page.getByRole("button", { name: screenLabel, exact: true });
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer, clientX: point.x, clientY: point.y });
  await target.dispatchEvent("drop", { dataTransfer, clientX: point.x, clientY: point.y });
  await source.dispatchEvent("dragend", { dataTransfer });
}

async function pointAt(target: Locator, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = (await target.boundingBox())!;
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

async function dragDividerTo(page: Page, stageBox: { x: number; width: number }, fracX: number) {
  const dBox = (await page.getByRole("separator").boundingBox())!;
  await page.mouse.move(dBox.x + dBox.width / 2, dBox.y + dBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + stageBox.width * fracX, dBox.y + dBox.height / 2, { steps: 8 });
  await page.mouse.up();
}

test.describe("M0 Stage 3 split view", () => {
  test("drag Changes onto the right edge opens a right split with a separator", async ({ page }) => {
    await page.goto("/");
    const s = stage(page);
    const point = await pointAt(s, 0.95, 0.5);
    await dragSidebarOnto(page, "Changes", s, point);

    await expect(s).toHaveClass(/split-h/);
    await expect(page.getByRole("separator")).toBeVisible();
    await expect(paneHeading(page, 0, "Home")).toBeVisible();
    await expect(paneHeading(page, 1, "Changes")).toBeVisible();
  });

  test("drag a sidebar item onto the bottom edge opens a vertical split", async ({ page }) => {
    await page.goto("/");
    const s = stage(page);
    const point = await pointAt(s, 0.5, 0.95);
    await dragSidebarOnto(page, "History", s, point);

    await expect(s).toHaveClass(/split-v/);
    await expect(paneHeading(page, 0, "Home")).toBeVisible();
    await expect(paneHeading(page, 1, "Graph")).toBeVisible();
  });

  test("Meta-click a sidebar item opens a right split", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Changes", exact: true }).click({ modifiers: ["Meta"] });

    await expect(stage(page)).toHaveClass(/split-h/);
    await expect(paneHeading(page, 0, "Home")).toBeVisible();
    await expect(paneHeading(page, 1, "Changes")).toBeVisible();
  });

  test("Alt-click a sidebar item opens a bottom split", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Changes", exact: true }).click({ modifiers: ["Alt"] });

    await expect(stage(page)).toHaveClass(/split-v/);
    await expect(paneHeading(page, 0, "Home")).toBeVisible();
    await expect(paneHeading(page, 1, "Changes")).toBeVisible();
  });

  test("right-click a sidebar item opens a context menu; Split left opens a left split", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Changes", exact: true }).click({ button: "right" });

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Split left", exact: true }).click();

    await expect(stage(page)).toHaveClass(/split-h/);
    await expect(paneHeading(page, 0, "Changes")).toBeVisible();
    await expect(paneHeading(page, 1, "Home")).toBeVisible();
  });

  test("Open beside menu opens a right split when a screen is selected", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open beside", exact: true }).click();

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: /^Agents/ }).click();

    await expect(stage(page)).toHaveClass(/split-h/);
    await expect(paneHeading(page, 0, "Home")).toBeVisible();
    await expect(paneHeading(page, 1, "Agents")).toBeVisible();
  });

  test("pane controls: swap, toggle orientation, and close", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Changes", exact: true }).click({ modifiers: ["Meta"] });
    await expect(paneHeading(page, 0, "Home")).toBeVisible();
    await expect(paneHeading(page, 1, "Changes")).toBeVisible();

    await pane(page, 0).getByRole("button", { name: "Swap panes", exact: true }).click();
    await expect(paneHeading(page, 0, "Changes")).toBeVisible();
    await expect(paneHeading(page, 1, "Home")).toBeVisible();

    await expect(stage(page)).toHaveClass(/split-h/);
    await pane(page, 0).getByRole("button", { name: "Toggle orientation", exact: true }).click();
    await expect(stage(page)).toHaveClass(/split-v/);

    await pane(page, 1).getByRole("button", { name: "Close pane", exact: true }).click();
    await expect(page.locator("[data-pane]")).toHaveCount(1);
    await expect(paneHeading(page, 0, "Changes")).toBeVisible();
  });

  test("clicking a screen already open in the other pane focuses it instead of duplicating", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Changes", exact: true }).click({ modifiers: ["Meta"] });
    await expect(pane(page, 1)).toHaveClass(/focus/);

    await page.getByRole("button", { name: "Home", exact: true }).click();

    await expect(page.locator("[data-pane]")).toHaveCount(2);
    await expect(pane(page, 0)).toHaveClass(/focus/);
    await expect(pane(page, 1)).not.toHaveClass(/focus/);
    await expect(paneHeading(page, 0, "Home")).toBeVisible();
    await expect(paneHeading(page, 1, "Changes")).toBeVisible();
  });

  test("dragging the divider resizes panes and clamps to ~20%/80%", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Changes", exact: true }).click({ modifiers: ["Meta"] });
    const stageBox = (await stage(page).boundingBox())!;

    await dragDividerTo(page, stageBox, 0.05);
    let pane0Box = (await pane(page, 0).boundingBox())!;
    let ratio0 = pane0Box.width / stageBox.width;
    expect(ratio0).toBeGreaterThan(0.17);
    expect(ratio0).toBeLessThan(0.23);

    await dragDividerTo(page, stageBox, 0.95);
    pane0Box = (await pane(page, 0).boundingBox())!;
    ratio0 = pane0Box.width / stageBox.width;
    expect(ratio0).toBeGreaterThan(0.77);
    expect(ratio0).toBeLessThan(0.83);
  });

  test("double-clicking the divider resets the split to 50/50", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Changes", exact: true }).click({ modifiers: ["Meta"] });
    const stageBox = (await stage(page).boundingBox())!;

    await dragDividerTo(page, stageBox, 0.1);
    let pane0Box = (await pane(page, 0).boundingBox())!;
    expect(pane0Box.width / stageBox.width).toBeLessThan(0.3);

    await page.getByRole("separator").dblclick();
    pane0Box = (await pane(page, 0).boundingBox())!;
    const ratio0 = pane0Box.width / stageBox.width;
    expect(ratio0).toBeGreaterThan(0.46);
    expect(ratio0).toBeLessThan(0.54);
  });

  test("reload restores the split layout", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Changes", exact: true }).click({ modifiers: ["Meta"] });
    await expect(stage(page)).toHaveClass(/split-h/);

    // Layout save is debounced 300ms; wait on the actual persisted value, not a timer.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("bw:stage")))
      .toContain("changes");

    await page.reload();

    await expect(stage(page)).toHaveClass(/split-h/);
    await expect(paneHeading(page, 0, "Home")).toBeVisible();
    await expect(paneHeading(page, 1, "Changes")).toBeVisible();
  });
});
