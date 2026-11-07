import { expect, test, type Page } from "@playwright/test";

type SerializedDiffLine = {
  kind: "context" | "add" | "del";
  old: number | null;
  new: number | null;
  text: string;
  intra: { start: number; end: number; kind: "add" | "del" }[] | null;
};

type SerializedHunk = {
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  lines: SerializedDiffLine[];
};

type SerializedDiffModel = {
  hunks: SerializedHunk[];
  binary: boolean;
  truncated: boolean;
  bytes: number;
};

const SMALL_DIFF: SerializedDiffModel = {
  hunks: [
    {
      oldStart: 10,
      newStart: 10,
      oldLines: 3,
      newLines: 3,
      lines: [
        { kind: "context", old: 10, new: 10, text: "function foo() {", intra: null },
        {
          kind: "del",
          old: 11,
          new: null,
          text: "  return oldValue;",
          intra: [{ start: 9, end: 17, kind: "del" }],
        },
        {
          kind: "add",
          old: null,
          new: 11,
          text: "  return newValue;",
          intra: [{ start: 9, end: 17, kind: "add" }],
        },
        { kind: "context", old: 12, new: 12, text: "}", intra: null },
      ],
    },
  ],
  binary: false,
  truncated: false,
  bytes: 120,
};

/** ~5 000 lines across 20 hunks: a mix of context/add/del lines, 10% of which carry intra spans.
 * Context runs are capped at 6 lines (3 trailing + 3 leading, as real git gives with
 * `context_lines(3)`/`interhunk_lines(0)` -- see Task 02), so nothing collapses behind the
 * "unchanged lines" button and every one of the ~5 000 lines is a real rendered row. */
function buildBigDiff(): SerializedDiffModel {
  const hunks: SerializedHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (let h = 0; h < 20; h++) {
    const lines: SerializedDiffLine[] = [];
    const hunkOldStart = oldLine;
    const hunkNewStart = newLine;
    for (let i = 0; i < 250; i++) {
      const mod = i % 8;
      if (mod === 3) {
        const text = `  const legacyValue${h}_${i} = computeOldThing(${i});`;
        lines.push({ kind: "del", old: oldLine, new: null, text, intra: [{ start: 2, end: 14, kind: "del" }] });
        oldLine += 1;
      } else if (mod === 4) {
        const text = `  const freshValue${h}_${i} = computeNewThing(${i});`;
        lines.push({ kind: "add", old: null, new: newLine, text, intra: [{ start: 2, end: 13, kind: "add" }] });
        newLine += 1;
      } else {
        const text = `  // unchanged context line ${h}_${i}, nothing to see here`;
        lines.push({ kind: "context", old: oldLine, new: newLine, text, intra: null });
        oldLine += 1;
        newLine += 1;
      }
    }
    hunks.push({
      oldStart: hunkOldStart,
      newStart: hunkNewStart,
      oldLines: lines.filter((l) => l.kind !== "add").length,
      newLines: lines.filter((l) => l.kind !== "del").length,
      lines,
    });
  }
  const bytes = hunks.reduce((sum, h) => sum + h.lines.reduce((s, l) => s + l.text.length, 0), 0);
  return { hunks, binary: false, truncated: false, bytes };
}

const totalLines = (model: SerializedDiffModel) => model.hunks.reduce((sum, h) => sum + h.lines.length, 0);

/** Seeds a mocked Tauri backend: one project with worktree `/repos/main` already active, a
 * status summary with one staged and one unstaged entry, and `diff_file` resolving to whichever
 * fixture matches `path`. Mirrors the mock-IPC shape from `e2e/m1-stage3-graph.spec.ts`. */
async function seedChangesBackend(
  page: Page,
  diffsByPath: Record<string, SerializedDiffModel>,
  perf: boolean,
) {
  await page.addInitScript(
    ({ diffsByPath, perf }) => {
      const callbacks = new Map<number, (event: unknown) => void>();
      let callbackId = 0;

      // Perf instrumentation (only meaningful when `perf` is true): records, per diff_file
      // resolution, the time from "DiffModel available" to the first animation frame + macrotask
      // after the diff DOM actually appears -- our proxy for first paint.
      (window as unknown as { __perfResults: number[] }).__perfResults = [];
      let pendingT0: number | null = null;
      if (perf) {
        const startObserving = () => {
          const observer = new MutationObserver(() => {
            if (pendingT0 === null) return;
            if (!document.querySelector(".diff-hunks .diff-hunk")) return;
            const t0 = pendingT0;
            pendingT0 = null;
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                setTimeout(() => {
                  const t1 = performance.now();
                  (window as unknown as { __perfResults: number[] }).__perfResults.push(t1 - t0);
                }, 0);
              });
            });
          });
          observer.observe(document.body, { childList: true, subtree: true });
        };
        // addInitScript runs before `document.body` exists; defer until it does.
        if (document.body) startObserving();
        else document.addEventListener("DOMContentLoaded", startObserving, { once: true });
      }

      const internals = {
        transformCallback: (callback: (event: unknown) => void) => {
          const id = ++callbackId;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
          if (command === "plugin:event|listen") return args.handler;
          if (command === "plugin:event|unlisten") return undefined;
          switch (command) {
            case "groups_list":
              return [];
            case "projects_list":
              return [{ id: "p1", owner: null, name: "repo", localPath: "/repos/main", groupId: null }];
            case "settings_get":
              return null;
            case "settings_set":
              return undefined;
            case "worktree_list":
              return [
                {
                  path: "/repos/main",
                  branch: "main",
                  head: "a1",
                  ahead: 0,
                  behind: 0,
                  dirtyCount: 2,
                  state: "dirty",
                },
              ];
            case "pins_list":
              return [];
            case "status":
              return {
                staged: [
                  { path: "staged.ts", oldPath: null, indexStatus: "M", worktreeStatus: " ", bytes: 80, large: false },
                ],
                unstaged: Object.keys(diffsByPath).map((path) => ({
                  path,
                  oldPath: null,
                  indexStatus: " ",
                  worktreeStatus: "M",
                  bytes: 80,
                  large: false,
                })),
              };
            case "diff_file": {
              const model = diffsByPath[args.path as string];
              if (!model) throw new Error(`Unexpected diff_file path: ${String(args.path)}`);
              // Record "DiffModel available" right before the data reaches app code.
              pendingT0 = performance.now();
              return model;
            }
            default:
              throw new Error(`Unexpected mocked IPC command: ${command}`);
          }
        },
      };
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        configurable: true,
        value: internals,
      });
      Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
        configurable: true,
        value: { unregisterListener: (_event: string, id: number) => callbacks.delete(id) },
      });
    },
    { diffsByPath, perf },
  );
}

async function openChangesScreen(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "main, 2 changed" })).toBeVisible();
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Changes 1", exact: true })).toBeVisible();
}

test.describe("M2 Stage 1 Changes stub", () => {
  test("selects a file and renders its diff through DiffRenderer, including the split/inline toggle", async ({
    page,
  }) => {
    await seedChangesBackend(page, { "modified.ts": SMALL_DIFF }, false);
    await openChangesScreen(page);

    const row = page.locator(".changes-file-row", { hasText: "modified.ts" });
    await expect(row).toBeVisible();
    await expect(row.locator(".changes-file-status")).toHaveText("M");
    await row.click();

    // Hunk header renders through DiffRenderer.
    await expect(page.locator(".diff-hunk-header code")).toHaveText("@@ -10,3 +10,3 @@");

    // Intraline highlighting: both the deleted and added spans are marked.
    const marks = page.locator("mark.diff-intra");
    await expect(marks).toHaveCount(2);
    await expect(page.locator("mark.diff-intra-del")).toHaveText("oldValue");
    await expect(page.locator("mark.diff-intra-add")).toHaveText("newValue");

    // Split is the default layout: two independent line columns, no single inline row.
    const renderer = page.locator(".diff-renderer");
    await expect(renderer).toHaveAttribute("data-mode", "split");
    await expect(page.locator(".diff-split-line").first()).toBeVisible();
    await expect(page.locator(".diff-inline-line")).toHaveCount(0);

    // Toggle to inline and confirm the layout actually switches.
    await page.getByRole("radio", { name: "☰ Inline" }).click();
    await expect(renderer).toHaveAttribute("data-mode", "inline");
    await expect(page.locator(".diff-inline-line").first()).toBeVisible();
    await expect(page.locator(".diff-split-line")).toHaveCount(0);

    // And back to split via the same control.
    await page.getByRole("radio", { name: "◫ Side by side" }).click();
    await expect(renderer).toHaveAttribute("data-mode", "split");
    await expect(page.locator(".diff-split-line").first()).toBeVisible();
  });
});

test.describe("M2 Stage 1 diff-render performance (§9)", () => {
  test("renders a 5 000-line DiffModel to first paint, median/max over 5 runs", async ({ page }) => {
    const bigDiff = buildBigDiff();
    expect(totalLines(bigDiff)).toBeGreaterThanOrEqual(4_900);
    expect(totalLines(bigDiff)).toBeLessThanOrEqual(5_100);

    await seedChangesBackend(page, { "big.ts": bigDiff }, true);
    await openChangesScreen(page);

    const row = page.locator(".changes-file-row", { hasText: "big.ts" });
    await expect(row).toBeVisible();

    const RUNS = 5;
    for (let i = 0; i < RUNS; i++) {
      const before = await page.evaluate(() => (window as unknown as { __perfResults: number[] }).__perfResults.length);
      await row.click();
      await page.waitForFunction(
        (expected) => (window as unknown as { __perfResults: number[] }).__perfResults.length > expected,
        before,
        { timeout: 10_000 },
      );
    }

    const results = await page.evaluate(() => (window as unknown as { __perfResults: number[] }).__perfResults);
    expect(results.length).toBe(RUNS);

    const sorted = [...results].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const max = Math.max(...results);

    // eslint-disable-next-line no-console
    console.log(
      `[m2-stage1-perf] 5000-line diff render (DiffModel -> first paint), split mode, ${RUNS} runs: ` +
        `samples=${results.map((n) => n.toFixed(2)).join(", ")}ms median=${median.toFixed(2)}ms max=${max.toFixed(2)}ms`,
    );
    test.info().annotations.push({
      type: "perf",
      description: `median=${median.toFixed(2)}ms max=${max.toFixed(2)}ms samples=[${results.map((n) => n.toFixed(2)).join(", ")}]`,
    });

    // Sanity bound only (not the §9 100ms budget) -- this just guards against a measurement
    // that silently collected nothing or hung; see the review report for the real numbers
    // against the 100ms budget.
    expect(median).toBeLessThan(5_000);
  });
});
