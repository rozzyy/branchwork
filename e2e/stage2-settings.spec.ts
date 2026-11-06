import { test, expect, type Page } from "@playwright/test";

async function openSettings(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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

  test("reduce transparency toggles data-solid", async ({ page }) => {
    await openSettings(page);
    const toggle = page.getByRole("switch", { name: "Reduce transparency" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(html(page)).toHaveAttribute("data-solid", "");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(html(page)).not.toHaveAttribute("data-solid", /.*/);
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
    await page.getByRole("switch", { name: "Reduce transparency" }).click();
    await page.getByRole("radio", { name: "Compact", exact: true }).click();

    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await page.reload();

    // Attributes are applied on html as soon as settings load, before any navigation.
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await expect(html(page)).toHaveAttribute("data-density", "compact");
    await expect(html(page)).toHaveAttribute("data-solid", "");
    await expect.poll(() => accentVar(page)).toBe("155");

    // The settings panel itself reflects the restored state too.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Light", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radio", { name: "Compact", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("switch", { name: "Reduce transparency" })).toHaveAttribute("aria-checked", "true");
  });

  test("Show toast displays a toast, and its Undo shows Undone", async ({ page }) => {
    await openSettings(page);
    await page.getByRole("button", { name: "Show toast", exact: true }).click();
    const savedToast = page.getByRole("status").filter({ hasText: "Settings saved" });
    await expect(savedToast).toBeVisible();
    await savedToast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Undone" })).toBeVisible();
  });

  test("Confirm dialog: Push shows Confirmed, Escape shows Cancelled", async ({ page }) => {
    await openSettings(page);

    await page.getByRole("button", { name: "Confirm dialog", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Push 2 commits?" })).toBeVisible();
    await page.getByRole("button", { name: "Push", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Confirmed" })).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.getByRole("button", { name: "Confirm dialog", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("Danger dialog shows a red action button and the file list", async ({ page }) => {
    await openSettings(page);
    await page.getByRole("button", { name: "Danger dialog", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("heading", { name: "Discard all changes?" })).toBeVisible();
    const dangerButton = page.getByRole("button", { name: "Discard all", exact: true });
    await expect(dangerButton).toHaveClass(/danger/);
    const fileList = dialog.locator("pre");
    await expect(fileList).toContainText("src/auth/callback.ts");
    await expect(fileList).toContainText("src/ui/LoginButton.tsx");
    await expect(fileList).toContainText("src/auth/legacy.ts");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("Input dialog: Enter creates the prefilled file and shows a toast", async ({ page }) => {
    await openSettings(page);
    await page.getByRole("button", { name: "Input dialog", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const input = page.getByRole("textbox");
    await expect(input).toHaveValue("src/new-file.ts");
    await input.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Created src/new-file.ts" })).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});
