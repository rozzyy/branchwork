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

async function openSeeded(page: Page) {
  await page.addInitScript((catalog) => localStorage.setItem("bw:catalog", JSON.stringify(catalog)), CATALOG);
  await page.goto("/");
  await expect(page.locator(".sidebar")).toBeVisible();
}

function projectPicker(page: Page) {
  return page.getByRole("dialog", { name: "Search groups and projects" });
}

function groupSection(picker: Locator, name: string) {
  return picker.locator(".group-sec").filter({ hasText: name });
}

function projectRow(container: Locator, name: string) {
  return container.locator(".group-row-main").filter({ hasText: name });
}

async function openProjectPicker(page: Page) {
  await page.locator(".sidebar .project-picker-trigger").click();
  const picker = projectPicker(page);
  await expect(picker).toBeVisible();
  return picker;
}

test.describe("M7 project picker", () => {
  let nativeDialogCount = 0;

  test.beforeEach(async ({ page }) => {
    nativeDialogCount = 0;
    page.on("dialog", async (dialog) => {
      nativeDialogCount++;
      await dialog.dismiss();
    });
  });

  test.afterEach(() => expect(nativeDialogCount).toBe(0));

  test("lists grouped projects and selects a project into the workspace breadcrumb", async ({ page }) => {
    await openSeeded(page);
    const picker = await openProjectPicker(page);
    await expect(picker).toContainText("Alpha Team");
    await expect(picker).toContainText("Beta Team");
    await expect(picker).toContainText("Ungrouped");
    await expect(projectRow(picker, "acme/frontend")).toBeVisible();
    await expect(projectRow(picker, "acme/backend")).toBeVisible();
    await expect(projectRow(picker, "docs")).toBeVisible();

    await projectRow(picker, "acme/frontend").click();
    await expect(picker).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Workspace location" }).getByRole("button", { name: "acme/frontend", exact: true })).toBeVisible();
  });

  test("search filters groups and projects; Escape restores focus to its trigger", async ({ page }) => {
    await openSeeded(page);
    const trigger = page.locator(".sidebar .project-picker-trigger");
    const picker = await openProjectPicker(page);
    const search = picker.getByRole("textbox", { name: "Search groups and projects" });
    await expect(search).toBeFocused();
    await search.fill("docs");
    await expect(projectRow(picker, "docs")).toBeVisible();
    await expect(projectRow(picker, "acme/frontend")).toHaveCount(0);
    await expect(groupSection(picker, "Beta Team")).toBeVisible();
    await expect(groupSection(picker, "Alpha Team")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("creates a group and moves a project into it", async ({ page }) => {
    await openSeeded(page);
    let picker = await openProjectPicker(page);
    await picker.getByRole("button", { name: "New group", exact: true }).click();
    await picker.getByRole("textbox", { name: "Name" }).fill("Gamma Team");
    await picker.getByRole("button", { name: "Save", exact: true }).click();
    await expect(groupSection(picker, "Gamma Team")).toBeVisible();

    const docs = groupSection(picker, "Beta Team").locator(".group-row").filter({ hasText: "docs" });
    await docs.getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("menuitem", { name: "Gamma Team", exact: true }).click();
    await expect(groupSection(picker, "Gamma Team")).toContainText("docs");
    await expect(groupSection(picker, "Beta Team")).not.toContainText("docs");
  });

  test("the browser build explains that opening a repository needs the desktop app", async ({ page }) => {
    await openSeeded(page);
    const picker = await openProjectPicker(page);
    await picker.getByRole("button", { name: "Open repository…", exact: true }).click();
    const errorToast = page.getByRole("status").filter({ hasText: "Couldn't open repository" });
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText("Opening a repository requires the desktop app");
    await expect(picker).toBeVisible();
  });
});
