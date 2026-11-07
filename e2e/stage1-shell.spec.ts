import { test, expect } from "@playwright/test";

const NAV_ITEMS = [
  "Launchpad",
  "Graph",
  "Files & editor",
  "Changes",
  "Agents",
  "Terminal",
  "Pull requests",
  "Repository",
  "Inbox",
];
const TOOLS_ITEMS = [
  "Resolve conflicts",
  "Interactive rebase",
  "Blame & history",
  "Compare worktrees",
];
const SETTINGS_ITEM = "Settings";
const PLACEHOLDER_BODY = "This screen arrives in a later milestone.";

test.describe("M0 Stage 1 shell", () => {
  test("title bar shows app name and search pill", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".app-name")).toHaveText("Branchwork");
    await expect(page.getByRole("button", { name: /Search, jump, or ask Claude…/ })).toBeVisible();
  });

  test("sidebar lists every nav, tools, and settings item", async ({ page }) => {
    await page.goto("/");
    for (const label of [...NAV_ITEMS, ...TOOLS_ITEMS, SETTINGS_ITEM]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
  });

  test("clicking each nav item opens its screen and marks it active", async ({ page }) => {
    await page.goto("/");
    for (const label of [...NAV_ITEMS, ...TOOLS_ITEMS]) {
      const navButton = page.getByRole("button", { name: label, exact: true });
      await navButton.click();
      if (label === "Graph") {
        await expect(page.getByRole("heading", { level: 1, name: label, exact: true })).toBeVisible();
      } else if (label === "Changes") {
        // Changes now renders a real (empty) state instead of the generic placeholder (M2 Stage 1).
        await expect(page.getByRole("heading", { level: 2, name: label, exact: true })).toBeVisible();
        await expect(page.getByText("Open a worktree to see its changes.")).toBeVisible();
      } else {
        await expect(page.getByRole("heading", { level: 2, name: label, exact: true })).toBeVisible();
        await expect(page.getByText(PLACEHOLDER_BODY)).toBeVisible();
      }
      await expect(navButton).toHaveClass(/\bon\b/);
    }

    // Settings is now a real screen (Stage 2), not a placeholder.
    const settingsButton = page.getByRole("button", { name: SETTINGS_ITEM, exact: true });
    await settingsButton.click();
    await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await expect(settingsButton).toHaveClass(/\bon\b/);
  });

  test("all shell text is English", async ({ page }) => {
    await page.goto("/");
    const bodyText = await page.locator("body").innerText();
    // Spot-check: no CJK/Cyrillic/Arabic script leaking into the shell copy.
    expect(bodyText).not.toMatch(/[Ѐ-ӿ؀-ۿ぀-ヿ一-鿿]/);
  });
});

test("perf: time to first render of the Launchpad placeholder", async ({ page }) => {
  const start = Date.now();
  await page.goto("/");
  await page.getByRole("heading", { level: 2, name: "Launchpad", exact: true }).waitFor({ state: "visible" });
  const elapsed = Date.now() - start;
  console.log(`[perf] time to first Launchpad placeholder render: ${elapsed}ms`);
  expect(elapsed).toBeLessThan(5000);
});
