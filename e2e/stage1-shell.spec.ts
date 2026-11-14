import { test, expect } from "@playwright/test";

const NAV_ITEMS = ["Home", "Changes", "History", "Files", "Agents", "Terminal", "GitHub"];

test.describe("M7 shell", () => {
  test("title bar shows workspace location, search, theme, and shortcuts", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Workspace location" })).toBeVisible();
    await expect(page.getByText("Search or ask… (end with ?)", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Toggle dark / light" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show keyboard shortcuts" })).toBeVisible();
  });

  test("sidebar lists the seven primary screens in order and keeps Settings in the footer", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.locator(".sidebar");
    const screenButtons = sidebar.locator(".side-scroll .nav");
    await expect(screenButtons).toHaveCount(NAV_ITEMS.length);
    for (const [index, label] of NAV_ITEMS.entries()) {
      await expect(screenButtons.nth(index)).toHaveAccessibleName(label);
    }
    await expect(sidebar.locator(".side-foot").getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Conflicts", exact: true })).toHaveCount(0);
  });

  test("each primary screen opens and becomes active", async ({ page }) => {
    await page.goto("/");
    for (const label of NAV_ITEMS) {
      const navButton = page.getByRole("button", { name: label, exact: true });
      await navButton.click();
      await expect(navButton).toHaveClass(/\bon\b/);
      const title = label === "History" ? "Graph" : label;
      await expect(page.getByRole("heading", { level: 1, name: title, exact: false })).toBeVisible();
    }

    const settingsButton = page.getByRole("button", { name: "Settings", exact: true });
    await settingsButton.click();
    await expect(settingsButton).toHaveClass(/\bon\b/);
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
