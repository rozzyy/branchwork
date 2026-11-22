import { test, expect, type Page, type Locator } from "@playwright/test";
import { openView } from "./helpers/navigation";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** First-launch onboarding (commit ffedb2f) intercepts pointer events on a
 * fresh profile. Dismiss it the same way a person would, not by deleting it.
 * The startup splash (`.splash`) sits in front of it for its leaving
 * transition, so a short click timeout flakes; give it room. */
async function dismissOnboarding(page: Page) {
  await page.locator(".splash").waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
  const skip = page.getByRole("button", { name: "Skip setup", exact: true });
  await skip.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  if (await skip.count()) await skip.click({ timeout: 5_000 }).catch(() => undefined);
  await page.locator(".onboarding-backdrop").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
}

function pane(page: Page, index: number): Locator {
  return page.locator(`[data-pane="${index}"]`);
}

/** Either header shape: screens with `ownsHeader` (Agents/Terminal) render
 * `.pane-header`; every other screen keeps `header.pane-tool`. */
function header(p: Locator): Locator {
  return p.locator(".pane-header, header.pane-tool").first();
}

async function heightRatio(p: Locator): Promise<number> {
  const paneBox = (await p.boundingBox())!;
  const viewBox = (await p.locator(".pane-view").boundingBox())!;
  return viewBox.height / paneBox.height;
}

/** Opens a 4-pane split: Agents, Terminal, Changes, History — the same
 * combination the code reviewer's probe used. */
async function openFourPaneSplit(page: Page) {
  await openView(page, "Agents");
  for (const label of ["Terminal", "Changes", "History"]) {
    await openView(page, label, { modifiers: ["Meta"] });
  }
  await expect(page.locator("[data-pane]")).toHaveCount(4);
}

test.describe("M13 stage 3 review fixes: pane header layout", () => {
  test("Agents and Terminal .pane-view fill the pane solo and in a 4-pane split (C1)", async ({ page }) => {
    await page.goto("/");
    await dismissOnboarding(page);

    await openView(page, "Agents");
    await expect(page.getByRole("heading", { level: 1, name: "Agents", exact: true })).toBeVisible();
    expect(await heightRatio(pane(page, 0))).toBeGreaterThanOrEqual(0.9);

    await openView(page, "Terminal");
    await expect(page.getByRole("heading", { level: 1, name: "Terminal", exact: true })).toBeVisible();
    expect(await heightRatio(pane(page, 0))).toBeGreaterThanOrEqual(0.9);

    // C1 is specifically about Agents/Terminal (`ownsHeader` screens); other
    // screens keep their existing `.pane-tool` layout, untouched by this fix.
    await openFourPaneSplit(page);
    const agentsPane = page.locator("[data-pane]").filter({ has: page.getByRole("heading", { level: 1, name: "Agents" }) });
    const terminalPane = page.locator("[data-pane]").filter({ has: page.getByRole("heading", { level: 1, name: "Terminal" }) });
    expect(await heightRatio(agentsPane), "Agents pane in 4-split").toBeGreaterThanOrEqual(0.9);
    expect(await heightRatio(terminalPane), "Terminal pane in 4-split").toBeGreaterThanOrEqual(0.9);
  });

  test("Close pane is fully inside its header box and clickable in a 4-pane split (C2)", async ({ page }) => {
    await page.goto("/");
    await dismissOnboarding(page);
    await openFourPaneSplit(page);

    for (let i = 0; i < 4; i++) {
      const p = pane(page, i);
      const close = p.getByRole("button", { name: "Close pane", exact: true });
      await expect(close, `pane ${i} Close pane`).toBeVisible();
      const headerBox = (await header(p).boundingBox())!;
      const closeBox = (await close.boundingBox())!;
      expect(closeBox.y, `pane ${i} top`).toBeGreaterThanOrEqual(headerBox.y - 1);
      expect(closeBox.y + closeBox.height, `pane ${i} bottom`).toBeLessThanOrEqual(headerBox.y + headerBox.height + 1);
      // Hit-testable, not just geometrically inside the box (the original
      // bug: wrapped onto a clipped second line, so it never received the
      // click even though a bounding box existed).
      const hit = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return el?.closest("button")?.getAttribute("aria-label") === "Close pane";
        },
        [closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2] as const,
      );
      expect(hit, `pane ${i} hit-testable`).toBe(true);
    }

    await pane(page, 3).getByRole("button", { name: "Close pane", exact: true }).click();
    await expect(page.locator("[data-pane]")).toHaveCount(3);
  });

  test("the Agents status chip has nonzero width and its popover is not clipped (C3/C4)", async ({ page }) => {
    // Seeding a live agent session to exercise this in the running app
    // would need `useSessions.setState(...)` from the page: dynamic
    // `import("/src/agents/sessions.ts")` (and `/src/state/stage.ts`) from
    // Playwright's page context resolve to a *different* Vite module
    // instance than the one the mounted React tree subscribes to in this
    // dev server (verified: mutating the dynamically-imported store does
    // not change the rendered DOM), so it cannot drive the real app here.
    // The component behavior itself (portal creation, the dialog's role
    // and name, focus management, click-to-open/close) is already
    // exercised by Vitest in `AgentsScreen.test.tsx` ("solo session pane
    // header", "merged status chip…"), which jsdom runs for real. What
    // jsdom cannot see is actual CSS layout — exactly C3 (0px width) and
    // C4 (clipped popover) — so prove those two facts the way the code
    // reviewer did: real Chromium laying out the real, current CSS files
    // (via `file://` links, so this stays accurate as the CSS changes)
    // against markup matching `PaneHeader`/`SessionStatusChip`'s DOM.
    const repoRoot = path.resolve(__dirname, "..");
    const cssLinks = ["src/ui/ui.css", "src/stage/stage.css", "src/screens/agents/agents.css"]
      .map((p) => `<link rel="stylesheet" href="file://${repoRoot}/${p}">`)
      .join("\n");
    await page.setContent(`<!doctype html><html><head>
${cssLinks}
<style>body{margin:0;font:13px system-ui;--raised:#333;--fs-meta:12px;--fg3:#888;--line:#ccc;--s3:#222;--fg:#eee;--grn:#2a7}</style>
</head><body>
<div class="pane-header pane-header-active" style="width:262px;position:relative">
  <div class="pane-header-identity">Claude Code</div>
  <div class="pane-header-status">
    <span class="status-chip-wrap">
      <button type="button" class="status-chip" id="chip" aria-haspopup="dialog">
        <span class="status-chip-ring"></span>
        <span class="status-chip-pct">42%</span>
        <span class="status-chip-rtk" data-state="saved">RTK −12.3k</span>
        <span class="status-chip-account">Work</span>
      </button>
    </span>
  </div>
  <div class="pane-header-cluster"><button class="icon-btn" aria-label="Close pane">x</button></div>
</div>
<!-- C4: portaled to the body, position:fixed from the chip's own rect
     (set inline by SessionStatusChip), not nested inside the clipping
     .status-chip-wrap/.pane-header boxes above. -->
<div class="status-chip-pop" id="pop" role="dialog" style="position:fixed; left: 40px; top: 60px;">popover content</div>
</body></html>`);

    const chipBox = (await page.locator("#chip").boundingBox())!;
    expect(chipBox.width, "C3: chip wrap/button width").toBeGreaterThan(0);

    const popBox = (await page.locator("#pop").boundingBox())!;
    expect(popBox.width, "C4: popover width").toBeGreaterThan(0);
    const hit = await page.evaluate(() => {
      const pop = document.getElementById("pop")!;
      const r = pop.getBoundingClientRect();
      return document.elementFromPoint(r.left + 10, r.top + 10) === pop;
    });
    expect(hit, "C4: popover is hit-testable, not clipped behind another box").toBe(true);
  });
});
