import { test, expect } from "@playwright/test";
import { openView } from "./helpers/navigation";

const NAV_ITEMS = ["Home", "Changes", "History", "Files", "Agents", "Terminal", "GitHub", "Browser"];

test.describe("M7 shell", () => {
  test("title bar shows workspace location, search, theme, and shortcuts", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Workspace location" })).toBeVisible();
    await expect(page.getByText("Search or ask… (end with ?)", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Toggle dark / light" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show keyboard shortcuts" })).toBeVisible();
  });

  test("stage tab picker lists all screens while the sidebar contains grouped projects", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.locator(".sidebar");
    await expect(sidebar.locator(".nav")).toHaveCount(0);
    await expect(sidebar.locator(".group-inline")).toBeVisible();
    await expect(sidebar.locator(".worktree-section")).toHaveCount(0);
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    const views = page.getByRole("menu", { name: "Views" });
    const viewItems = views.getByRole("menuitem");
    await expect(viewItems).toHaveCount(10);
    for (const [index, label] of [...NAV_ITEMS, "Resolve conflicts", "Settings"].entries()) {
      await expect(viewItems.nth(index)).toHaveAccessibleName(label);
    }
  });

  test("new-tab button opens the screen modal and creates the selected tab", async ({ page }) => {
    await page.goto("/");
    const plus = page.getByRole("button", { name: "New tab", exact: true });
    await plus.click();
    await expect(plus).toHaveAttribute("aria-expanded", "true");
    const modal = page.getByRole("menu", { name: "Views" });
    await expect(modal).toBeVisible();
    await modal.getByRole("menuitem", { name: "Changes" }).click();
    await expect(page.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");
  });

  test("each primary screen opens and becomes active", async ({ page }) => {
    await page.goto("/");
    for (const label of NAV_ITEMS) {
      await openView(page, label);
      const title = label === "History" ? "Graph" : label;
      await expect(page.getByRole("heading", { level: 1, name: title, exact: false })).toBeVisible();
    }

    await openView(page, "Settings");
    await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  });

  test("all shell text is English", async ({ page }) => {
    await page.goto("/");
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/[Ѐ-ӿ؀-ۿ぀-ヿ一-鿿]/);
  });
});

test("perf: time to first render of the Home screen", async ({ page }) => {
  const start = Date.now();
  await page.goto("/");
  await page.getByRole("heading", { level: 1, name: "Home", exact: true }).waitFor({ state: "visible" });
  const elapsed = Date.now() - start;
  console.log(`[perf] time to first Home screen render: ${elapsed}ms`);
  expect(elapsed).toBeLessThan(5000);
});
