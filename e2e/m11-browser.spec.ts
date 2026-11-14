import { test, expect } from "@playwright/test";

test.describe("M11 browser screen", () => {
  test("shows tabs and the address bar; pages need the desktop app", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Browser" })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(1);
    const address = page.getByRole("textbox", { name: "Address" });
    await address.fill("example.com");
    await address.press("Enter");
    await expect(page.getByRole("tab").first()).toContainText("example.com");
    await page.getByRole("button", { name: "New tab" }).last().click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await page.getByRole("button", { name: "Close tab" }).last().click();
    await expect(page.getByRole("tab")).toHaveCount(1);
  });
});
