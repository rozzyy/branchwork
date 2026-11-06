import { test, expect, type Page, type Locator } from "@playwright/test";

// Seeded through src/ipc/catalog.ts's browser localStorage fallback (key `bw:catalog`).
// Two groups, three projects, no pre-existing Ungrouped project — this makes the
// default (no persisted selection) landing spot deterministic: resolveSelection()
// falls back to the alphabetically-first project overall, which is "backend" (g1).
const CATALOG = {
  groups: [
    { id: "g1", name: "Alpha Team", color: "oklch(.68 .19 250)", clonePathTemplate: "~/clients/{repo}" },
    { id: "g2", name: "Beta Team", color: "oklch(.68 .19 300)", clonePathTemplate: "~/clients/{repo}" },
  ],
  projects: [
    { id: "p1", owner: "acme", name: "frontend", localPath: "/tmp/acme/frontend", groupId: "g1" },
    { id: "p2", owner: "acme", name: "backend", localPath: "/tmp/acme/backend", groupId: "g1" },
    { id: "p3", owner: null, name: "docs", localPath: "/tmp/acme/docs", groupId: "g2" },
  ],
  pins: [],
};

async function seedCatalog(page: Page) {
  await page.addInitScript((catalog) => {
    localStorage.setItem("bw:catalog", JSON.stringify(catalog));
  }, CATALOG);
}

async function gotoSeeded(page: Page) {
  await seedCatalog(page);
  await page.goto("/");
  // Wait for the store's load() to settle so tabs/chip reflect seeded data.
  await expect(page.getByRole("list", { name: "Projects" })).toBeVisible();
}

// Scoped to the titlebar chip itself: the group section disclosure buttons added in Task 05e
// (`.group-sec-toggle`) share the same accessible names ("Alpha Team", "Ungrouped", ...).
function chip(page: Page) {
  return page.locator(".group-chip");
}

async function openSwitcher(page: Page) {
  await gotoSeeded(page);
  await chip(page).click();
  const dialog = page.getByRole("dialog", { name: "Search groups and projects" });
  await expect(dialog).toBeVisible();
  return dialog;
}

// A project ("orphan") whose groupId points at a group that doesn't exist in the catalog.
const ORPHAN_CATALOG = {
  groups: [{ id: "g1", name: "Alpha Team", color: "oklch(.68 .19 250)", clonePathTemplate: "~/clients/{repo}" }],
  projects: [
    { id: "p1", owner: "acme", name: "frontend", localPath: "/tmp/acme/frontend", groupId: "g1" },
    { id: "p4", owner: null, name: "orphan", localPath: "/tmp/acme/orphan", groupId: "ghost-group" },
  ],
  pins: [],
};

async function gotoOrphanSeeded(page: Page) {
  await page.addInitScript((catalog) => {
    localStorage.setItem("bw:catalog", JSON.stringify(catalog));
  }, ORPHAN_CATALOG);
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Projects" })).toBeVisible();
}

/** The disclosure header button for a section (excludes the separate Edit/Delete icon buttons). */
function sectionToggle(dialog: Locator, name: string) {
  return dialog.locator(".group-sec", { hasText: name }).getByRole("button", { name: new RegExp("^" + name) });
}

test.describe("M1 Stage 1 repository/group flows", () => {
  // No screen in this flow should fall back to a native browser dialog.
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

  test("project tabs render for the active group and clicking switches the active tab", async ({ page }) => {
    await gotoSeeded(page);
    // Default selection lands on g1 (Alpha Team) / backend, the alphabetically-first project.
    await expect(chip(page)).toHaveText(/Alpha Team/);
    const list = page.getByRole("list", { name: "Projects" });
    const backendTab = list.getByRole("button", { name: "backend", exact: true });
    const frontendTab = list.getByRole("button", { name: "frontend", exact: true });
    await expect(backendTab).toHaveAttribute("aria-current", "true");
    await expect(frontendTab).not.toHaveAttribute("aria-current");

    await frontendTab.click();
    await expect(frontendTab).toHaveAttribute("aria-current", "true");
    await expect(backendTab).not.toHaveAttribute("aria-current");
  });

  test("selection persists across reload", async ({ page }) => {
    await gotoSeeded(page);
    const list = page.getByRole("list", { name: "Projects" });
    await list.getByRole("button", { name: "frontend", exact: true }).click();
    await expect(list.getByRole("button", { name: "frontend", exact: true })).toHaveAttribute("aria-current", "true");

    await page.reload();
    await expect(page.getByRole("list", { name: "Projects" })).toBeVisible();
    await expect(page.getByRole("button", { name: "frontend", exact: true })).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("button", { name: "backend", exact: true })).not.toHaveAttribute("aria-current");
  });

  test("group switcher chip opens a labelled popover", async ({ page }) => {
    const dialog = await openSwitcher(page);
    await expect(dialog.getByRole("textbox", { name: "Search groups and projects" })).toBeFocused();
    await expect(dialog).toContainText("Alpha Team");
    await expect(dialog).toContainText("Beta Team");
    await expect(dialog).toContainText("Ungrouped");
  });

  test("search filters groups and projects, including Ungrouped", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const search = dialog.getByRole("textbox", { name: "Search groups and projects" });

    await search.fill("docs");
    await expect(dialog).toContainText("Beta Team");
    await expect(dialog).toContainText("docs");
    await expect(dialog).not.toContainText("Alpha Team");
    await expect(dialog).not.toContainText("frontend");
    await expect(dialog).not.toContainText("backend");

    await search.fill("zzz-nothing-matches");
    await expect(dialog).not.toContainText("Alpha Team");
    await expect(dialog).not.toContainText("Beta Team");
    await expect(dialog).not.toContainText("Ungrouped");
  });

  test("selecting a project in the popover closes it and selects the project", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const docsRow = dialog.locator(".group-sec", { hasText: "Beta Team" }).getByRole("button", { name: /docs/ });
    await docsRow.click();
    await expect(dialog).toBeHidden();
    await expect(chip(page)).toHaveText(/Beta Team/);
    await expect(page.getByRole("button", { name: "docs", exact: true })).toHaveAttribute("aria-current", "true");
  });

  test("creates a group via the form", async ({ page }) => {
    const dialog = await openSwitcher(page);
    await dialog.getByRole("button", { name: "New group", exact: true }).click();

    await dialog.getByRole("textbox", { name: "Name" }).fill("Gamma Team");
    await dialog.getByRole("button", { name: "Accent hue 350" }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();

    await expect(dialog).toContainText("Gamma Team");
    // Form closed back to the list view (Save button from the form is gone).
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  });

  test("moves a project to another group", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const betaSection = dialog.locator(".group-sec", { hasText: "Beta Team" });
    const alphaSection = dialog.locator(".group-sec", { hasText: "Alpha Team" });

    await expect(betaSection).toContainText("docs");
    await betaSection.getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("menuitem", { name: "Alpha Team", exact: true }).click();

    await expect(alphaSection).toContainText("docs");
    await expect(betaSection).not.toContainText("docs");
  });

  test("delete group moves projects to Ungrouped, Undo restores the group", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const betaSection = dialog.locator(".group-sec", { hasText: "Beta Team" });
    const ungroupedSection = dialog.locator(".group-sec", { hasText: "Ungrouped" });

    await betaSection.getByRole("button", { name: "Delete group" }).click();
    const confirmDialog = page.getByRole("dialog", { name: /Delete.*Beta Team/ });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Delete group", exact: true }).click();

    await expect(dialog).not.toContainText("Beta Team");
    await expect(ungroupedSection).toContainText("docs");

    const undoToast = page.getByRole("status").filter({ hasText: "Deleted" });
    await expect(undoToast).toBeVisible();
    // The toast's Undo button is outside the popover, so this click also closes the
    // popover via its own "click outside" dismissal — reopen it to check the restore.
    await undoToast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(dialog).toBeHidden();

    await chip(page).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Beta Team");
    await expect(dialog.locator(".group-sec", { hasText: "Beta Team" })).toContainText("docs");
  });

  test("Escape closes the popover and refocuses the chip", async ({ page }) => {
    await gotoSeeded(page);
    const chipButton = chip(page);
    await chipButton.click();
    const dialog = page.getByRole("dialog", { name: "Search groups and projects" });
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(chipButton).toBeFocused();
  });

  test("Open repository in the browser build shows an explicit error toast, not a fake success", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const list = page.getByRole("list", { name: "Projects" });
    const tabsBefore = await list.getByRole("listitem").count();

    await dialog.getByRole("button", { name: "Open repository…", exact: true }).click();

    const errorToast = page.getByRole("status").filter({ hasText: "Couldn't open repository" });
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText("Opening a repository requires the desktop app");

    // No fake project/tab was registered for the rejected open.
    await expect(list.getByRole("listitem")).toHaveCount(tabsBefore);
  });

  test("closing a non-active tab hides it without changing selection", async ({ page }) => {
    await gotoSeeded(page);
    const list = page.getByRole("list", { name: "Projects" });
    await expect(list.getByRole("button", { name: "backend", exact: true })).toHaveAttribute("aria-current", "true");

    await page.getByRole("button", { name: "Close tab frontend" }).click();

    await expect(list.getByRole("button", { name: "frontend", exact: true })).toHaveCount(0);
    await expect(list.getByRole("button", { name: "backend", exact: true })).toHaveAttribute("aria-current", "true");
  });

  test("closing the active tab selects its neighbor; reopening via the switcher brings it back", async ({ page }) => {
    await gotoSeeded(page);
    const list = page.getByRole("list", { name: "Projects" });

    await page.getByRole("button", { name: "Close tab backend" }).click();
    await expect(list.getByRole("button", { name: "backend", exact: true })).toHaveCount(0);
    await expect(list.getByRole("button", { name: "frontend", exact: true })).toHaveAttribute("aria-current", "true");

    await chip(page).click();
    const dialog = page.getByRole("dialog", { name: "Search groups and projects" });
    await dialog.locator(".group-sec", { hasText: "Alpha Team" }).getByRole("button", { name: /backend/ }).click();
    await expect(dialog).toBeHidden();
    await expect(list.getByRole("button", { name: "backend", exact: true })).toHaveAttribute("aria-current", "true");
  });

  test("closed tabs persist across reload", async ({ page }) => {
    await gotoSeeded(page);
    await page.getByRole("button", { name: "Close tab frontend" }).click();
    await expect(page.getByRole("button", { name: "frontend", exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("list", { name: "Projects" })).toBeVisible();
    await expect(page.getByRole("button", { name: "frontend", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "backend", exact: true })).toHaveAttribute("aria-current", "true");
  });

  test("collapsing a group hides its rows and shows a count; expanding restores them", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const toggle = sectionToggle(dialog, "Alpha Team");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(dialog).toContainText("frontend");
    await expect(dialog).toContainText("backend");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toContainText("Alpha Team · 2");
    await expect(dialog).not.toContainText("frontend");
    await expect(dialog).not.toContainText("backend");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(dialog).toContainText("frontend");
    await expect(dialog).toContainText("backend");
  });

  test("search reveals matches inside a collapsed group without changing its collapsed state", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const toggle = sectionToggle(dialog, "Alpha Team");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    const search = dialog.getByRole("textbox", { name: "Search groups and projects" });
    await search.fill("frontend");
    await expect(dialog).toContainText("frontend");

    await search.fill("");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(dialog).not.toContainText("frontend");
  });

  test("collapsed state persists across reload, including Ungrouped", async ({ page }) => {
    await gotoOrphanSeeded(page);
    await chip(page).click();
    const dialog = page.getByRole("dialog", { name: "Search groups and projects" });
    const ungroupedToggle = sectionToggle(dialog, "Ungrouped");
    await expect(ungroupedToggle).toHaveAttribute("aria-expanded", "true");

    await ungroupedToggle.click();
    await expect(ungroupedToggle).toHaveAttribute("aria-expanded", "false");

    await page.reload();
    await expect(page.getByRole("list", { name: "Projects" })).toBeVisible();
    await chip(page).click();
    const reopened = page.getByRole("dialog", { name: "Search groups and projects" });
    await expect(sectionToggle(reopened, "Ungrouped")).toHaveAttribute("aria-expanded", "false");
  });

  test("a project whose groupId references a missing group appears under Ungrouped", async ({ page }) => {
    await gotoOrphanSeeded(page);
    await chip(page).click();
    const dialog = page.getByRole("dialog", { name: "Search groups and projects" });
    const ungrouped = dialog.locator(".group-sec", { hasText: "Ungrouped" });
    await expect(ungrouped).toContainText("orphan");
  });

  test("Remove from Branchwork removes a project; Undo restores it", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const alphaSection = dialog.locator(".group-sec", { hasText: "Alpha Team" });
    const frontendRow = alphaSection.locator(".group-row", { hasText: "frontend" });
    await expect(frontendRow).toBeVisible();

    await frontendRow.getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("menuitem", { name: "Remove from Branchwork…" }).click();

    const confirmDialog = page.getByRole("dialog", { name: /Remove.*frontend.*Branchwork/ });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Remove", exact: true }).click();

    await expect(alphaSection).not.toContainText("frontend");

    const removedToast = page.getByRole("status").filter({ hasText: "Removed" });
    await expect(removedToast).toBeVisible();
    // Same as the delete-group flow: the toast's Undo button sits outside the popover, so
    // clicking it also closes the popover via the "click outside" dismissal — reopen to check.
    await removedToast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(dialog).toBeHidden();

    await chip(page).click();
    const reopened = page.getByRole("dialog", { name: "Search groups and projects" });
    await expect(reopened.locator(".group-sec", { hasText: "Alpha Team" })).toContainText("frontend");
  });

  test("Cancel in the Remove from Branchwork dialog does nothing", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const alphaSection = dialog.locator(".group-sec", { hasText: "Alpha Team" });
    const frontendRow = alphaSection.locator(".group-row", { hasText: "frontend" });

    await frontendRow.getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("menuitem", { name: "Remove from Branchwork…" }).click();

    const confirmDialog = page.getByRole("dialog", { name: /Remove.*frontend.*Branchwork/ });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Cancel", exact: true }).click();

    await expect(confirmDialog).toBeHidden();
    await expect(alphaSection).toContainText("frontend");
  });

  test("clicking the group chip again closes the popover", async ({ page }) => {
    await gotoSeeded(page);
    const chipButton = chip(page);
    await chipButton.click();
    const dialog = page.getByRole("dialog", { name: "Search groups and projects" });
    await expect(dialog).toBeVisible();

    await chipButton.click();
    await expect(dialog).toBeHidden();
  });

  test("clicking the + button toggles the popover open, then closed", async ({ page }) => {
    await gotoSeeded(page);
    const addButton = page.getByRole("button", { name: "Add project" });
    const dialog = page.getByRole("dialog", { name: "Search groups and projects" });

    await addButton.click();
    await expect(dialog).toBeVisible();

    await addButton.click();
    await expect(dialog).toBeHidden();
  });

  test("group Browse… folder picker in the browser build shows an explicit error toast, not a fake success", async ({ page }) => {
    const dialog = await openSwitcher(page);
    await dialog.locator(".group-sec", { hasText: "Alpha Team" }).getByRole("button", { name: "Edit group", exact: true }).click();

    await dialog.getByRole("button", { name: "Browse…", exact: true }).click();

    const errorToast = page.getByRole("status").filter({ hasText: "Couldn't choose folder" });
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText("Opening a repository requires the desktop app");

    // The clone-folder field keeps its existing value — no fake folder was accepted.
    await expect(dialog.getByRole("textbox", { name: "Folder for new clones" })).toHaveValue("~/clients");
  });

  test("Add repository in the browser build shows an explicit error toast, not a fake project", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const list = page.getByRole("list", { name: "Projects" });
    const tabsBefore = await list.getByRole("listitem").count();

    await dialog.getByRole("button", { name: "Add repository to Alpha Team" }).click();

    const errorToast = page.getByRole("status").filter({ hasText: "Couldn't open repository" });
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText("Opening a repository requires the desktop app");
    await expect(list.getByRole("listitem")).toHaveCount(tabsBefore);
  });
});
