import { test, expect, type Page, type Locator } from "@playwright/test";

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
  await page.addInitScript((catalog) => localStorage.setItem("bw:catalog", JSON.stringify(catalog)), CATALOG);
}

function rail(page: Page) {
  return page.getByRole("complementary", { name: "Project sidebar" });
}

function projectButton(sidebar: Locator, name: string) {
  return sidebar.locator(".project-sidebar-project").filter({ hasText: name });
}

function groupSection(sidebar: Locator, name: string) {
  return sidebar.locator(".project-sidebar-group").filter({ hasText: name });
}

function switcherSection(dialog: Locator, name: string) {
  return dialog.locator(".group-sec").filter({ hasText: name });
}

async function gotoSeeded(page: Page) {
  await seedCatalog(page);
  await page.goto("/");
  await expect(rail(page)).toBeVisible();
  await expect(rail(page).locator(".project-sidebar-project")).toHaveCount(3);
}

async function openProjectActions(page: Page) {
  const sidebar = rail(page);
  await sidebar.locator(".project-sidebar-footer").getByRole("button", { name: "Project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search groups and projects" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openSwitcher(page: Page) {
  await gotoSeeded(page);
  return openProjectActions(page);
}

const ORPHAN_CATALOG = {
  groups: [{ id: "g1", name: "Alpha Team", color: "oklch(.68 .19 250)", clonePathTemplate: "~/clients/{repo}" }],
  projects: [
    { id: "p1", owner: "acme", name: "frontend", localPath: "/tmp/acme/frontend", groupId: "g1" },
    { id: "p4", owner: null, name: "orphan", localPath: "/tmp/acme/orphan", groupId: "ghost-group" },
  ],
  pins: [],
};

async function gotoOrphanSeeded(page: Page) {
  await page.addInitScript((catalog) => localStorage.setItem("bw:catalog", JSON.stringify(catalog)), ORPHAN_CATALOG);
  await page.goto("/");
  await expect(rail(page)).toBeVisible();
  await expect(projectButton(rail(page), "orphan")).toBeVisible();
}

test.describe("M3 Stage 6 project sidebar", () => {
  let nativeDialogCount = 0;

  test.beforeEach(async ({ page }) => {
    nativeDialogCount = 0;
    page.on("dialog", async (dialog) => {
      nativeDialogCount++;
      await dialog.dismiss();
    });
  });

  test.afterEach(() => {
    expect(nativeDialogCount).toBe(0);
  });

  test("shows every project and the active group/project context", async ({ page }) => {
    await gotoSeeded(page);
    await expect(projectButton(rail(page), "backend")).toHaveAttribute("aria-current", "page");
    await expect(rail(page)).toContainText("frontend");
    await expect(rail(page)).toContainText("docs");
    await expect(page.locator(".title-project-group")).toHaveText("Alpha Team");
    await expect(page.locator(".title-project-name")).toHaveText("acme/backend");
  });

  test("selects a project and restores the selection after reload", async ({ page }) => {
    await gotoSeeded(page);
    await projectButton(rail(page), "frontend").click();
    await expect(projectButton(rail(page), "frontend")).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".title-project-name")).toHaveText("acme/frontend");

    await page.reload();
    await expect(rail(page)).toBeVisible();
    await expect(projectButton(rail(page), "frontend")).toHaveAttribute("aria-current", "page");
    await expect(projectButton(rail(page), "backend")).not.toHaveAttribute("aria-current");
  });

  test("the Project action opens a labelled group and project management popover", async ({ page }) => {
    const dialog = await openSwitcher(page);
    await expect(dialog.getByRole("textbox", { name: "Search groups and projects" })).toBeFocused();
    await expect(dialog).toContainText("Alpha Team");
    await expect(dialog).toContainText("Beta Team");
    await expect(dialog).toContainText("Ungrouped");
  });

  test("rail search filters groups and projects", async ({ page }) => {
    await gotoSeeded(page);
    const search = rail(page).getByRole("searchbox", { name: "Search groups and projects" });
    await search.fill("docs");
    await expect(projectButton(rail(page), "docs")).toBeVisible();
    await expect(groupSection(rail(page), "Beta Team")).toBeVisible();
    await expect(groupSection(rail(page), "Alpha Team")).toHaveCount(0);

    await search.fill("nothing-matches");
    await expect(rail(page)).toContainText("No matching projects");
  });

  test("selects a project directly from the rail", async ({ page }) => {
    await gotoSeeded(page);
    await projectButton(rail(page), "docs").click();
    await expect(page.locator(".title-project-group")).toHaveText("Beta Team");
    await expect(projectButton(rail(page), "docs")).toHaveAttribute("aria-current", "page");
  });

  test("creates a group from the rail", async ({ page }) => {
    await gotoSeeded(page);
    await rail(page).locator(".project-sidebar-footer").getByRole("button", { name: "Group", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Search groups and projects" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Gamma Team");
    await dialog.getByRole("button", { name: "Accent hue 350" }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(groupSection(rail(page), "Gamma Team")).toBeVisible();
  });

  test("moves a project to another group", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const betaSection = switcherSection(dialog, "Beta Team");
    const alphaSection = switcherSection(dialog, "Alpha Team");

    await expect(betaSection).toContainText("docs");
    await betaSection.getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("menuitem", { name: "Alpha Team", exact: true }).click();
    await expect(alphaSection).toContainText("docs");
    await expect(betaSection).not.toContainText("docs");
    await expect(groupSection(rail(page), "Alpha Team")).toContainText("docs");
  });

  test("delete group moves projects to Ungrouped, Undo restores the group", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const betaSection = switcherSection(dialog, "Beta Team");
    const ungroupedSection = switcherSection(dialog, "Ungrouped");

    await betaSection.getByRole("button", { name: "Delete group" }).click();
    const confirmDialog = page.getByRole("dialog", { name: /Delete.*Beta Team/ });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Delete group", exact: true }).click();
    await expect(dialog).not.toContainText("Beta Team");
    await expect(ungroupedSection).toContainText("docs");

    const undoToast = page.getByRole("status").filter({ hasText: "Deleted" });
    await expect(undoToast).toBeVisible();
    await undoToast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(dialog).toBeHidden();

    const reopened = await openProjectActions(page);
    await expect(reopened).toContainText("Beta Team");
    await expect(switcherSection(reopened, "Beta Team")).toContainText("docs");
  });

  test("Escape closes the popover and returns focus to its rail trigger", async ({ page }) => {
    await gotoSeeded(page);
    const trigger = rail(page).locator(".project-sidebar-footer").getByRole("button", { name: "Project", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Search groups and projects" });
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("Open repository in the browser build shows an explicit error and adds no project", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const countBefore = await rail(page).locator(".project-sidebar-project").count();
    await dialog.getByRole("button", { name: "Open repository…", exact: true }).click();

    const errorToast = page.getByRole("status").filter({ hasText: "Couldn't open repository" });
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText("Opening a repository requires the desktop app");
    await expect(rail(page).locator(".project-sidebar-project")).toHaveCount(countBefore);
  });

  test("collapsing groups hides their projects, and expanding restores them", async ({ page }) => {
    await gotoSeeded(page);
    const alpha = groupSection(rail(page), "Alpha Team");
    const toggle = alpha.getByRole("button", { name: "Collapse Alpha Team" });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(projectButton(rail(page), "frontend")).toBeVisible();

    await toggle.click();
    await expect(alpha.getByRole("button", { name: "Expand Alpha Team" })).toHaveAttribute("aria-expanded", "false");
    await expect(alpha.locator(".project-sidebar-projects")).toHaveAttribute("hidden");
    await expect(alpha.locator(".project-sidebar-count")).toHaveText("2");

    await alpha.getByRole("button", { name: "Expand Alpha Team" }).click();
    await expect(projectButton(rail(page), "frontend")).toBeVisible();
  });

  test("search reveals a project inside a collapsed group without changing the saved collapse state", async ({ page }) => {
    await gotoSeeded(page);
    const sidebar = rail(page);
    const alpha = groupSection(sidebar, "Alpha Team");
    await alpha.getByRole("button", { name: "Collapse Alpha Team" }).click();
    const search = sidebar.getByRole("searchbox", { name: "Search groups and projects" });
    await search.fill("frontend");
    await expect(projectButton(sidebar, "frontend")).toBeVisible();

    await search.fill("");
    await expect(alpha.locator(".project-sidebar-projects")).toHaveAttribute("hidden");
  });

  test("collapsed state persists across reload, including Ungrouped", async ({ page }) => {
    await gotoOrphanSeeded(page);
    const sidebar = rail(page);
    const ungrouped = groupSection(sidebar, "Ungrouped");
    await ungrouped.getByRole("button", { name: "Collapse Ungrouped" }).click();
    await expect(ungrouped.locator(".project-sidebar-projects")).toHaveAttribute("hidden");

    await page.reload();
    await expect(rail(page)).toBeVisible();
    await expect(groupSection(rail(page), "Ungrouped").locator(".project-sidebar-projects")).toHaveAttribute("hidden");
  });

  test("a project with an unknown group appears under Ungrouped", async ({ page }) => {
    await gotoOrphanSeeded(page);
    await expect(groupSection(rail(page), "Ungrouped")).toContainText("orphan");
  });

  test("Remove from Branchwork removes a project; Undo restores it", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const alphaSection = switcherSection(dialog, "Alpha Team");
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
    await removedToast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(groupSection(rail(page), "Alpha Team")).toContainText("frontend");
  });

  test("Cancel in the Remove from Branchwork dialog leaves the project unchanged", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const alphaSection = switcherSection(dialog, "Alpha Team");
    const frontendRow = alphaSection.locator(".group-row", { hasText: "frontend" });
    await frontendRow.getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("menuitem", { name: "Remove from Branchwork…" }).click();

    const confirmDialog = page.getByRole("dialog", { name: /Remove.*frontend.*Branchwork/ });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirmDialog).toBeHidden();
    await expect(alphaSection).toContainText("frontend");
  });

  test("clicking the Project action again closes its popover", async ({ page }) => {
    await gotoSeeded(page);
    const trigger = rail(page).locator(".project-sidebar-footer").getByRole("button", { name: "Project", exact: true });
    const dialog = page.getByRole("dialog", { name: "Search groups and projects" });
    await trigger.click();
    await expect(dialog).toBeVisible();
    await trigger.click();
    await expect(dialog).toBeHidden();
  });

  test("the header plus button toggles the project popover", async ({ page }) => {
    await gotoSeeded(page);
    const addButton = rail(page).getByRole("button", { name: "Add project" });
    const dialog = page.getByRole("dialog", { name: "Search groups and projects" });
    await addButton.click();
    await expect(dialog).toBeVisible();
    await addButton.click();
    await expect(dialog).toBeHidden();
  });

  test("group Browse shows an explicit browser-build error", async ({ page }) => {
    const dialog = await openSwitcher(page);
    await switcherSection(dialog, "Alpha Team").getByRole("button", { name: "Edit group", exact: true }).click();
    await dialog.getByRole("button", { name: "Browse…", exact: true }).click();

    const errorToast = page.getByRole("status").filter({ hasText: "Couldn't choose folder" });
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText("Opening a repository requires the desktop app");
    await expect(dialog.getByRole("textbox", { name: "Folder for new clones" })).toHaveValue("~/clients");
  });

  test("Add repository in the browser build shows an explicit error and adds no project", async ({ page }) => {
    const dialog = await openSwitcher(page);
    const countBefore = await rail(page).locator(".project-sidebar-project").count();
    await dialog.getByRole("button", { name: "Add repository to Alpha Team" }).click();

    const errorToast = page.getByRole("status").filter({ hasText: "Couldn't open repository" });
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText("Opening a repository requires the desktop app");
    await expect(rail(page).locator(".project-sidebar-project")).toHaveCount(countBefore);
  });

  test("right rail visibility persists after reload and its narrow overlay stays below the title bar", async ({ page }) => {
    await gotoSeeded(page);
    await page.getByRole("button", { name: "Toggle project sidebar" }).click();
    await expect(rail(page)).toBeHidden();
    await page.reload();
    await expect(rail(page)).toBeHidden();

    await page.getByRole("button", { name: "Toggle project sidebar" }).click();
    await expect(rail(page)).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 800 });
    const titlebar = await page.locator(".titlebar").boundingBox();
    const railBox = await rail(page).boundingBox();
    expect(titlebar).not.toBeNull();
    expect(railBox).not.toBeNull();
    expect(railBox!.y).toBeGreaterThanOrEqual(titlebar!.y + titlebar!.height);
    await expect(rail(page)).toHaveCSS("position", "absolute");
  });
});
