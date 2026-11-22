import type { Locator, Page } from "@playwright/test";

export async function dismissOnboarding(page: Page): Promise<void> {
  await page.locator(".splash").waitFor({ state: "detached", timeout: 10_000 });
  const backdrop = page.locator(".onboarding-backdrop");
  if (await backdrop.isVisible()) {
    await page.getByRole("button", { name: "Skip setup", exact: true }).click({ timeout: 5_000 });
  }
  await backdrop.waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
}

export async function openViews(page: Page): Promise<Locator> {
  await dismissOnboarding(page);
  const menu = page.getByRole("menu", { name: "Views" });
  if (!(await menu.isVisible())) {
    await page.getByRole("button", { name: "New tab", exact: true }).click();
  }
  return menu;
}

export async function openView(
  page: Page,
  label: string,
  options?: Parameters<Locator["click"]>[0],
): Promise<void> {
  const menu = await openViews(page);
  await menu.getByRole("menuitem", { name: label, exact: true }).click(options);
}
