import { test, expect, type Page } from "@playwright/test";
import { openView } from "./helpers/navigation";

async function openSettings(page: Page) {
  await page.goto("/");
  await openView(page, "Settings");
}

function html(page: Page) {
  return page.locator("html");
}

async function accentVar(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.style.getPropertyValue("--ah"));
}

test.describe("M0 Stage 2 settings", () => {
  // Every test in this file must never trigger a native browser dialog
  // (window.confirm/alert/prompt) — the app ships its own styled dialog.
  let nativeDialogCount = 0;
  test.beforeEach(async ({ page }) => {
    nativeDialogCount = 0;
    page.on("dialog", async (d) => {
      nativeDialogCount++;
      await d.dismiss();
    });
  });
  test.afterEach(() => {
    expect(nativeDialogCount).toBe(0);
  });

  test("theme Light/Dark switches html[data-theme]", async ({ page }) => {
    await openSettings(page);
    await page.getByRole("radio", { name: "Light", exact: true }).click();
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await page.getByRole("radio", { name: "Dark", exact: true }).click();
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
  });

  test("accent swatch changes --ah on html", async ({ page }) => {
    await openSettings(page);
    await page.getByRole("button", { name: "Accent hue 300" }).click();
    await expect.poll(() => accentVar(page)).toBe("300");
    await page.getByRole("button", { name: "Accent hue 60" }).click();
    await expect.poll(() => accentVar(page)).toBe("60");
  });

  test("Text size Large toggles the global type scale", async ({ page }) => {
    await openSettings(page);
    const textSize = page.getByRole("radiogroup", { name: "Text size" });
    const large = textSize.getByRole("radio", { name: "Large", exact: true });
    await expect(html(page)).not.toHaveAttribute("data-text");
    await large.click();
    await expect(html(page)).toHaveAttribute("data-text", "large");
    await textSize.getByRole("radio", { name: "Default", exact: true }).click();
    await expect(html(page)).not.toHaveAttribute("data-text");
  });

  test("density Compact sets data-density", async ({ page }) => {
    await openSettings(page);
    await page.getByRole("radio", { name: "Compact", exact: true }).click();
    await expect(html(page)).toHaveAttribute("data-density", "compact");
  });

  test("appearance choices persist across reload", async ({ page }) => {
    await openSettings(page);
    await page.getByRole("radio", { name: "Light", exact: true }).click();
    await page.getByRole("button", { name: "Accent hue 155" }).click();
    await page.getByRole("radiogroup", { name: "Text size" }).getByRole("radio", { name: "Large", exact: true }).click();
    await page.getByRole("radio", { name: "Compact", exact: true }).click();

    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await page.reload();

    // Attributes are applied on html as soon as settings load, before any navigation.
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await expect(html(page)).toHaveAttribute("data-density", "compact");
    await expect(html(page)).toHaveAttribute("data-text", "large");
    await expect.poll(() => accentVar(page)).toBe("155");

    // The settings panel itself reflects the restored state too.
    await openView(page, "Settings");
    await expect(page.getByRole("radio", { name: "Light", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radio", { name: "Compact", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radiogroup", { name: "Text size" }).getByRole("radio", { name: "Large", exact: true })).toHaveAttribute("aria-checked", "true");
  });
});
