# M0: Shell & Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Staged delivery:** This plan has 4 stages. Each stage ends with a **🛑 MANUAL TEST CHECKPOINT**. When you reach one, stop, report to the user how to run the app and what to check, and wait for their go-ahead before starting the next stage.

**Goal:** Build the Branchwork desktop app shell: a native macOS window with Liquid Glass sidebar, an OKLCH theme system with persisted settings, a UI kit (buttons, menus, toasts, `ask()` dialogs), placeholder screens for every menu, Arc-style split view, and a command palette with the global keyboard map. All UI text is English.

**Architecture:** Tauri 2 hosts a React 19 + TypeScript (Vite) frontend.
- **Rust:** owns a SQLite settings store exposed through two commands (`settings_get`, `settings_set`).
- **Frontend state:** Zustand stores. Pure logic (split-view reducer, fuzzy ranking, theme application, i18n) lives in small modules with Vitest unit tests. React components stay thin.
- **Screens:** every screen is a `{ Toolbar, View }` pair from one registry. Real screens replace the placeholders in later milestones.

**Tech Stack:**
- Tauri 2 with `windowEffects` vibrancy, `rusqlite` (bundled)
- React 19, TypeScript, Vite, Zustand
- Vitest + Testing Library + jsdom

**Spec:** `docs/superpowers/specs/2026-11-06-branchwork-design.md` (§3 Architecture, §5 Design system, §6.1 App shell). Visual reference: `docs/design/prototype.html`.

**Deliberately deferred from M0 (per YAGNI):**
- `tauri-specta` type generation. There are only 2 commands now; it is introduced in M1 when the IPC surface grows.
- Group switcher, project tabs, worktree list, terminal dock (M1/M3).
- Onboarding (M4, needs GitHub auth).

---

## File structure

```
package.json                     # scaffolded; add deps + scripts
vite.config.ts                   # + vitest config
tsconfig.json                    # + vitest types
src-tauri/
  Cargo.toml                     # + rusqlite, tauri macos-private-api feature
  tauri.conf.json                # window: transparent, overlay title bar, vibrancy, CSP
  capabilities/default.json      # + window drag permission
  src/lib.rs                     # app setup + settings commands
  src/store.rs                   # SQLite settings store (unit-tested)
src/
  main.tsx                       # entry, global CSS imports, tauri class flag
  App.tsx                        # composes shell + global hosts
  i18n/en.ts                     # English string catalog (single source of UI text)
  i18n/t.ts                      # t(key, vars) helper
  theme/tokens.css               # OKLCH design tokens (dark/light/solid/density)
  theme/theme.ts                 # ThemeSettings + applyTheme()
  ipc/settings.ts                # loadSetting/saveSetting (Tauri or localStorage fallback)
  state/settings.ts              # theme settings store (persisted)
  state/stage.ts                 # split-view store (persisted)
  stage/stageModel.ts            # pure split-view reducer functions
  stage/dnd.ts                   # drag MIME + side labels
  stage/splitMenu.tsx            # menu items for ⊞ split menu
  stage/Stage.tsx                # 1–2 panes, divider, drop zones
  stage/Pane.tsx                 # pane = toolbar + view
  stage/PaneControls.tsx         # ⊞ / ⇄ / ⬒ / ✕
  stage/stage.css
  screens/registry.ts            # ScreenId, SCREENS, NUMBER_KEYS
  screens/views.tsx              # ScreenId → { Toolbar, View } (placeholders + settings)
  screens/settings/SettingsScreen.tsx
  screens/settings/settings.css
  shell/TitleBar.tsx
  shell/Sidebar.tsx
  shell/shell.css
  ui/Button.tsx
  ui/controls.tsx                # Segmented, Switch, Kbd
  ui/Menu.tsx
  ui/toast.tsx                   # toast store + <Toaster/>
  ui/dialog.tsx                  # ask() + <DialogHost/>
  ui/ui.css
  palette/fuzzy.ts               # fuzzyScore + rank
  palette/store.ts               # palette open/query store
  palette/commands.ts            # command list builder
  palette/Palette.tsx
  palette/palette.css
  keys/globalKeys.ts             # handleGlobalKey + useGlobalKeys
  test/setup.ts                  # jest-dom matchers
  **/*.test.ts(x)                # tests next to the code they test
```

---

# STAGE 1: Native window, theme tokens, shell, placeholder screens

## Task 1: Scaffold the Tauri + React app

**Files:**
- Create: whole scaffold at repo root (`package.json`, `src/`, `src-tauri/`, `index.html`, `vite.config.ts`, `tsconfig*.json`)

- [ ] **Step 1: Scaffold into a temp dir, then move it to the repo root.** The repo root already has `docs/`, so we scaffold elsewhere and move.

```bash
cd /Users/apple/orca/projects/git-version-control
pnpm create tauri-app@latest .scaffold --template react-ts --manager pnpm --identifier dev.branchwork.app --yes
rsync -a .scaffold/ ./ && rm -rf .scaffold
```

Expected: `package.json`, `src/`, `src-tauri/`, and `index.html` now exist at the repo root.

- [ ] **Step 2: Install dependencies**

```bash
pnpm install
pnpm add zustand
pnpm add -D vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom
```

- [ ] **Step 3: Rename the product in `package.json`**

Set `"name": "branchwork"` and add these entries to `"scripts"` (keep the scaffolded `dev`, `build`, `preview`, `tauri` scripts):

```json
"test": "vitest run",
"test:watch": "vitest",
"typecheck": "tsc --noEmit"
```

- [ ] **Step 4: Replace `vite.config.ts`**

```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
```

- [ ] **Step 5: Add test types to `tsconfig.json`.** Inside `"compilerOptions"` add:

```json
"types": ["vitest/globals", "@testing-library/jest-dom"]
```

- [ ] **Step 6: Create `src/test/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 7: Delete scaffold demo files we won't use**

```bash
rm -f src/App.css src/assets/react.svg public/tauri.svg public/vite.svg
```

- [ ] **Step 8: Verify the toolchain runs**

Run: `pnpm typecheck`
Expected: errors only about the missing `App.css`/`react.svg` imports in `src/App.tsx`, which is replaced in Task 4. If there are other errors, fix them before continuing.

Run: `pnpm test`
Expected: `No test files found` (exit code 1 is fine at this point).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold Tauri 2 + React + TS app with vitest"
```

## Task 2: Native macOS window (transparent, overlay title bar, vibrancy, CSP)

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Replace `src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Branchwork",
  "version": "0.1.0",
  "identifier": "dev.branchwork.app",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "macOSPrivateApi": true,
    "windows": [
      {
        "title": "Branchwork",
        "width": 1440,
        "height": 900,
        "minWidth": 1000,
        "minHeight": 640,
        "transparent": true,
        "titleBarStyle": "Overlay",
        "hiddenTitle": true,
        "windowEffects": { "effects": ["sidebar"], "state": "followsWindowActiveState" }
      }
    ],
    "security": {
      "csp": "default-src 'self' ipc: http://ipc.localhost; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
      "devCsp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"]
  }
}
```

- [ ] **Step 2: Enable the private-API feature (required for transparent windows on macOS).** In `src-tauri/Cargo.toml`, change the `tauri` dependency line to include the feature, keeping the version the scaffold chose:

```toml
tauri = { version = "2", features = ["macos-private-api"] }
```

- [ ] **Step 3: Allow dragging the window from our custom title bar.** In `src-tauri/capabilities/default.json`, add `"core:window:allow-start-dragging"` to the `"permissions"` array. Keep the existing entries.

- [ ] **Step 4: Verify that the Rust side compiles**

Run: `cd src-tauri && cargo check && cd ..`
Expected: `Finished` with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(window): transparent overlay window with sidebar vibrancy and CSP"
```

## Task 3: Theme tokens, `applyTheme`, and the English string catalog

**Files:**
- Create: `src/theme/tokens.css`
- Create: `src/theme/theme.ts`
- Test: `src/theme/theme.test.ts`
- Create: `src/i18n/en.ts`
- Create: `src/i18n/t.ts`
- Test: `src/i18n/t.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/i18n/t.test.ts`:

```ts
import { t } from "./t";

describe("t", () => {
  it("returns the English string for a key", () => {
    expect(t("nav.changes")).toBe("Changes");
  });
  it("interpolates {vars}", () => {
    expect(t("palette.goTo", { screen: "Graph" })).toBe("Go to Graph");
  });
});
```

`src/theme/theme.test.ts`:

```ts
import { applyTheme, DEFAULT_THEME, resolveMode } from "./theme";

describe("resolveMode", () => {
  it("follows the system for 'system'", () => {
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
  });
  it("keeps explicit modes", () => {
    expect(resolveMode("light", true)).toBe("light");
  });
});

describe("applyTheme", () => {
  it("writes theme attributes and token inputs to the root element", () => {
    const root = document.createElement("div");
    applyTheme({ ...DEFAULT_THEME, mode: "light", accentHue: 25, contrast: 1.4, reduceTransparency: true, density: "compact" }, root, true);
    expect(root.dataset.theme).toBe("light");
    expect(root.style.getPropertyValue("--ah")).toBe("25");
    expect(root.style.getPropertyValue("--k")).toBe("1.4");
    expect(root.dataset.density).toBe("compact");
    expect(root.hasAttribute("data-solid")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL, because `./t` and `./theme` cannot be resolved.

- [ ] **Step 3: Create `src/i18n/en.ts`** (the full M0 catalog; later stages only use keys defined here)

```ts
export const en = {
  "app.name": "Branchwork",
  "nav.launchpad": "Launchpad",
  "nav.graph": "Graph",
  "nav.files": "Files & editor",
  "nav.changes": "Changes",
  "nav.agents": "Agents",
  "nav.prs": "Pull requests",
  "nav.repo": "Repository",
  "nav.inbox": "Inbox",
  "nav.settings": "Settings",
  "tools.conflicts": "Resolve conflicts",
  "tools.rebase": "Interactive rebase",
  "tools.blame": "Blame & history",
  "tools.compare": "Compare worktrees",
  "sidebar.worktrees": "Worktrees",
  "sidebar.tools": "Tools",
  "sidebar.noRepo": "Open a repository to see its worktrees",
  "sidebar.splitHint": "⌘-click: split right · ⌥-click: split bottom · drag onto content",
  "search.placeholder": "Search, jump, or ask Claude…",
  "placeholder.body": "This screen arrives in a later milestone.",
  "dialog.cancel": "Cancel",
  "dialog.ok": "OK",
  "toast.undo": "Undo",
  "split.menuTitle": "Split with…",
  "split.menuNote": "Click = split right · icons pick a side · or drag a sidebar item onto the content",
  "split.left": "Split left",
  "split.right": "Split right",
  "split.top": "Split top",
  "split.bottom": "Split bottom",
  "split.openHere": "Open here",
  "split.close": "Close pane",
  "split.swap": "Swap panes",
  "split.orientation": "Toggle orientation",
  "split.closeFromSplit": "Remove from split",
  "split.dropHint": "Drop on the left, right, top, or bottom edge",
  "split.alreadyOpen": "{screen} is already open",
  "split.resizeHint": "Drag to resize · double-click to reset",
  "settings.appearance": "Appearance",
  "settings.theme": "Theme",
  "settings.theme.system": "System",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.accent": "Accent",
  "settings.baseTint": "Base tint",
  "settings.contrast": "Contrast",
  "settings.reduceTransparency": "Reduce transparency",
  "settings.density": "Density",
  "settings.density.compact": "Compact",
  "settings.density.default": "Default",
  "settings.density.comfy": "Comfy",
  "settings.demo": "Component preview",
  "settings.demo.toast": "Show toast",
  "settings.demo.confirm": "Confirm dialog",
  "settings.demo.danger": "Danger dialog",
  "settings.demo.input": "Input dialog",
  "demo.toast.title": "Settings saved",
  "demo.toast.detail": "Toasts can carry an undo action",
  "demo.undone": "Undone",
  "demo.confirm.title": "Push 2 commits?",
  "demo.confirm.body": "Pushes feat/auth-oauth to origin.",
  "demo.confirm.ok": "Push",
  "demo.danger.title": "Discard all changes?",
  "demo.danger.body": "All unstaged changes will be discarded. You can undo from the toast.",
  "demo.danger.ok": "Discard all",
  "demo.input.title": "New file",
  "demo.input.body": "Path relative to the worktree root.",
  "demo.input.ok": "Create file",
  "demo.result.confirmed": "Confirmed",
  "demo.result.cancelled": "Cancelled",
  "demo.result.created": "Created {name}",
  "palette.placeholder": "Type a command or screen, or end with ? to ask Claude…",
  "palette.empty": "No results",
  "palette.nav": "navigate",
  "palette.run": "run",
  "palette.close": "close",
  "palette.askHint": "End with “?” to ask Claude",
  "palette.group.navigate": "Navigate",
  "palette.group.split": "Split view",
  "palette.group.appearance": "Appearance",
  "palette.group.ai": "AI",
  "palette.goTo": "Go to {screen}",
  "palette.splitRight": "Split right with {screen}",
  "palette.splitBottom": "Split bottom with {screen}",
  "palette.closeSplit": "Close split view",
  "palette.swapSplit": "Swap split panes",
  "palette.toggleTheme": "Toggle dark / light",
  "palette.askClaude": "Ask Claude: {q}",
  "palette.aiLater": "Claude integration arrives in a later milestone",
} as const;

export type MsgKey = keyof typeof en;
```

- [ ] **Step 4: Create `src/i18n/t.ts`**

```ts
import { en, type MsgKey } from "./en";

export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  let s: string = en[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
```

- [ ] **Step 5: Create `src/theme/theme.ts`**

```ts
export type ThemeMode = "system" | "light" | "dark";
export type Density = "compact" | "default" | "comfy";

export interface ThemeSettings {
  mode: ThemeMode;
  accentHue: number;
  baseHue: number;
  contrast: number;
  reduceTransparency: boolean;
  density: Density;
}

export const DEFAULT_THEME: ThemeSettings = {
  mode: "dark",
  accentHue: 250,
  baseHue: 265,
  contrast: 1,
  reduceTransparency: false,
  density: "default",
};

export const prefersDark = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

export function resolveMode(mode: ThemeMode, systemDark: boolean): "light" | "dark" {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}

export function applyTheme(s: ThemeSettings, root: HTMLElement = document.documentElement, systemDark = prefersDark()): void {
  root.dataset.theme = resolveMode(s.mode, systemDark);
  root.style.setProperty("--ah", String(s.accentHue));
  root.style.setProperty("--bh", String(s.baseHue));
  root.style.setProperty("--k", String(s.contrast));
  root.dataset.density = s.density;
  root.toggleAttribute("data-solid", s.reduceTransparency);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS (5 tests).

- [ ] **Step 7: Create `src/theme/tokens.css`** (CSS, not unit-tested; verified at the checkpoint)

```css
:root { --ah: 250; --bh: 265; --k: 1; color-scheme: dark; }
:root {
  --glass: oklch(.22 .014 var(--bh) / .42);
  --glass2: oklch(.30 .016 var(--bh) / .62);
  --surf: oklch(.155 .009 var(--bh) / .94);
  --s2: oklch(.21 .011 var(--bh));
  --s3: oklch(.27 .013 var(--bh));
  --s4: oklch(.33 .015 var(--bh));
  --line: oklch(1 0 0 / calc(.07 * var(--k)));
  --line2: oklch(1 0 0 / calc(.13 * var(--k)));
  --spec: inset 0 1px 0 oklch(1 0 0 / .14), inset 0 -1px 0 oklch(0 0 0 / .25);
  --fg: oklch(.97 .004 var(--bh));
  --fg2: oklch(calc(.62 + .1 * var(--k)) .012 var(--bh));
  --fg3: oklch(calc(.45 + .08 * var(--k)) .014 var(--bh));
  --acc: oklch(.68 .19 var(--ah));
  --accs: oklch(.68 .19 var(--ah) / .16);
  --on-acc: #fff;
  --grn: oklch(.77 .16 155);
  --red: oklch(.68 .2 22);
  --yel: oklch(.83 .15 85);
  --blu: oklch(.72 .14 245);
  --pur: oklch(.71 .17 300);
  --shadow-pop: 0 24px 60px -16px oklch(0 0 0 / .6);
  --spring: cubic-bezier(.34, 1.56, .64, 1);
  --row-h: 30px;
  --font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  --font-mono: "SF Mono", ui-monospace, Menlo, monospace;
}
:root[data-theme="light"] {
  color-scheme: light;
  --glass: oklch(.98 .005 var(--bh) / .45);
  --glass2: oklch(1 0 0 / .7);
  --surf: oklch(.99 .003 var(--bh) / .96);
  --s2: oklch(.955 .006 var(--bh));
  --s3: oklch(.92 .008 var(--bh));
  --s4: oklch(.88 .01 var(--bh));
  --line: oklch(0 0 0 / calc(.07 * var(--k)));
  --line2: oklch(0 0 0 / calc(.12 * var(--k)));
  --spec: inset 0 1px 0 oklch(1 0 0 / .9), inset 0 -1px 0 oklch(0 0 0 / .06);
  --fg: oklch(.2 .012 var(--bh));
  --fg2: oklch(calc(.47 - .08 * var(--k)) .014 var(--bh));
  --fg3: oklch(calc(.64 - .07 * var(--k)) .014 var(--bh));
  --acc: oklch(.58 .2 var(--ah));
  --accs: oklch(.58 .2 var(--ah) / .12);
  --grn: oklch(.6 .16 155);
  --red: oklch(.58 .21 22);
  --yel: oklch(.68 .15 75);
  --blu: oklch(.58 .17 245);
  --pur: oklch(.56 .2 300);
  --shadow-pop: 0 24px 60px -20px oklch(0 0 0 / .35);
}
:root[data-density="compact"] { --row-h: 26px; }
:root[data-density="comfy"] { --row-h: 34px; }
:root[data-solid] { --glass: oklch(.2 .012 var(--bh)); --glass2: oklch(.26 .014 var(--bh)); }
:root[data-solid][data-theme="light"] { --glass: oklch(.95 .006 var(--bh)); --glass2: oklch(.985 .004 var(--bh)); }
@media (prefers-reduced-transparency: reduce) {
  :root { --glass: oklch(.2 .012 var(--bh)); --glass2: oklch(.26 .014 var(--bh)); }
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
html, body { background: transparent; }
/* In a plain browser (no native vibrancy) show a backdrop so glass is visible. */
html:not(.tauri) body { background: radial-gradient(60% 60% at 20% 10%, oklch(.45 .15 280), transparent 70%), radial-gradient(50% 60% at 90% 90%, oklch(.5 .12 200), transparent 70%), oklch(.2 .03 270); }
body { color: var(--fg); font: 13px/1.45 var(--font-ui); -webkit-font-smoothing: antialiased; overflow: hidden; user-select: none; }
button { font: inherit; color: inherit; }
input, textarea { user-select: text; }
:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
```

- [ ] **Step 8: Commit**

```bash
git add src/theme src/i18n
git commit -m "feat(theme): OKLCH tokens, applyTheme and English string catalog"
```

## Task 4: Screen registry, stage store (single pane), shell layout, placeholder screens

**Files:**
- Create: `src/screens/registry.ts`
- Create: `src/stage/stageModel.ts`
- Test: `src/stage/stageModel.test.ts`
- Create: `src/state/stage.ts`
- Create: `src/screens/views.tsx`
- Create: `src/stage/Pane.tsx`, `src/stage/Stage.tsx`, `src/stage/stage.css`
- Create: `src/shell/TitleBar.tsx`, `src/shell/Sidebar.tsx`, `src/shell/shell.css`
- Replace: `src/App.tsx`, `src/main.tsx`

- [ ] **Step 1: Create `src/screens/registry.ts`**

```ts
import type { MsgKey } from "../i18n/en";

export type ScreenId =
  | "launchpad" | "graph" | "files" | "changes" | "agents" | "prs" | "repo" | "inbox"
  | "conflicts" | "rebase" | "blame" | "compare" | "settings";

export interface ScreenDef {
  id: ScreenId;
  icon: string;
  label: MsgKey;
  section: "nav" | "tools" | "footer";
}

export const SCREENS: ScreenDef[] = [
  { id: "launchpad", icon: "⌂", label: "nav.launchpad", section: "nav" },
  { id: "graph", icon: "⎇", label: "nav.graph", section: "nav" },
  { id: "files", icon: "▤", label: "nav.files", section: "nav" },
  { id: "changes", icon: "±", label: "nav.changes", section: "nav" },
  { id: "agents", icon: "✦", label: "nav.agents", section: "nav" },
  { id: "prs", icon: "⇄", label: "nav.prs", section: "nav" },
  { id: "repo", icon: "◫", label: "nav.repo", section: "nav" },
  { id: "inbox", icon: "◉", label: "nav.inbox", section: "nav" },
  { id: "conflicts", icon: "⚠", label: "tools.conflicts", section: "tools" },
  { id: "rebase", icon: "↕", label: "tools.rebase", section: "tools" },
  { id: "blame", icon: "≡", label: "tools.blame", section: "tools" },
  { id: "compare", icon: "⇆", label: "tools.compare", section: "tools" },
  { id: "settings", icon: "⚙", label: "nav.settings", section: "footer" },
];

export const SCREEN_IDS = SCREENS.map((s) => s.id);

export const screenById = (id: ScreenId): ScreenDef => SCREENS.find((s) => s.id === id)!;

/** Screens reachable with the number keys 1–9 (spec §6.1.6). */
export const NUMBER_KEYS: ScreenId[] = ["launchpad", "graph", "files", "changes", "agents", "prs", "repo", "inbox", "conflicts"];
```

- [ ] **Step 2: Write the failing reducer test** `src/stage/stageModel.test.ts`

```ts
import { initialStage, navigate, setFocus, type StageState } from "./stageModel";

const two: StageState = { panes: ["agents", "changes"], focus: 0, dir: "h", ratio: 0.5 };

describe("navigate", () => {
  it("replaces the focused pane's screen", () => {
    expect(navigate(initialStage, "graph").panes).toEqual(["graph"]);
  });
  it("focuses the other pane if it already shows that screen", () => {
    const s = navigate(two, "changes");
    expect(s.panes).toEqual(["agents", "changes"]);
    expect(s.focus).toBe(1);
  });
});

describe("setFocus", () => {
  it("ignores out-of-range panes", () => {
    expect(setFocus(initialStage, 1)).toBe(initialStage);
    expect(setFocus(two, 1).focus).toBe(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test src/stage`
Expected: FAIL, because `./stageModel` cannot be resolved.

- [ ] **Step 4: Create `src/stage/stageModel.ts`** (Stage 3 extends this file)

```ts
import type { ScreenId } from "../screens/registry";

export type Side = "left" | "right" | "top" | "bottom";
export type Dir = "h" | "v";

export interface StageState {
  panes: ScreenId[]; // 1 or 2 entries, never the same screen twice
  focus: number;
  dir: Dir;
  ratio: number; // size of pane 0, 0.2–0.8
}

export const initialStage: StageState = { panes: ["launchpad"], focus: 0, dir: "h", ratio: 0.5 };

export function navigate(s: StageState, id: ScreenId): StageState {
  const j = s.panes.indexOf(id);
  if (j >= 0) return { ...s, focus: j };
  const panes = [...s.panes];
  panes[s.focus] = id;
  return { ...s, panes };
}

export function setFocus(s: StageState, i: number): StageState {
  return i >= 0 && i < s.panes.length ? { ...s, focus: i } : s;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test src/stage`
Expected: PASS (3 tests).

- [ ] **Step 6: Create `src/state/stage.ts`** (single-pane version; replaced in Task 11)

```ts
import { create } from "zustand";
import { initialStage, navigate, setFocus, type StageState } from "../stage/stageModel";
import type { ScreenId } from "../screens/registry";

interface StageStore extends StageState {
  go(id: ScreenId): void;
  focusPane(i: number): void;
}

const pick = (s: StageState): StageState => ({ panes: s.panes, focus: s.focus, dir: s.dir, ratio: s.ratio });

export const useStage = create<StageStore>((set, get) => ({
  ...initialStage,
  go: (id) => set(navigate(pick(get()), id)),
  focusPane: (i) => set(setFocus(pick(get()), i)),
}));
```

- [ ] **Step 7: Create `src/screens/views.tsx`**

```tsx
import type { FC } from "react";
import { SCREENS, screenById, type ScreenId } from "./registry";
import { t } from "../i18n/t";

export interface ScreenView {
  Toolbar: FC;
  View: FC;
}

function placeholder(id: ScreenId): ScreenView {
  const def = screenById(id);
  return {
    Toolbar: () => <h1 className="pane-title">{t(def.label)}</h1>,
    View: () => (
      <div className="placeholder">
        <div className="placeholder-icon" aria-hidden>{def.icon}</div>
        <h2>{t(def.label)}</h2>
        <p>{t("placeholder.body")}</p>
      </div>
    ),
  };
}

export const VIEWS = Object.fromEntries(SCREENS.map((s) => [s.id, placeholder(s.id)])) as Record<ScreenId, ScreenView>;
```

- [ ] **Step 8: Create `src/stage/Pane.tsx`**

```tsx
import { useStage } from "../state/stage";
import { VIEWS } from "../screens/views";

export function Pane({ index }: { index: number }) {
  const id = useStage((s) => s.panes[index]);
  const focused = useStage((s) => s.panes.length > 1 && s.focus === index);
  const focusPane = useStage((s) => s.focusPane);
  const { Toolbar, View } = VIEWS[id];
  return (
    <section className={"pane" + (focused ? " focus" : "")} data-pane={index} onMouseDown={() => focusPane(index)}>
      <header className="pane-tool">
        <Toolbar />
      </header>
      <div className="pane-view" key={id}>
        <View />
      </div>
    </section>
  );
}
```

- [ ] **Step 9: Create `src/stage/Stage.tsx`** (single pane; replaced in Task 12)

```tsx
import { Pane } from "./Pane";

export function Stage() {
  return (
    <div className="stage">
      <Pane index={0} />
    </div>
  );
}
```

- [ ] **Step 10: Create `src/stage/stage.css`**

```css
.stage { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); min-width: 0; min-height: 0; position: relative; }
.pane { display: grid; grid-template-rows: 52px minmax(0, 1fr); min-width: 0; min-height: 0; border-radius: 16px; background: var(--surf); box-shadow: var(--spec), 0 0 0 .5px var(--line2); overflow: hidden; container-type: inline-size; transition: box-shadow .2s; }
.pane-tool { display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--line); }
.pane-title { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -.01em; white-space: nowrap; }
.pane-view { min-height: 0; overflow: auto; animation: pane-in .3s var(--spring); }
@keyframes pane-in { from { opacity: 0; transform: translateY(6px); } }
.placeholder { height: 100%; display: grid; place-content: center; text-align: center; color: var(--fg3); gap: 6px; }
.placeholder-icon { font-size: 34px; color: var(--acc); }
.placeholder h2 { margin: 0; color: var(--fg); font-size: 18px; }
.placeholder p { margin: 0; }
```

- [ ] **Step 11: Create `src/shell/TitleBar.tsx`**

```tsx
import { t } from "../i18n/t";

export function TitleBar() {
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="traffic-space" data-tauri-drag-region />
      <span className="app-name" data-tauri-drag-region>{t("app.name")}</span>
      <button className="search" onClick={() => window.dispatchEvent(new CustomEvent("bw:palette"))}>
        <span aria-hidden>⌕</span>
        <span className="search-label">{t("search.placeholder")}</span>
        <kbd className="kbd">⌘K</kbd>
      </button>
      <div className="title-right" data-tauri-drag-region />
    </header>
  );
}
```

- [ ] **Step 12: Create `src/shell/Sidebar.tsx`** (Stage 3 replaces it with a split-aware version)

```tsx
import { SCREENS, screenById, type ScreenDef } from "../screens/registry";
import { useStage } from "../state/stage";
import { t } from "../i18n/t";

export function Sidebar() {
  const panes = useStage((s) => s.panes);
  const focus = useStage((s) => s.focus);
  const go = useStage((s) => s.go);
  const item = (s: ScreenDef) => (
    <button
      key={s.id}
      className={"nav" + (panes[focus] === s.id ? " on" : panes.includes(s.id) ? " on2" : "")}
      onClick={() => go(s.id)}
    >
      <span className="nav-ic" aria-hidden>{s.icon}</span>
      <span className="nav-label">{t(s.label)}</span>
    </button>
  );
  return (
    <aside className="sidebar">
      <nav className="side-scroll">
        {SCREENS.filter((s) => s.section === "nav").map(item)}
        <div className="side-h">{t("sidebar.worktrees")}</div>
        <div className="side-empty">{t("sidebar.noRepo")}</div>
        <div className="side-h">{t("sidebar.tools")}</div>
        {SCREENS.filter((s) => s.section === "tools").map(item)}
      </nav>
      <div className="side-foot">{item(screenById("settings"))}</div>
    </aside>
  );
}
```

- [ ] **Step 13: Create `src/shell/shell.css`**

```css
.app { height: 100vh; display: grid; grid-template-rows: 46px minmax(0, 1fr); }
.titlebar { display: flex; align-items: center; gap: 12px; padding: 0 14px 0 0; }
.traffic-space { width: 78px; height: 100%; flex: none; }
.app-name { font-weight: 650; color: var(--fg2); }
.search { margin: 0 auto; display: flex; align-items: center; gap: 8px; width: min(440px, 36vw); padding: 6px 12px; border: 0; border-radius: 999px; background: var(--glass); box-shadow: var(--spec); color: var(--fg3); cursor: pointer; }
.search:hover { background: var(--glass2); }
.search .kbd { margin-left: auto; }
.search-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title-right { width: 78px; height: 100%; }
.body { display: grid; grid-template-columns: 232px minmax(0, 1fr); gap: 8px; min-height: 0; padding: 0 8px 8px 8px; }
.sidebar { display: flex; flex-direction: column; min-height: 0; border-radius: 16px; background: var(--glass); box-shadow: var(--spec); overflow: hidden; }
.side-scroll { flex: 1; overflow: auto; padding: 6px 8px 10px; display: flex; flex-direction: column; gap: 1px; }
.side-h { padding: 14px 8px 4px; font-size: 11px; font-weight: 600; color: var(--fg3); text-transform: uppercase; letter-spacing: .03em; }
.side-empty { padding: 4px 8px 6px; font-size: 12px; color: var(--fg3); }
.side-foot { border-top: 1px solid var(--line); padding: 6px 8px; }
.nav { display: flex; align-items: center; gap: 9px; width: 100%; height: var(--row-h); padding: 0 8px; border: 0; border-radius: 9px; background: none; color: var(--fg2); font-weight: 500; text-align: left; cursor: pointer; }
.nav:hover { background: var(--glass2); color: var(--fg); }
.nav.on { background: var(--accs); color: var(--fg); }
.nav.on .nav-ic { color: var(--acc); }
.nav.on2 { background: var(--s2); color: var(--fg); }
.nav-ic { width: 18px; text-align: center; color: var(--fg3); }
.nav-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-split { font-size: 11px; color: var(--acc); }
```

- [ ] **Step 14: Replace `src/App.tsx`**

```tsx
import { useEffect } from "react";
import { TitleBar } from "./shell/TitleBar";
import { Sidebar } from "./shell/Sidebar";
import { Stage } from "./stage/Stage";
import { applyTheme, DEFAULT_THEME } from "./theme/theme";

export default function App() {
  useEffect(() => applyTheme(DEFAULT_THEME), []);
  return (
    <div className="app">
      <TitleBar />
      <div className="body">
        <Sidebar />
        <Stage />
      </div>
    </div>
  );
}
```

- [ ] **Step 15: Replace `src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme/tokens.css";
import "./shell/shell.css";
import "./stage/stage.css";

if ("__TAURI_INTERNALS__" in window) document.documentElement.classList.add("tauri");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 16: Add a smoke test** `src/App.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

it("navigates between placeholder screens from the sidebar", async () => {
  render(<App />);
  expect(screen.getByRole("heading", { level: 2, name: "Launchpad" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Changes/ }));
  expect(screen.getByRole("heading", { level: 2, name: "Changes" })).toBeInTheDocument();
});
```

- [ ] **Step 17: Run the full gate**

Run: `pnpm typecheck && pnpm test`
Expected: no type errors; all tests PASS (8 tests).

- [ ] **Step 18: Commit**

```bash
git add -A
git commit -m "feat(shell): title bar, glass sidebar, placeholder screens and navigation"
```

## 🛑 MANUAL TEST CHECKPOINT 1

Stop here. Give the user these instructions:

**Run:** `pnpm tauri dev`. The first Rust build takes a few minutes.

**Check:**
1. A native macOS window opens with traffic lights at the top-left, over the app's own title bar. There is no grey system title bar.
2. The sidebar is translucent and the desktop or wallpaper blurs through it (vibrancy). The main content panel is near-opaque.
3. Dragging the empty title-bar area moves the window.
4. Each sidebar item (Launchpad, Graph, Files & editor, Changes, Agents, Pull requests, Repository, Inbox, the 4 Tools items, and Settings) shows its own placeholder screen with the matching icon and title. The active item is highlighted.
5. All text is in English.
6. Optional: `pnpm dev` and open http://localhost:1420 in a browser. The same UI appears over a gradient backdrop.

Wait for the user's go-ahead before starting Stage 2.

---

# STAGE 2: Persisted settings, UI kit, toasts, dialogs, Settings screen

## Task 5: SQLite settings store in Rust + IPC commands

**Files:**
- Create: `src-tauri/src/store.rs`
- Replace: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the dependency**

```bash
cd src-tauri && cargo add rusqlite --features bundled && cd ..
```

- [ ] **Step 2: Write `src-tauri/src/store.rs` with its failing test first.** The test module is at the bottom; `get` and `set` start as `todo!()`.

```rust
use rusqlite::{params, Connection, OptionalExtension};
use std::{path::Path, sync::Mutex};

/// Key/value settings persisted in SQLite (spec §3.4). Values are JSON strings owned by the UI.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Self::init(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn get(&self, _key: &str) -> rusqlite::Result<Option<String>> {
        todo!()
    }

    pub fn set(&self, _key: &str, _value: &str) -> rusqlite::Result<()> {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_key_is_none() {
        let s = Store::in_memory().unwrap();
        assert_eq!(s.get("theme").unwrap(), None);
    }

    #[test]
    fn set_then_get_and_overwrite() {
        let s = Store::in_memory().unwrap();
        s.set("theme", r#"{"mode":"dark"}"#).unwrap();
        assert_eq!(s.get("theme").unwrap().as_deref(), Some(r#"{"mode":"dark"}"#));
        s.set("theme", r#"{"mode":"light"}"#).unwrap();
        assert_eq!(s.get("theme").unwrap().as_deref(), Some(r#"{"mode":"light"}"#));
    }
}
```

Add `mod store;` as the first line of `src-tauri/src/lib.rs` so the module compiles.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test store && cd ..`
Expected: FAIL with `not yet implemented`.

- [ ] **Step 4: Implement `get` and `set`.** Replace the two `todo!()` methods:

```rust
    pub fn get(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
    }

    pub fn set(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test store && cd ..`
Expected: PASS (2 tests).

- [ ] **Step 6: Replace `src-tauri/src/lib.rs`** to wire up the store and the commands

```rust
mod store;

use store::Store;
use tauri::{Manager, State};

#[tauri::command]
fn settings_get(store: State<'_, Store>, key: String) -> Result<Option<String>, String> {
    store.get(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_set(store: State<'_, Store>, key: String, value: String) -> Result<(), String> {
    store.set(&key, &value).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir.join("app.db")).map_err(|e| e.to_string())?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![settings_get, settings_set])
        .run(tauri::generate_context!())
        .expect("error while running Branchwork");
}
```

- [ ] **Step 7: Verify the build and lints**

Run: `cd src-tauri && cargo clippy -- -D warnings && cargo test && cd ..`
Expected: no warnings; 2 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri
git commit -m "feat(store): SQLite settings store with settings_get/settings_set commands"
```

## Task 6: Settings IPC wrapper + persisted theme store

**Files:**
- Create: `src/ipc/settings.ts`
- Create: `src/state/settings.ts`
- Test: `src/state/settings.test.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create `src/ipc/settings.ts`.** Outside Tauri (plain browser, tests) it falls back to `localStorage`.

```ts
import { invoke } from "@tauri-apps/api/core";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function loadSetting<T>(key: string): Promise<T | null> {
  try {
    const raw = inTauri() ? await invoke<string | null>("settings_get", { key }) : localStorage.getItem("bw:" + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // corrupt or unreadable settings fall back to defaults
  }
}

export async function saveSetting(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  if (inTauri()) await invoke("settings_set", { key, value: json });
  else localStorage.setItem("bw:" + key, json);
}
```

- [ ] **Step 2: Write the failing test** `src/state/settings.test.ts`

```ts
import { useSettings } from "./settings";
import { DEFAULT_THEME } from "../theme/theme";

beforeEach(() => {
  localStorage.clear();
  useSettings.setState({ theme: DEFAULT_THEME, loaded: false });
});

it("persists theme changes and restores them on load", async () => {
  useSettings.getState().setTheme({ mode: "light", accentHue: 25 });
  expect(document.documentElement.dataset.theme).toBe("light");
  await new Promise((r) => setTimeout(r, 0));
  useSettings.setState({ theme: DEFAULT_THEME, loaded: false });
  await useSettings.getState().load();
  expect(useSettings.getState().theme.accentHue).toBe(25);
  expect(useSettings.getState().loaded).toBe(true);
});

it("fills missing fields from defaults when loading older settings", async () => {
  localStorage.setItem("bw:theme", JSON.stringify({ mode: "light" }));
  await useSettings.getState().load();
  expect(useSettings.getState().theme).toEqual({ ...DEFAULT_THEME, mode: "light" });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test src/state`
Expected: FAIL, because `./settings` cannot be resolved.

- [ ] **Step 4: Create `src/state/settings.ts`**

```ts
import { create } from "zustand";
import { applyTheme, DEFAULT_THEME, type ThemeSettings } from "../theme/theme";
import { loadSetting, saveSetting } from "../ipc/settings";

interface SettingsStore {
  theme: ThemeSettings;
  loaded: boolean;
  setTheme(patch: Partial<ThemeSettings>): void;
  load(): Promise<void>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  theme: DEFAULT_THEME,
  loaded: false,
  setTheme(patch) {
    const theme = { ...get().theme, ...patch };
    set({ theme });
    applyTheme(theme);
    void saveSetting("theme", theme);
  },
  async load() {
    const saved = await loadSetting<Partial<ThemeSettings>>("theme");
    const theme = { ...DEFAULT_THEME, ...(saved ?? {}) };
    set({ theme, loaded: true });
    applyTheme(theme);
  },
}));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test src/state`
Expected: PASS (2 tests).

- [ ] **Step 6: Load settings on startup and follow system appearance changes.** Replace `src/App.tsx`:

```tsx
import { useEffect } from "react";
import { TitleBar } from "./shell/TitleBar";
import { Sidebar } from "./shell/Sidebar";
import { Stage } from "./stage/Stage";
import { useSettings } from "./state/settings";
import { applyTheme } from "./theme/theme";

export default function App() {
  useEffect(() => {
    void useSettings.getState().load();
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(useSettings.getState().theme);
    mq?.addEventListener("change", onChange);
    return () => mq?.removeEventListener("change", onChange);
  }, []);
  return (
    <div className="app">
      <TitleBar />
      <div className="body">
        <Sidebar />
        <Stage />
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Run the gate and commit**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

```bash
git add src
git commit -m "feat(settings): persisted theme store via Tauri IPC with browser fallback"
```

## Task 7: UI kit: Button, controls, Menu, toasts, `ask()` dialog

**Files:**
- Create: `src/ui/Button.tsx`, `src/ui/controls.tsx`, `src/ui/Menu.tsx`, `src/ui/toast.tsx`, `src/ui/dialog.tsx`, `src/ui/ui.css`
- Test: `src/ui/toast.test.ts`, `src/ui/dialog.test.tsx`
- Modify: `src/App.tsx`, `src/main.tsx`

- [ ] **Step 1: Write the failing tests**

`src/ui/toast.test.ts`:

```ts
import { toast, useToasts } from "./toast";

beforeEach(() => useToasts.setState({ toasts: [] }));

it("adds a toast and auto-dismisses it after 4.2s", () => {
  vi.useFakeTimers();
  toast({ title: "Saved" });
  expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(["Saved"]);
  vi.advanceTimersByTime(4200);
  expect(useToasts.getState().toasts).toEqual([]);
  vi.useRealTimers();
});

it("dismisses a toast by id", () => {
  const id = toast({ title: "A" });
  toast({ title: "B" });
  useToasts.getState().dismiss(id);
  expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(["B"]);
});
```

`src/ui/dialog.test.tsx`:

```tsx
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ask, DialogHost } from "./dialog";

it("resolves true when confirmed", async () => {
  render(<DialogHost />);
  let p!: Promise<unknown>;
  act(() => { p = ask({ title: "Push 2 commits?", ok: "Push" }); });
  await userEvent.click(await screen.findByRole("button", { name: "Push" }));
  await expect(p).resolves.toBe(true);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("resolves null on Escape", async () => {
  render(<DialogHost />);
  let p!: Promise<unknown>;
  act(() => { p = ask({ title: "Discard?", danger: true }); });
  await screen.findByRole("dialog");
  await userEvent.keyboard("{Escape}");
  await expect(p).resolves.toBeNull();
});

it("returns the trimmed input value on Enter", async () => {
  render(<DialogHost />);
  let p!: Promise<unknown>;
  act(() => { p = ask({ title: "New file", input: "src/a.ts" }); });
  const box = await screen.findByRole("textbox");
  await userEvent.clear(box);
  await userEvent.type(box, "  src/b.ts {Enter}");
  await expect(p).resolves.toBe("src/b.ts");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test src/ui`
Expected: FAIL, because the modules cannot be resolved.

- [ ] **Step 3: Create `src/ui/toast.tsx`**

```tsx
import { create } from "zustand";

export interface ToastAction { label: string; run(): void; }
export interface Toast { id: number; title: string; detail?: string; icon?: string; action?: ToastAction; }

interface ToastStore {
  toasts: Toast[];
  push(t: Omit<Toast, "id">): number;
  dismiss(id: number): void;
}

let seq = 0;

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  push(t) {
    const id = ++seq;
    set({ toasts: [...get().toasts, { ...t, id }] });
    setTimeout(() => get().dismiss(id), 4200);
    return id;
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((x) => x.id !== id) });
  },
}));

export const toast = (t: Omit<Toast, "id">): number => useToasts.getState().push(t);

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className="toast" role="status">
          <div className="toast-ic" aria-hidden>{x.icon ?? "✓"}</div>
          <div className="toast-body">
            <div>{x.title}</div>
            {x.detail && <small>{x.detail}</small>}
          </div>
          {x.action && (
            <button className="btn sm" onClick={() => { x.action!.run(); dismiss(x.id); }}>{x.action.label}</button>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Create `src/ui/dialog.tsx`**

```tsx
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { t } from "../i18n/t";

export interface AskOptions {
  title: string;
  body?: string;
  ok?: string;
  danger?: boolean;
  icon?: string;
  input?: string; // when set, the dialog shows a text field prefilled with this value
  placeholder?: string;
  meta?: string; // monospace detail block, e.g. list of files
}

export type AskResult = string | true | null;

interface DialogStore {
  current: (AskOptions & { resolve(v: AskResult): void }) | null;
}

export const useDialog = create<DialogStore>(() => ({ current: null }));

/** App-styled replacement for confirm()/prompt(). Resolves true (confirm), the input string, or null (cancel). */
export function ask(o: AskOptions): Promise<AskResult> {
  useDialog.getState().current?.resolve(null);
  return new Promise((resolve) => useDialog.setState({ current: { ...o, resolve } }));
}

function finish(v: AskResult) {
  const c = useDialog.getState().current;
  if (!c) return;
  useDialog.setState({ current: null });
  c.resolve(v);
}

export function DialogHost() {
  const c = useDialog((s) => s.current);
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!c) return;
    if (c.input !== undefined) { inputRef.current?.focus(); inputRef.current?.select(); }
    else okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); finish(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [c]);

  if (!c) return null;
  const confirm = () => finish(c.input !== undefined ? inputRef.current?.value.trim() || null : true);

  return (
    <div className="dlg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) finish(null); }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <div className={"dlg-ic" + (c.danger ? " danger" : "")} aria-hidden>{c.icon ?? (c.danger ? "⚠" : "?")}</div>
        <h3 id="dlg-title">{c.title}</h3>
        {c.body && <p>{c.body}</p>}
        {c.meta && <pre className="dlg-meta">{c.meta}</pre>}
        {c.input !== undefined && (
          <input
            ref={inputRef}
            className="input"
            defaultValue={c.input}
            placeholder={c.placeholder}
            onKeyDown={(e) => { if (e.key === "Enter") confirm(); }}
          />
        )}
        <div className="dlg-actions">
          <button className="btn" onClick={() => finish(null)}>{t("dialog.cancel")}</button>
          <button ref={okRef} className={"btn " + (c.danger ? "danger" : "primary")} onClick={confirm}>{c.ok ?? t("dialog.ok")}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/ui`
Expected: PASS (5 tests).

- [ ] **Step 6: Create `src/ui/Button.tsx`**

```tsx
import type { ButtonHTMLAttributes } from "react";

type Variant = "default" | "primary" | "danger" | "ghost";

export function Button({
  variant = "default",
  size,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" }) {
  const cls = ["btn", variant !== "default" && variant, size, className].filter(Boolean).join(" ");
  return <button className={cls} {...rest} />;
}
```

- [ ] **Step 7: Create `src/ui/controls.tsx`**

```tsx
import type { ReactNode } from "react";

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange(v: T): void;
  label: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return <button role="switch" aria-checked={checked} aria-label={label} className={"switch" + (checked ? " on" : "")} onClick={() => onChange(!checked)} />;
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;
```

- [ ] **Step 8: Create `src/ui/Menu.tsx`**

```tsx
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | { kind: "item"; label: string; icon?: string; kbd?: string; danger?: boolean; onSelect(): void; extra?: ReactNode }
  | { kind: "separator" }
  | { kind: "header"; label: string }
  | { kind: "note"; label: string };

/** Fires to close any open Menu (used by nested controls that stop propagation). */
export const closeMenus = () => window.dispatchEvent(new Event("bw:menu-close"));

export function Menu({ x, y, items, onClose, width = 240 }: { x: number; y: number; items: MenuItem[]; onClose(): void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const timer = setTimeout(() => window.addEventListener("mousedown", down)); // skip the opening click
    window.addEventListener("keydown", key);
    window.addEventListener("bw:menu-close", onClose);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
      window.removeEventListener("bw:menu-close", onClose);
    };
  }, [onClose]);
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - 30 * items.length - 16));
  return createPortal(
    <div ref={ref} className="menu" role="menu" style={{ left, top, minWidth: width }}>
      {items.map((it, i) =>
        it.kind === "separator" ? <hr key={i} /> :
        it.kind === "header" ? <div key={i} className="menu-h">{it.label}</div> :
        it.kind === "note" ? <div key={i} className="menu-note">{it.label}</div> : (
          <button key={i} role="menuitem" className={"menu-item" + (it.danger ? " danger" : "")} onClick={() => { onClose(); it.onSelect(); }}>
            {it.icon && <span className="menu-ic" aria-hidden>{it.icon}</span>}
            <span className="menu-label">{it.label}</span>
            {it.extra}
            {it.kbd && <kbd className="kbd">{it.kbd}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
```

- [ ] **Step 9: Create `src/ui/ui.css`**

```css
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border: 0; border-radius: 999px; background: var(--s2); box-shadow: var(--spec), 0 0 0 .5px var(--line2); color: var(--fg); font-weight: 500; white-space: nowrap; cursor: pointer; transition: transform .2s var(--spring), background .15s; }
.btn:hover { background: var(--s3); }
.btn:active { transform: scale(.95); }
.btn.primary { background: var(--acc); color: var(--on-acc); box-shadow: inset 0 1px 0 oklch(1 0 0 / .3), 0 6px 18px -6px var(--acc); }
.btn.danger { background: var(--red); color: #fff; box-shadow: inset 0 1px 0 oklch(1 0 0 / .25), 0 6px 18px -6px var(--red); }
.btn.ghost { background: none; box-shadow: none; color: var(--fg2); }
.btn.ghost:hover { background: var(--s2); color: var(--fg); }
.btn.sm { padding: 2px 9px; font-size: 12px; }
.btn:disabled { opacity: .4; pointer-events: none; }
.icon-btn { width: 26px; height: 24px; display: inline-grid; place-items: center; border: 0; border-radius: 7px; background: none; color: var(--fg2); cursor: pointer; }
.icon-btn:hover { background: var(--s3); color: var(--fg); }
.kbd { font: 500 10.5px var(--font-mono); min-width: 18px; text-align: center; padding: 1px 5px; border-radius: 5px; background: var(--s3); color: var(--fg2); box-shadow: inset 0 -1px 0 oklch(0 0 0 / .35), inset 0 1px 0 oklch(1 0 0 / .1), 0 0 0 .5px var(--line2); }
.input { width: 100%; padding: 8px 10px; border: 0; border-radius: 10px; background: var(--s2); box-shadow: inset 0 0 0 1px var(--line2); color: var(--fg); font: inherit; outline: none; }
.input:focus { box-shadow: inset 0 0 0 1.5px var(--acc), 0 0 0 4px var(--accs); }
.seg { display: inline-flex; padding: 2px; border-radius: 999px; background: var(--s2); box-shadow: var(--spec); }
.seg button { padding: 4px 12px; border: 0; border-radius: 999px; background: none; color: var(--fg2); font-weight: 500; cursor: pointer; }
.seg button.on { background: var(--s4); color: var(--fg); box-shadow: var(--spec); }
.switch { position: relative; width: 38px; height: 22px; flex: none; border: 0; border-radius: 999px; background: var(--s4); cursor: pointer; transition: background .2s; }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 2px 4px oklch(0 0 0 / .3); transition: left .25s var(--spring); }
.switch.on { background: var(--grn); }
.switch.on::after { left: 18px; }
.card { border-radius: 14px; background: var(--s2); box-shadow: var(--spec), 0 0 0 .5px var(--line); overflow: hidden; }

.menu { position: fixed; z-index: 100; padding: 5px; border-radius: 14px; background: var(--glass2); backdrop-filter: blur(40px) saturate(1.8); -webkit-backdrop-filter: blur(40px) saturate(1.8); box-shadow: var(--shadow-pop), var(--spec), 0 0 0 .5px var(--line2); animation: pop .22s var(--spring); transform-origin: top left; }
@keyframes pop { from { opacity: 0; transform: scale(.94); } }
.menu-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 10px; border: 0; border-radius: 8px; background: none; text-align: left; cursor: pointer; }
.menu-item:hover { background: var(--acc); color: var(--on-acc); }
.menu-item:hover .kbd { background: oklch(1 0 0 / .2); color: #fff; }
.menu-item.danger { color: var(--red); }
.menu-item.danger:hover { background: var(--red); color: #fff; }
.menu-ic { width: 18px; text-align: center; }
.menu-label { flex: 1; }
.menu-h { padding: 6px 10px 2px; font-size: 11px; font-weight: 600; color: var(--fg3); text-transform: uppercase; letter-spacing: .03em; }
.menu-note { padding: 4px 10px 6px; font-size: 11.5px; color: var(--fg3); max-width: 300px; }
.menu hr { border: 0; border-top: 1px solid var(--line2); margin: 4px 6px; }

.toasts { position: fixed; right: 24px; bottom: 24px; z-index: 120; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.toast { display: flex; align-items: center; gap: 12px; min-width: 300px; padding: 10px 12px 10px 14px; border-radius: 14px; background: var(--glass2); backdrop-filter: blur(40px) saturate(1.8); -webkit-backdrop-filter: blur(40px) saturate(1.8); box-shadow: var(--shadow-pop), var(--spec), 0 0 0 .5px var(--line2); animation: toast-in .45s var(--spring); }
@keyframes toast-in { from { opacity: 0; transform: translateY(16px) scale(.92); } }
.toast-ic { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; background: var(--accs); color: var(--acc); }
.toast-body { flex: 1; }
.toast-body small { display: block; color: var(--fg3); }

.dlg-backdrop { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; background: oklch(0 0 0 / .35); backdrop-filter: blur(6px); animation: fade .2s; }
@keyframes fade { from { opacity: 0; } }
.dlg { width: min(420px, 92vw); padding: 24px; border-radius: 22px; background: var(--glass2); backdrop-filter: blur(60px) saturate(1.8); -webkit-backdrop-filter: blur(60px) saturate(1.8); box-shadow: 0 40px 100px -20px oklch(0 0 0 / .6), var(--spec), 0 0 0 .5px var(--line2); animation: dlg-in .4s var(--spring); }
@keyframes dlg-in { from { opacity: 0; transform: scale(.94) translateY(12px); } }
.dlg-ic { width: 42px; height: 42px; display: grid; place-items: center; margin-bottom: 14px; border-radius: 13px; background: var(--accs); color: var(--acc); font-size: 19px; box-shadow: var(--spec); }
.dlg-ic.danger { background: color-mix(in oklch, var(--red) 18%, transparent); color: var(--red); }
.dlg h3 { margin: 0 0 6px; font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
.dlg p { margin: 0; color: var(--fg2); line-height: 1.55; }
.dlg .input { margin-top: 14px; }
.dlg-meta { margin: 12px 0 0; padding: 8px 10px; border-radius: 10px; background: var(--s2); font: 11.5px var(--font-mono); color: var(--fg2); white-space: pre-wrap; }
.dlg-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
```

- [ ] **Step 10: Mount the hosts.** In `src/App.tsx`, add the imports and render them after the `.body` div:

```tsx
import { Toaster } from "./ui/toast";
import { DialogHost } from "./ui/dialog";
```

```tsx
      </div>
      <Toaster />
      <DialogHost />
    </div>
```

Add `import "./ui/ui.css";` to `src/main.tsx` after the tokens import.

- [ ] **Step 11: Run the gate and commit**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

```bash
git add src
git commit -m "feat(ui): button, segmented, switch, menu, toasts and ask() dialog"
```

## Task 8: Settings screen (Appearance + component preview)

**Files:**
- Create: `src/screens/settings/SettingsScreen.tsx`
- Create: `src/screens/settings/settings.css`
- Test: `src/screens/settings/SettingsScreen.test.tsx`
- Modify: `src/screens/views.tsx`, `src/main.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsView } from "./SettingsScreen";
import { useSettings } from "../../state/settings";
import { DEFAULT_THEME } from "../../theme/theme";

beforeEach(() => useSettings.setState({ theme: DEFAULT_THEME }));

it("changes theme mode and density from the Appearance card", async () => {
  render(<SettingsView />);
  await userEvent.click(screen.getByRole("radio", { name: "Light" }));
  await userEvent.click(screen.getByRole("radio", { name: "Compact" }));
  expect(useSettings.getState().theme.mode).toBe("light");
  expect(useSettings.getState().theme.density).toBe("compact");
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("toggles reduce transparency", async () => {
  render(<SettingsView />);
  await userEvent.click(screen.getByRole("switch", { name: "Reduce transparency" }));
  expect(useSettings.getState().theme.reduceTransparency).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/screens`
Expected: FAIL, because the module cannot be resolved.

- [ ] **Step 3: Create `src/screens/settings/SettingsScreen.tsx`**

```tsx
import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { useSettings } from "../../state/settings";
import { Segmented, Switch } from "../../ui/controls";
import { Button } from "../../ui/Button";
import { toast } from "../../ui/toast";
import { ask } from "../../ui/dialog";
import type { Density, ThemeMode } from "../../theme/theme";

const SWATCHES = [250, 300, 350, 25, 60, 155, 200];

export function SettingsToolbar() {
  return <h1 className="pane-title">{t("nav.settings")}</h1>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="opt">
      <div className="opt-label">{label}</div>
      <div className="opt-ctl">{children}</div>
    </div>
  );
}

export function SettingsView() {
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);

  const demoConfirm = async () => {
    const r = await ask({ title: t("demo.confirm.title"), body: t("demo.confirm.body"), ok: t("demo.confirm.ok"), icon: "↑" });
    toast({ title: r ? t("demo.result.confirmed") : t("demo.result.cancelled"), icon: r ? "✓" : "✕" });
  };
  const demoDanger = async () => {
    const r = await ask({
      title: t("demo.danger.title"), body: t("demo.danger.body"), ok: t("demo.danger.ok"), danger: true, icon: "↶",
      meta: "M  src/auth/callback.ts\nA  src/ui/LoginButton.tsx\nD  src/auth/legacy.ts",
    });
    toast({ title: r ? t("demo.result.confirmed") : t("demo.result.cancelled"), icon: r ? "✓" : "✕" });
  };
  const demoInput = async () => {
    const r = await ask({ title: t("demo.input.title"), body: t("demo.input.body"), ok: t("demo.input.ok"), icon: "＋", input: "src/new-file.ts" });
    toast(typeof r === "string" ? { title: t("demo.result.created", { name: r }) } : { title: t("demo.result.cancelled"), icon: "✕" });
  };

  return (
    <div className="settings">
      <h3>{t("settings.appearance")}</h3>
      <div className="card">
        <Row label={t("settings.theme")}>
          <Segmented<ThemeMode>
            label={t("settings.theme")}
            value={theme.mode}
            onChange={(mode) => setTheme({ mode })}
            options={[
              { value: "system", label: t("settings.theme.system") },
              { value: "light", label: t("settings.theme.light") },
              { value: "dark", label: t("settings.theme.dark") },
            ]}
          />
        </Row>
        <Row label={t("settings.accent")}>
          <div className="swatches">
            {SWATCHES.map((h) => (
              <button key={h} aria-label={`Accent hue ${h}`} className={"swatch" + (theme.accentHue === h ? " on" : "")} style={{ background: `oklch(.68 .19 ${h})` }} onClick={() => setTheme({ accentHue: h })} />
            ))}
          </div>
          <input type="range" min={0} max={360} value={theme.accentHue} aria-label={t("settings.accent")} onChange={(e) => setTheme({ accentHue: Number(e.target.value) })} />
        </Row>
        <Row label={t("settings.baseTint")}>
          <input type="range" min={0} max={360} value={theme.baseHue} aria-label={t("settings.baseTint")} onChange={(e) => setTheme({ baseHue: Number(e.target.value) })} />
        </Row>
        <Row label={t("settings.contrast")}>
          <input type="range" min={0.6} max={1.8} step={0.05} value={theme.contrast} aria-label={t("settings.contrast")} onChange={(e) => setTheme({ contrast: Number(e.target.value) })} />
        </Row>
        <Row label={t("settings.reduceTransparency")}>
          <Switch label={t("settings.reduceTransparency")} checked={theme.reduceTransparency} onChange={(reduceTransparency) => setTheme({ reduceTransparency })} />
        </Row>
        <Row label={t("settings.density")}>
          <Segmented<Density>
            label={t("settings.density")}
            value={theme.density}
            onChange={(density) => setTheme({ density })}
            options={[
              { value: "compact", label: t("settings.density.compact") },
              { value: "default", label: t("settings.density.default") },
              { value: "comfy", label: t("settings.density.comfy") },
            ]}
          />
        </Row>
      </div>

      <h3>{t("settings.demo")}</h3>
      <div className="card demo">
        <Button onClick={() => toast({ title: t("demo.toast.title"), detail: t("demo.toast.detail"), action: { label: t("toast.undo"), run: () => toast({ title: t("demo.undone"), icon: "↶" }) } })}>{t("settings.demo.toast")}</Button>
        <Button variant="primary" onClick={demoConfirm}>{t("settings.demo.confirm")}</Button>
        <Button variant="danger" onClick={demoDanger}>{t("settings.demo.danger")}</Button>
        <Button onClick={demoInput}>{t("settings.demo.input")}</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `src/screens/settings/settings.css`**

```css
.settings { max-width: 760px; padding: 20px 28px 40px; }
.settings h3 { margin: 22px 0 10px; font-size: 12px; font-weight: 600; color: var(--fg3); text-transform: uppercase; letter-spacing: .03em; }
.settings h3:first-child { margin-top: 0; }
.opt { display: flex; align-items: center; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.opt:last-child { border-bottom: 0; }
.opt-label { flex: 1; }
.opt-ctl { display: flex; align-items: center; gap: 12px; }
.opt-ctl input[type="range"] { width: 180px; accent-color: var(--acc); }
.swatches { display: flex; gap: 6px; }
.swatch { width: 22px; height: 22px; border: 0; border-radius: 50%; cursor: pointer; box-shadow: inset 0 0 0 2px oklch(1 0 0 / .25); }
.swatch.on { box-shadow: 0 0 0 2px var(--surf), 0 0 0 4px var(--fg); }
.demo { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px 16px; }
```

- [ ] **Step 5: Register the real Settings screen.** In `src/screens/views.tsx`, add the import and an override after the `VIEWS` definition:

```tsx
import { SettingsToolbar, SettingsView } from "./settings/SettingsScreen";
```

```tsx
VIEWS.settings = { Toolbar: SettingsToolbar, View: SettingsView };
```

Add `import "./screens/settings/settings.css";` to `src/main.tsx`.

- [ ] **Step 6: Run the gate and commit**

Run: `pnpm typecheck && pnpm test && (cd src-tauri && cargo test)`
Expected: PASS.

```bash
git add src
git commit -m "feat(settings): appearance controls and component preview"
```

## 🛑 MANUAL TEST CHECKPOINT 2

Stop here. Give the user these instructions:

**Run:** `pnpm tauri dev`

**Check:**
1. Open **Settings**. The Theme options Light, Dark, and System switch instantly. With System, changing macOS appearance (System Settings → Appearance) follows along.
2. Accent swatches and the accent slider recolor the highlighted sidebar item and the primary button. The Base tint slider shifts the surface tint. The Contrast slider makes secondary text and lines stronger or weaker.
3. **Reduce transparency** turns the glass sidebar solid. **Density** changes the height of sidebar rows.
4. **Quit and relaunch the app.** All appearance choices persist.
5. **Component preview:**
   - "Show toast" shows a toast at the bottom-right that disappears after about 4 s. Its **Undo** button shows an "Undone" toast.
   - "Confirm dialog" shows a glass dialog. **Push** gives "Confirmed", **Cancel** gives "Cancelled", and Esc or clicking the backdrop also cancels.
   - "Danger dialog" has a red button and a monospace file list.
   - "Input dialog" has a prefilled field. Enter confirms, and the toast shows the typed name.
6. No native browser `confirm`/`prompt` boxes appear anywhere.

Wait for the user's go-ahead before starting Stage 3.

---

# STAGE 3: Arc-style split view

## Task 9: Split-view reducer (open, close, swap, orientation, ratio, drop side, validation)

**Files:**
- Modify: `src/stage/stageModel.ts` (append)
- Modify: `src/stage/stageModel.test.ts` (append)

- [ ] **Step 1: Append the failing tests** to `src/stage/stageModel.test.ts`

```ts
import { closePane, isValidStage, nearestSide, openSplit, setRatio, swap, toggleDir } from "./stageModel";

const one: StageState = { panes: ["agents"], focus: 0, dir: "h", ratio: 0.5 };

describe("openSplit", () => {
  it("opens a right split and focuses it", () => {
    expect(openSplit(one, "changes", "right")).toEqual({ panes: ["agents", "changes"], focus: 1, dir: "h", ratio: 0.5 });
  });
  it("opens a left split", () => {
    expect(openSplit(one, "changes", "left").panes).toEqual(["changes", "agents"]);
  });
  it("uses vertical orientation for top/bottom", () => {
    const s = openSplit(one, "files", "bottom");
    expect(s.dir).toBe("v");
    expect(s.panes).toEqual(["agents", "files"]);
    expect(openSplit(one, "files", "top").panes).toEqual(["files", "agents"]);
  });
  it("does nothing when the only pane already shows the screen", () => {
    expect(openSplit(one, "agents", "right")).toBe(one);
  });
  it("replaces the target side when already split", () => {
    expect(openSplit(two, "graph", "right").panes).toEqual(["agents", "graph"]);
  });
  it("swaps instead of duplicating when the screen is on the other side", () => {
    expect(openSplit(two, "agents", "right").panes).toEqual(["changes", "agents"]);
  });
});

describe("closePane / swap / toggleDir / setRatio", () => {
  it("closes a pane and keeps the other", () => {
    expect(closePane(two, 0)).toEqual({ ...two, panes: ["changes"], focus: 0 });
    expect(closePane(one, 0)).toBe(one);
  });
  it("swaps panes and keeps focus on the same screen", () => {
    const s = swap({ ...two, focus: 0 });
    expect(s.panes).toEqual(["changes", "agents"]);
    expect(s.focus).toBe(1);
  });
  it("toggles orientation", () => {
    expect(toggleDir(two).dir).toBe("v");
  });
  it("clamps the ratio to 0.2–0.8", () => {
    expect(setRatio(two, 0.05).ratio).toBe(0.2);
    expect(setRatio(two, 0.95).ratio).toBe(0.8);
  });
});

describe("nearestSide", () => {
  it("picks the closest edge", () => {
    expect(nearestSide(0.1, 0.5)).toBe("left");
    expect(nearestSide(0.9, 0.5)).toBe("right");
    expect(nearestSide(0.5, 0.05)).toBe("top");
    expect(nearestSide(0.5, 0.97)).toBe("bottom");
  });
});

describe("isValidStage", () => {
  it("accepts well-formed state", () => {
    expect(isValidStage(two)).toBe(true);
  });
  it("rejects unknown screens, duplicates, and bad focus", () => {
    expect(isValidStage({ ...two, panes: ["nope"] })).toBe(false);
    expect(isValidStage({ ...two, panes: ["agents", "agents"] })).toBe(false);
    expect(isValidStage({ ...two, focus: 3 })).toBe(false);
    expect(isValidStage(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test src/stage`
Expected: FAIL, because the named exports are missing.

- [ ] **Step 3: Append the implementation** to `src/stage/stageModel.ts`

```ts
import { SCREEN_IDS } from "../screens/registry";

export function openSplit(s: StageState, id: ScreenId, side: Side): StageState {
  const dir: Dir = side === "top" || side === "bottom" ? "v" : "h";
  const first = side === "left" || side === "top";
  if (s.panes.length === 1) {
    if (s.panes[0] === id) return s;
    const panes = first ? [id, s.panes[0]] : [s.panes[0], id];
    return { ...s, panes, dir, focus: panes.indexOf(id) };
  }
  const k = first ? 0 : 1;
  let panes = [...s.panes];
  if (panes[1 - k] === id) panes = [panes[1], panes[0]];
  else panes[k] = id;
  return { ...s, panes, dir, focus: panes.indexOf(id) };
}

export function closePane(s: StageState, i: number): StageState {
  if (s.panes.length < 2) return s;
  return { ...s, panes: s.panes.filter((_, k) => k !== i), focus: 0 };
}

export function swap(s: StageState): StageState {
  if (s.panes.length < 2) return s;
  return { ...s, panes: [s.panes[1], s.panes[0]], focus: 1 - s.focus };
}

export function toggleDir(s: StageState): StageState {
  return { ...s, dir: s.dir === "h" ? "v" : "h" };
}

export function setRatio(s: StageState, r: number): StageState {
  return { ...s, ratio: Math.min(0.8, Math.max(0.2, r)) };
}

/** x, y are pointer coordinates normalized to 0..1 within the stage. */
export function nearestSide(x: number, y: number): Side {
  const d: Record<Side, number> = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  return (Object.keys(d) as Side[]).reduce((a, b) => (d[a] <= d[b] ? a : b));
}

export function isValidStage(v: unknown): v is StageState {
  if (!v || typeof v !== "object") return false;
  const s = v as StageState;
  return (
    Array.isArray(s.panes) && s.panes.length >= 1 && s.panes.length <= 2 &&
    s.panes.every((p) => SCREEN_IDS.includes(p)) && new Set(s.panes).size === s.panes.length &&
    Number.isInteger(s.focus) && s.focus >= 0 && s.focus < s.panes.length &&
    (s.dir === "h" || s.dir === "v") && typeof s.ratio === "number"
  );
}
```

Move the new `import { SCREEN_IDS } ...` line to the top of the file, next to the existing `ScreenId` type import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/stage`
Expected: PASS (all stageModel tests).

- [ ] **Step 5: Commit**

```bash
git add src/stage
git commit -m "feat(stage): split-view reducer with open/close/swap/orientation/drop side"
```

## Task 10: Persisted stage store with split actions

**Files:**
- Replace: `src/state/stage.ts`
- Test: `src/state/stage.test.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write the failing test** `src/state/stage.test.ts`

```ts
import { useStage } from "./stage";
import { initialStage } from "../stage/stageModel";
import { useToasts } from "../ui/toast";

beforeEach(() => {
  localStorage.clear();
  useStage.setState({ ...initialStage });
  useToasts.setState({ toasts: [] });
});

it("opens and toggles a split", () => {
  useStage.getState().go("agents");
  useStage.getState().openSplit("changes", "right");
  expect(useStage.getState().panes).toEqual(["agents", "changes"]);
  useStage.getState().toggleSplit("right");
  expect(useStage.getState().panes).toEqual(["agents"]);
});

it("toasts instead of duplicating the only open screen", () => {
  useStage.getState().openSplit("launchpad", "right");
  expect(useStage.getState().panes).toEqual(["launchpad"]);
  expect(useToasts.getState().toasts[0].title).toBe("Launchpad is already open");
});

it("persists and restores the layout", async () => {
  vi.useFakeTimers();
  useStage.getState().openSplit("graph", "bottom");
  vi.advanceTimersByTime(400);
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0));
  useStage.setState({ ...initialStage });
  await useStage.getState().load();
  expect(useStage.getState().panes).toEqual(["launchpad", "graph"]);
  expect(useStage.getState().dir).toBe("v");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/state/stage`
Expected: FAIL, because `openSplit` is not a function.

- [ ] **Step 3: Replace `src/state/stage.ts`**

```ts
import { create } from "zustand";
import * as M from "../stage/stageModel";
import { screenById, type ScreenId } from "../screens/registry";
import { loadSetting, saveSetting } from "../ipc/settings";
import { toast } from "../ui/toast";
import { t } from "../i18n/t";

interface StageStore extends M.StageState {
  go(id: ScreenId): void;
  focusPane(i: number): void;
  openSplit(id: ScreenId, side: M.Side): void;
  closePane(i: number): void;
  /** ⌘\ behavior: close the unfocused pane if split, otherwise open a split on `side`. */
  toggleSplit(side: M.Side): void;
  swap(): void;
  toggleDir(): void;
  setRatio(r: number): void;
  load(): Promise<void>;
}

const pick = (s: M.StageState): M.StageState => ({ panes: s.panes, focus: s.focus, dir: s.dir, ratio: s.ratio });

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const persist = (s: M.StageState) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSetting("stage", s), 300);
};

export const useStage = create<StageStore>((set, get) => {
  const apply = (f: (s: M.StageState) => M.StageState) => {
    const next = f(pick(get()));
    set(next);
    persist(next);
  };
  return {
    ...M.initialStage,
    go: (id) => apply((s) => M.navigate(s, id)),
    focusPane: (i) => {
      if (get().focus !== i) apply((s) => M.setFocus(s, i));
    },
    openSplit: (id, side) => {
      const s = get();
      if (s.panes.length === 1 && s.panes[0] === id) {
        toast({ title: t("split.alreadyOpen", { screen: t(screenById(id).label) }), icon: "⊞" });
        return;
      }
      apply((st) => M.openSplit(st, id, side));
    },
    closePane: (i) => apply((s) => M.closePane(s, i)),
    toggleSplit: (side) => {
      const s = get();
      if (s.panes.length > 1) apply((st) => M.closePane(st, 1 - st.focus));
      else get().openSplit(s.panes[0] === "changes" ? "agents" : "changes", side);
    },
    swap: () => apply(M.swap),
    toggleDir: () => apply(M.toggleDir),
    setRatio: (r) => apply((s) => M.setRatio(s, r)),
    async load() {
      const saved = await loadSetting<unknown>("stage");
      if (M.isValidStage(saved)) set(pick(saved));
    },
  };
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/state`
Expected: PASS.

- [ ] **Step 5: Restore the layout on startup.** In `src/App.tsx`, add the import and the load call:

```tsx
import { useStage } from "./state/stage";
```

Inside the existing `useEffect`, after the settings load:

```tsx
    void useStage.getState().load();
```

- [ ] **Step 6: Run the gate and commit**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

```bash
git add src
git commit -m "feat(stage): persisted split-view store with toggle/swap/orientation"
```

## Task 11: Split rendering: two panes, resizable divider, pane controls, ⊞ split menu

**Files:**
- Create: `src/stage/dnd.ts`
- Create: `src/stage/splitMenu.tsx`
- Create: `src/stage/PaneControls.tsx`
- Replace: `src/stage/Pane.tsx`, `src/stage/Stage.tsx`
- Modify: `src/stage/stage.css` (append)
- Test: `src/stage/Stage.test.tsx`

- [ ] **Step 1: Write the failing test** `src/stage/Stage.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Stage } from "./Stage";
import { useStage } from "../state/stage";
import { initialStage } from "./stageModel";

beforeEach(() => useStage.setState({ ...initialStage }));

it("opens a split from the ⊞ menu and closes it from the pane", async () => {
  render(<Stage />);
  await userEvent.click(screen.getByRole("button", { name: /Split with/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Changes/ }));
  expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Launchpad", "Changes"]);
  expect(screen.getByRole("separator")).toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: "Close pane" })[1]);
  expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Launchpad"]);
});

it("opens a bottom split from the direction icon", async () => {
  render(<Stage />);
  await userEvent.click(screen.getByRole("button", { name: /Split with/ }));
  const item = screen.getByRole("menuitem", { name: /Graph/ });
  await userEvent.click(item.querySelector('[title="Split bottom"]')!);
  expect(useStage.getState().panes).toEqual(["launchpad", "graph"]);
  expect(useStage.getState().dir).toBe("v");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/stage/Stage`
Expected: FAIL, because there is no "Split with" button yet.

- [ ] **Step 3: Create `src/stage/dnd.ts`**

```ts
import type { MsgKey } from "../i18n/en";
import type { Side } from "./stageModel";

/** Custom drag type for sidebar screen items (must be lowercase; browsers lowercase drag types). */
export const SCREEN_MIME = "application/x-branchwork-screen";

export const SIDES: { side: Side; icon: string; label: MsgKey }[] = [
  { side: "left", icon: "◧", label: "split.left" },
  { side: "right", icon: "◨", label: "split.right" },
  { side: "top", icon: "⬒", label: "split.top" },
  { side: "bottom", icon: "⬓", label: "split.bottom" },
];

export const sideLabel = (side: Side): MsgKey => SIDES.find((s) => s.side === side)!.label;
```

- [ ] **Step 4: Create `src/stage/splitMenu.tsx`**

```tsx
import { SCREENS, type ScreenId } from "../screens/registry";
import { closeMenus, type MenuItem } from "../ui/Menu";
import { t } from "../i18n/t";
import { SIDES } from "./dnd";
import type { Side } from "./stageModel";

export function splitMenuItems(panes: ScreenId[], open: (id: ScreenId, side: Side) => void): MenuItem[] {
  return [
    { kind: "header", label: t("split.menuTitle") },
    ...SCREENS.filter((s) => !panes.includes(s.id)).map((s): MenuItem => ({
      kind: "item",
      icon: s.icon,
      label: t(s.label),
      onSelect: () => open(s.id, "right"),
      extra: (
        <span className="dirs">
          {SIDES.map((d) => (
            <span
              key={d.side}
              className="dir"
              title={t(d.label)}
              onClick={(e) => { e.stopPropagation(); closeMenus(); open(s.id, d.side); }}
            >
              {d.icon}
            </span>
          ))}
        </span>
      ),
    })),
    { kind: "separator" },
    { kind: "note", label: t("split.menuNote") },
  ];
}
```

- [ ] **Step 5: Create `src/stage/PaneControls.tsx`**

```tsx
import { useState } from "react";
import { useStage } from "../state/stage";
import { Menu } from "../ui/Menu";
import { t } from "../i18n/t";
import { splitMenuItems } from "./splitMenu";

export function PaneControls({ index }: { index: number }) {
  const panes = useStage((s) => s.panes);
  const dir = useStage((s) => s.dir);
  const { swap, toggleDir, closePane, openSplit } = useStage.getState();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  if (panes.length < 2) {
    return (
      <div className="pane-ctl">
        <button
          className="icon-btn"
          aria-label={t("split.menuTitle")}
          title={`${t("split.menuTitle")} (⌘\\)`}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 320, y: r.bottom + 6 }); }}
        >
          ⊞
        </button>
        {menu && <Menu x={menu.x} y={menu.y} width={310} onClose={() => setMenu(null)} items={splitMenuItems(panes, openSplit)} />}
      </div>
    );
  }
  return (
    <div className="pane-ctl">
      {index === 0 && (
        <>
          <button className="icon-btn" aria-label={t("split.swap")} title={t("split.swap")} onClick={swap}>⇄</button>
          <button className="icon-btn" aria-label={t("split.orientation")} title={t("split.orientation")} onClick={toggleDir}>{dir === "h" ? "⬒" : "◫"}</button>
        </>
      )}
      <button className="icon-btn" aria-label={t("split.close")} title={t("split.close")} onClick={() => closePane(index)}>✕</button>
    </div>
  );
}
```

- [ ] **Step 6: Replace `src/stage/Pane.tsx`** to add the controls

```tsx
import { useStage } from "../state/stage";
import { VIEWS } from "../screens/views";
import { PaneControls } from "./PaneControls";

export function Pane({ index }: { index: number }) {
  const id = useStage((s) => s.panes[index]);
  const focused = useStage((s) => s.panes.length > 1 && s.focus === index);
  const focusPane = useStage((s) => s.focusPane);
  const { Toolbar, View } = VIEWS[id];
  return (
    <section className={"pane" + (focused ? " focus" : "")} data-pane={index} onMouseDown={() => focusPane(index)}>
      <header className="pane-tool">
        <Toolbar />
        <PaneControls index={index} />
      </header>
      <div className="pane-view" key={id}>
        <View />
      </div>
    </section>
  );
}
```

- [ ] **Step 7: Replace `src/stage/Stage.tsx`** with panes, divider, and drop zones

```tsx
import { useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from "react";
import { useStage } from "../state/stage";
import { Pane } from "./Pane";
import { nearestSide, type Side } from "./stageModel";
import { SCREEN_MIME, sideLabel } from "./dnd";
import type { ScreenId } from "../screens/registry";
import { t } from "../i18n/t";

export function Stage() {
  const panes = useStage((s) => s.panes);
  const dir = useStage((s) => s.dir);
  const ratio = useStage((s) => s.ratio);
  const ref = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<Side | null>(null);
  const two = panes.length > 1;

  const onDividerDown = (e: MouseEvent) => {
    e.preventDefault();
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    el.classList.add("resizing");
    const move = (ev: globalThis.MouseEvent) =>
      useStage.getState().setRatio(dir === "h" ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height);
    const up = () => {
      el.classList.remove("resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const sideAt = (e: DragEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return nearestSide((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };

  return (
    <div
      ref={ref}
      className={"stage" + (two ? " split-" + dir : "")}
      style={{ "--r": ratio } as CSSProperties}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(SCREEN_MIME)) return;
        e.preventDefault();
        setDrop(sideAt(e));
      }}
      onDragLeave={(e) => { if (!ref.current!.contains(e.relatedTarget as Node)) setDrop(null); }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(SCREEN_MIME) as ScreenId;
        setDrop(null);
        if (!id) return;
        e.preventDefault();
        useStage.getState().openSplit(id, sideAt(e));
      }}
    >
      <Pane index={0} />
      {two && (
        <div
          className="divider"
          role="separator"
          aria-orientation={dir === "h" ? "vertical" : "horizontal"}
          title={t("split.resizeHint")}
          onMouseDown={onDividerDown}
          onDoubleClick={() => useStage.getState().setRatio(0.5)}
        />
      )}
      {two && <Pane index={1} />}
      {drop && (
        <div className="dropzone" data-side={drop}>
          <div className="dz-hl">{t(sideLabel(drop))}</div>
          <span className="dz-hint">{t("split.dropHint")}</span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Append the split styles** to `src/stage/stage.css`

```css
.stage.split-h { grid-template-columns: minmax(0, calc((100% - 8px) * var(--r))) 8px minmax(0, 1fr); }
.stage.split-v { grid-template-rows: minmax(0, calc((100% - 8px) * var(--r))) 8px minmax(0, 1fr); }
.pane.focus { box-shadow: var(--spec), 0 0 0 1.5px color-mix(in oklch, var(--acc) 70%, transparent), 0 10px 40px -20px var(--acc); }
.pane-ctl { display: flex; gap: 2px; margin-left: auto; padding-left: 8px; }
.divider { position: relative; cursor: col-resize; }
.split-v .divider { cursor: row-resize; }
.divider::after { content: ""; position: absolute; inset: 0; margin: auto; width: 3px; height: 44px; border-radius: 2px; background: var(--line2); transition: all .2s var(--spring); }
.split-v .divider::after { width: 44px; height: 3px; }
.divider:hover::after, .resizing .divider::after { background: var(--acc); height: 90px; }
.split-v .divider:hover::after, .split-v.resizing .divider::after { width: 90px; height: 3px; }
.stage.resizing { user-select: none; }
.dropzone { position: absolute; inset: 0; z-index: 30; pointer-events: none; border-radius: 16px; background: oklch(0 0 0 / .18); backdrop-filter: blur(3px); animation: fade .15s; }
.dz-hl { position: absolute; inset: 6px 50% 6px 6px; display: grid; place-items: center; border: 2px dashed var(--acc); border-radius: 14px; background: var(--accs); color: var(--acc); font-size: 15px; font-weight: 650; transition: inset .25s var(--spring); }
.dropzone[data-side="right"] .dz-hl { inset: 6px 6px 6px 50%; }
.dropzone[data-side="top"] .dz-hl { inset: 6px 6px 50% 6px; }
.dropzone[data-side="bottom"] .dz-hl { inset: 50% 6px 6px 6px; }
.dz-hint { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); padding: 3px 10px; border-radius: 999px; background: var(--glass2); color: var(--fg2); font-size: 11.5px; }
.dirs { display: flex; gap: 2px; margin-left: 8px; }
.dir { width: 22px; height: 20px; display: grid; place-items: center; border-radius: 5px; opacity: .65; }
.dir:hover { opacity: 1; background: oklch(1 0 0 / .25); }
@container (max-width: 560px) { .pane-title { overflow: hidden; text-overflow: ellipsis; } }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm test src/stage`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/stage
git commit -m "feat(stage): two-pane split rendering, resizable divider, pane controls and split menu"
```

## Task 12: Split-aware sidebar (drag to split, ⌘/⌥-click, context menu, position glyphs)

**Files:**
- Replace: `src/shell/Sidebar.tsx`
- Test: `src/shell/Sidebar.test.tsx`

- [ ] **Step 1: Write the failing test** `src/shell/Sidebar.test.tsx`

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import { useStage } from "../state/stage";
import { initialStage } from "../stage/stageModel";

beforeEach(() => useStage.setState({ ...initialStage }));

it("⌘-click opens a right split, ⌥-click a bottom split", async () => {
  render(<Sidebar />);
  fireEvent.click(screen.getByRole("button", { name: /Changes/ }), { metaKey: true });
  expect(useStage.getState().panes).toEqual(["launchpad", "changes"]);
  useStage.setState({ ...initialStage });
  fireEvent.click(screen.getByRole("button", { name: /Graph/ }), { altKey: true });
  expect(useStage.getState()).toMatchObject({ panes: ["launchpad", "graph"], dir: "v" });
});

it("context menu offers split directions", async () => {
  render(<Sidebar />);
  fireEvent.contextMenu(screen.getByRole("button", { name: /Agents/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Split left/ }));
  expect(useStage.getState().panes).toEqual(["agents", "launchpad"]);
});

it("shows position glyphs for both split screens", () => {
  useStage.setState({ ...initialStage, panes: ["agents", "changes"] });
  render(<Sidebar />);
  expect(screen.getByRole("button", { name: /Agents/ })).toHaveTextContent("◧");
  expect(screen.getByRole("button", { name: /Changes/ })).toHaveTextContent("◨");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/shell`
Expected: FAIL (no split on ⌘-click, no menu).

- [ ] **Step 3: Replace `src/shell/Sidebar.tsx`**

```tsx
import { useState, type MouseEvent } from "react";
import { SCREENS, screenById, type ScreenDef, type ScreenId } from "../screens/registry";
import { useStage } from "../state/stage";
import { Menu, type MenuItem } from "../ui/Menu";
import { SCREEN_MIME } from "../stage/dnd";
import { t } from "../i18n/t";

export function Sidebar() {
  const panes = useStage((s) => s.panes);
  const focus = useStage((s) => s.focus);
  const dir = useStage((s) => s.dir);
  const [ctx, setCtx] = useState<{ x: number; y: number; id: ScreenId } | null>(null);
  const { go, openSplit, closePane } = useStage.getState();

  const glyph = (id: ScreenId) => {
    const i = panes.indexOf(id);
    if (panes.length < 2 || i < 0) return null;
    const g = i === 0 ? (dir === "h" ? "◧" : "⬒") : dir === "h" ? "◨" : "⬓";
    return <span className="nav-split" aria-hidden>{g}</span>;
  };

  const onClick = (e: MouseEvent, id: ScreenId) => {
    if (e.altKey) openSplit(id, "bottom");
    else if (e.metaKey || e.ctrlKey || e.shiftKey) openSplit(id, "right");
    else go(id);
  };

  const menuItems = (id: ScreenId): MenuItem[] => [
    { kind: "item", label: t("split.openHere"), onSelect: () => go(id) },
    { kind: "item", icon: "◨", label: t("split.right"), kbd: "⌘-click", onSelect: () => openSplit(id, "right") },
    { kind: "item", icon: "◧", label: t("split.left"), onSelect: () => openSplit(id, "left") },
    { kind: "item", icon: "⬒", label: t("split.top"), onSelect: () => openSplit(id, "top") },
    { kind: "item", icon: "⬓", label: t("split.bottom"), kbd: "⌥-click", onSelect: () => openSplit(id, "bottom") },
    ...(panes.length > 1 && panes.includes(id)
      ? ([{ kind: "separator" }, { kind: "item", icon: "✕", label: t("split.closeFromSplit"), onSelect: () => closePane(panes.indexOf(id)) }] as MenuItem[])
      : []),
  ];

  const item = (s: ScreenDef) => (
    <button
      key={s.id}
      className={"nav" + (panes[focus] === s.id ? " on" : panes.includes(s.id) ? " on2" : "")}
      draggable
      title={t("sidebar.splitHint")}
      onDragStart={(e) => { e.dataTransfer.setData(SCREEN_MIME, s.id); e.dataTransfer.effectAllowed = "copy"; }}
      onClick={(e) => onClick(e, s.id)}
      onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, id: s.id }); }}
    >
      <span className="nav-ic" aria-hidden>{s.icon}</span>
      <span className="nav-label">{t(s.label)}</span>
      {glyph(s.id)}
    </button>
  );

  return (
    <aside className="sidebar">
      <nav className="side-scroll">
        {SCREENS.filter((s) => s.section === "nav").map(item)}
        <div className="side-h">{t("sidebar.worktrees")}</div>
        <div className="side-empty">{t("sidebar.noRepo")}</div>
        <div className="side-h">{t("sidebar.tools")}</div>
        {SCREENS.filter((s) => s.section === "tools").map(item)}
      </nav>
      <div className="side-foot">{item(screenById("settings"))}</div>
      {ctx && <Menu x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} items={menuItems(ctx.id)} />}
    </aside>
  );
}
```

- [ ] **Step 4: Run the full gate**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (all tests, including `App.test.tsx`).

- [ ] **Step 5: Commit**

```bash
git add src/shell
git commit -m "feat(sidebar): drag-to-split, modifier clicks, split context menu, position glyphs"
```

## 🛑 MANUAL TEST CHECKPOINT 3

Stop here. Give the user these instructions:

**Run:** `pnpm tauri dev`

**Check:**
1. Open **Agents**. **Drag "Changes"** from the sidebar onto the content. A blurred overlay previews the half nearest the pointer (left, right, top, or bottom). Releasing it opens a split on that side.
2. **⌘-click** a sidebar item opens it on the right. **⌥-click** opens it at the bottom.
3. **Right-click** a sidebar item: Open here, Split right, Split left, Split top, Split bottom, and, if it's in the split, Remove from split.
4. The **⊞** button in the pane toolbar (single-pane mode) lists the screens. Clicking a row splits it on the right; the ◧◨⬒⬓ icons pick the side.
5. With two panes:
   - Clicking inside a pane focuses it (accent outline), and sidebar clicks then change that pane.
   - Both screens are highlighted in the sidebar, with ◧/◨ or ⬒/⬓ glyphs.
   - **⇄** swaps the panes, **⬒/◫** flips the orientation, and **✕** closes a pane.
   - Clicking a screen that is already in the other pane just focuses it; there are no duplicates.
6. **Drag the divider** to resize (it stops at 20% and 80%). Double-click it to reset to 50%.
7. Quit and relaunch. The split layout and ratio are restored.

Wait for the user's go-ahead before starting Stage 4.

---

# STAGE 4: Command palette and global keyboard map

## Task 13: Fuzzy ranking

**Files:**
- Create: `src/palette/fuzzy.ts`
- Test: `src/palette/fuzzy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { fuzzyScore, rank } from "./fuzzy";

describe("fuzzyScore", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyScore("gch", "Go to Changes")).not.toBeNull();
    expect(fuzzyScore("xyz", "Go to Changes")).toBeNull();
  });
  it("scores contiguous and word-start matches higher", () => {
    expect(fuzzyScore("chan", "Go to Changes")!).toBeGreaterThan(fuzzyScore("chan", "Check a new screen")!);
  });
  it("returns 0 for an empty query", () => {
    expect(fuzzyScore("  ", "anything")).toBe(0);
  });
});

describe("rank", () => {
  it("filters and orders by score, keeping input order for empty queries", () => {
    const items = ["Go to Graph", "Go to Changes", "Split right with Changes"];
    expect(rank(items, "", (x) => x)).toEqual(items);
    expect(rank(items, "changes", (x) => x)).toEqual(["Go to Changes", "Split right with Changes"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/palette`
Expected: FAIL, because the module cannot be resolved.

- [ ] **Step 3: Create `src/palette/fuzzy.ts`**

```ts
/** Subsequence match score: +1 per matched char, +3 if contiguous, +2 at word start. null = no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  const s = text.toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) continue;
    score += i === prev + 1 ? 3 : 1;
    if (i === 0 || s[i - 1] === " ") score += 2;
    prev = i;
    qi++;
  }
  return qi === q.length ? score : null;
}

export function rank<T>(items: T[], query: string, text: (x: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((x, i) => ({ x, i, s: fuzzyScore(query, text(x)) }))
    .filter((r): r is { x: T; i: number; s: number } => r.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.x);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/palette`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/palette
git commit -m "feat(palette): fuzzy scoring and ranking"
```

## Task 14: Command list, palette store, and Palette UI

**Files:**
- Create: `src/palette/store.ts`
- Create: `src/palette/commands.ts`
- Create: `src/palette/Palette.tsx`
- Create: `src/palette/palette.css`
- Test: `src/palette/Palette.test.tsx`
- Modify: `src/App.tsx`, `src/main.tsx`

- [ ] **Step 1: Write the failing test** `src/palette/Palette.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Palette } from "./Palette";
import { usePalette } from "./store";
import { useStage } from "../state/stage";
import { initialStage } from "../stage/stageModel";
import { useToasts } from "../ui/toast";

beforeEach(() => {
  useStage.setState({ ...initialStage });
  usePalette.setState({ open: true, query: "" });
  useToasts.setState({ toasts: [] });
});

it("filters commands and runs the selected one with Enter", async () => {
  render(<Palette />);
  await userEvent.type(screen.getByRole("combobox"), "go changes");
  expect(screen.getAllByRole("option")[0]).toHaveTextContent("Go to Changes");
  await userEvent.keyboard("{Enter}");
  expect(useStage.getState().panes).toEqual(["changes"]);
  expect(usePalette.getState().open).toBe(false);
});

it("moves the selection with arrow keys", async () => {
  render(<Palette />);
  await userEvent.type(screen.getByRole("combobox"), "split bottom graph");
  await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  expect(useStage.getState()).toMatchObject({ panes: ["launchpad", "graph"], dir: "v" });
});

it("turns a trailing ? into an Ask Claude command", async () => {
  render(<Palette />);
  await userEvent.type(screen.getByRole("combobox"), "what changed?");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option")).toHaveTextContent("Ask Claude: what changed?");
});

it("closes on Escape", async () => {
  render(<Palette />);
  await userEvent.keyboard("{Escape}");
  expect(usePalette.getState().open).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/palette/Palette`
Expected: FAIL, because the modules cannot be resolved.

- [ ] **Step 3: Create `src/palette/store.ts`**

```ts
import { create } from "zustand";

interface PaletteStore {
  open: boolean;
  query: string;
  show(query?: string): void;
  hide(): void;
  toggle(): void;
  setQuery(q: string): void;
}

export const usePalette = create<PaletteStore>((set, get) => ({
  open: false,
  query: "",
  show: (query = "") => set({ open: true, query }),
  hide: () => set({ open: false, query: "" }),
  toggle: () => (get().open ? get().hide() : get().show()),
  setQuery: (query) => set({ query }),
}));
```

- [ ] **Step 4: Create `src/palette/commands.ts`**

```ts
import type { MsgKey } from "../i18n/en";
import { t } from "../i18n/t";
import { NUMBER_KEYS, SCREENS } from "../screens/registry";
import { useStage } from "../state/stage";
import { useSettings } from "../state/settings";
import { prefersDark, resolveMode } from "../theme/theme";
import { toast } from "../ui/toast";

export interface Command {
  id: string;
  group: MsgKey;
  icon: string;
  title: string;
  kbd?: string;
  run(): void;
}

const stage = () => useStage.getState();

export function buildCommands(): Command[] {
  const nav: Command[] = SCREENS.map((s) => {
    const n = NUMBER_KEYS.indexOf(s.id);
    return {
      id: "go:" + s.id,
      group: "palette.group.navigate",
      icon: s.icon,
      title: t("palette.goTo", { screen: t(s.label) }),
      kbd: n >= 0 ? String(n + 1) : undefined,
      run: () => stage().go(s.id),
    };
  });
  const split: Command[] = [
    ...SCREENS.map((s): Command => ({ id: "split-r:" + s.id, group: "palette.group.split", icon: "◨", title: t("palette.splitRight", { screen: t(s.label) }), run: () => stage().openSplit(s.id, "right") })),
    ...SCREENS.map((s): Command => ({ id: "split-b:" + s.id, group: "palette.group.split", icon: "⬓", title: t("palette.splitBottom", { screen: t(s.label) }), run: () => stage().openSplit(s.id, "bottom") })),
    { id: "split:close", group: "palette.group.split", icon: "✕", title: t("palette.closeSplit"), kbd: "⌘\\", run: () => { const s = stage(); if (s.panes.length > 1) s.closePane(1 - s.focus); } },
    { id: "split:swap", group: "palette.group.split", icon: "⇄", title: t("palette.swapSplit"), run: () => stage().swap() },
  ];
  const appearance: Command[] = [
    {
      id: "theme:toggle",
      group: "palette.group.appearance",
      icon: "◐",
      title: t("palette.toggleTheme"),
      run: () => {
        const { theme, setTheme } = useSettings.getState();
        setTheme({ mode: resolveMode(theme.mode, prefersDark()) === "dark" ? "light" : "dark" });
      },
    },
  ];
  return [...nav, ...split, ...appearance];
}

export function askClaudeCommand(q: string): Command {
  return { id: "ask", group: "palette.group.ai", icon: "✦", title: t("palette.askClaude", { q }), run: () => toast({ title: t("palette.aiLater"), icon: "✦" }) };
}
```

- [ ] **Step 5: Create `src/palette/Palette.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { usePalette } from "./store";
import { askClaudeCommand, buildCommands, type Command } from "./commands";
import { rank } from "./fuzzy";
import { t } from "../i18n/t";

export function Palette() {
  const open = usePalette((s) => s.open);
  const query = usePalette((s) => s.query);
  const { setQuery, hide } = usePalette.getState();
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    if (!open) return [];
    const q = query.trim();
    if (q.endsWith("?")) return [askClaudeCommand(q)];
    return rank(buildCommands(), q, (c) => c.title + " " + t(c.group));
  }, [open, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { document.querySelector(".pal-item.on")?.scrollIntoView?.({ block: "nearest" }); }, [index]);

  if (!open) return null;

  const run = (c?: Command) => { if (!c) return; hide(); c.run(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); run(results[index]); }
    else if (e.key === "Escape") { e.preventDefault(); hide(); }
  };

  return (
    <>
      <div className="pal-scrim" onMouseDown={hide} />
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="pal-list"
          aria-label={t("palette.placeholder")}
          placeholder={t("palette.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="pal-list" id="pal-list" role="listbox">
          {results.length === 0 && <div className="pal-empty">{t("palette.empty")}</div>}
          {results.map((c, i) => (
            <div
              key={c.id}
              role="option"
              aria-selected={i === index}
              className={"pal-item" + (i === index ? " on" : "")}
              onMouseMove={() => setIndex(i)}
              onMouseDown={(e) => { e.preventDefault(); run(c); }}
            >
              <span className="pal-ic" aria-hidden>{c.icon}</span>
              <span className="pal-title">{c.title}</span>
              <span className="pal-grp">{t(c.group)}</span>
              {c.kbd && <kbd className="kbd">{c.kbd}</kbd>}
            </div>
          ))}
        </div>
        <div className="pal-foot">
          <span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> {t("palette.nav")}</span>
          <span><kbd className="kbd">↵</kbd> {t("palette.run")}</span>
          <span><kbd className="kbd">esc</kbd> {t("palette.close")}</span>
          <span className="pal-ask">{t("palette.askHint")}</span>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 6: Create `src/palette/palette.css`**

```css
.pal-scrim { position: fixed; inset: 0; z-index: 90; background: oklch(0 0 0 / .25); backdrop-filter: blur(3px); animation: fade .2s; }
.palette { position: fixed; z-index: 95; left: 50%; top: 14vh; width: min(640px, 90vw); transform: translateX(-50%); border-radius: 20px; overflow: hidden; background: var(--glass2); backdrop-filter: blur(50px) saturate(1.8); -webkit-backdrop-filter: blur(50px) saturate(1.8); box-shadow: 0 40px 100px -20px oklch(0 0 0 / .6), var(--spec), 0 0 0 .5px var(--line2); animation: pal-in .3s var(--spring); }
@keyframes pal-in { from { opacity: 0; transform: translateX(-50%) scale(.95) translateY(-10px); } }
.palette input { width: 100%; padding: 18px 20px; border: 0; border-bottom: 1px solid var(--line2); background: none; color: var(--fg); font-size: 17px; outline: none; }
.pal-list { max-height: 52vh; overflow: auto; padding: 6px; }
.pal-item { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-radius: 10px; cursor: pointer; }
.pal-item.on { background: var(--acc); color: var(--on-acc); }
.pal-ic { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px; background: var(--s3); }
.pal-item.on .pal-ic { background: oklch(1 0 0 / .2); }
.pal-title { flex: 1; }
.pal-grp { font-size: 11.5px; color: var(--fg3); }
.pal-item.on .pal-grp { color: oklch(1 0 0 / .75); }
.pal-empty { padding: 30px; text-align: center; color: var(--fg3); }
.pal-foot { display: flex; gap: 14px; padding: 8px 14px; border-top: 1px solid var(--line2); color: var(--fg3); font-size: 11.5px; }
.pal-ask { margin-left: auto; }
```

- [ ] **Step 7: Mount the palette.** In `src/App.tsx` add `import { Palette } from "./palette/Palette";` and render `<Palette />` next to `<Toaster />`. In `src/main.tsx` add `import "./palette/palette.css";`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test src/palette`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src
git commit -m "feat(palette): command palette with navigation, split, theme and ask-Claude stub"
```

## Task 15: Global keyboard map

**Files:**
- Create: `src/keys/globalKeys.ts`
- Test: `src/keys/globalKeys.test.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write the failing test**

```ts
import { handleGlobalKey } from "./globalKeys";
import { useStage } from "../state/stage";
import { usePalette } from "../palette/store";
import { useDialog } from "../ui/dialog";
import { initialStage } from "../stage/stageModel";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

beforeEach(() => {
  useStage.setState({ ...initialStage });
  usePalette.setState({ open: false, query: "" });
  useDialog.setState({ current: null });
  (document.activeElement as HTMLElement | null)?.blur();
});

it("number keys switch screens in the focused pane", () => {
  expect(handleGlobalKey(key({ key: "4" }))).toBe(true);
  expect(useStage.getState().panes).toEqual(["changes"]);
});

it("ignores number keys while typing", () => {
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  expect(handleGlobalKey(key({ key: "2" }))).toBe(false);
  input.remove();
});

it("⌘K toggles the palette", () => {
  handleGlobalKey(key({ key: "k", metaKey: true }));
  expect(usePalette.getState().open).toBe(true);
});

it("⌘\\ toggles a right split and ⌘⇧\\ a bottom split", () => {
  handleGlobalKey(key({ key: "\\", code: "Backslash", metaKey: true }));
  expect(useStage.getState().panes).toEqual(["launchpad", "changes"]);
  handleGlobalKey(key({ key: "\\", code: "Backslash", metaKey: true }));
  expect(useStage.getState().panes).toHaveLength(1);
  handleGlobalKey(key({ key: "|", code: "Backslash", metaKey: true, shiftKey: true }));
  expect(useStage.getState().dir).toBe("v");
});

it("⌃⇧G goes to Changes", () => {
  handleGlobalKey(key({ key: "G", ctrlKey: true, shiftKey: true }));
  expect(useStage.getState().panes).toEqual(["changes"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/keys`
Expected: FAIL, because the module cannot be resolved.

- [ ] **Step 3: Create `src/keys/globalKeys.ts`**

```ts
import { useEffect } from "react";
import { useStage } from "../state/stage";
import { usePalette } from "../palette/store";
import { useDialog } from "../ui/dialog";
import { NUMBER_KEYS } from "../screens/registry";

export function isTyping(el: Element | null): boolean {
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el as HTMLElement).isContentEditable);
}

/** Returns true when the key was handled (caller should preventDefault). Spec §6.1.6. */
export function handleGlobalKey(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === "k") { usePalette.getState().toggle(); return true; }
  if (mod && e.code === "Backslash") { useStage.getState().toggleSplit(e.shiftKey ? "bottom" : "right"); return true; }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "g") { useStage.getState().go("changes"); return true; }
  if (mod || e.altKey || isTyping(document.activeElement)) return false;
  if (usePalette.getState().open || useDialog.getState().current) return false;
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) { useStage.getState().go(NUMBER_KEYS[n - 1]); return true; }
  return false;
}

export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (handleGlobalKey(e)) e.preventDefault(); };
    const onPalette = () => usePalette.getState().show();
    window.addEventListener("keydown", onKey);
    window.addEventListener("bw:palette", onPalette); // fired by the title-bar search pill
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("bw:palette", onPalette);
    };
  }, []);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/keys`
Expected: PASS (5 tests).

- [ ] **Step 5: Use the hook in `src/App.tsx`.** Add `import { useGlobalKeys } from "./keys/globalKeys";` and call `useGlobalKeys();` as the first line inside `App()`.

- [ ] **Step 6: Run the full gate**

Run: `pnpm typecheck && pnpm test && (cd src-tauri && cargo clippy -- -D warnings && cargo test)`
Expected: everything PASSES with no warnings.

- [ ] **Step 7: Commit**

```bash
git add src
git commit -m "feat(keys): global keyboard map (palette, split toggles, number keys)"
```

## 🛑 MANUAL TEST CHECKPOINT 4 (M0 complete)

Stop here. Give the user these instructions:

**Run:** `pnpm tauri dev`

**Check:**
1. **⌘K** and clicking the title-bar search pill both open the glass palette. Typing filters with fuzzy matching (try "spl bot gra").
   - ↑ / ↓ move the selection, Enter runs it, Esc or a click outside closes it.
   - Each row shows its group (Navigate, Split view, Appearance) and shortcut hints.
2. "Go to …", "Split right with …", "Split bottom with …", "Close split view", "Swap split panes", and "Toggle dark / light" all work.
3. Typing something ending in **?** shows a single "Ask Claude: …" row. Running it shows a "later milestone" toast.
4. Number keys **1–9** switch screens in the focused pane (Launchpad, Graph, Files, Changes, Agents, PRs, Repository, Inbox, Conflicts). They do nothing while typing in an input, or while the palette or a dialog is open.
5. **⌘\\** toggles a right split, **⌘⇧\\** toggles a bottom split, and **⌃⇧G** jumps to Changes.
6. Everything from checkpoints 1–3 still works.

After the user signs off, M0 is done. The next step is writing the M1 plan (repos, groups, worktrees, graph).

---

## Self-review notes (completed while writing)

**Spec coverage for M0:**

| Spec section | Covered by |
|---|---|
| §5 tokens, themes, density, reduce transparency, motion | Tasks 3, 8 |
| §6.1.1 title bar | Task 4. Group switcher and project tabs are M1. |
| §6.1.3 sidebar | Tasks 4, 12. Worktrees list is M1; an empty state stands in. |
| §6.1.4 split view, all entry points, persistence, container queries | Tasks 9–12. The palette entry point is Task 14 and shortcuts are Task 15. |
| §6.1.5 palette | Tasks 13–14. Files, worktrees, and GitHub commands join in later milestones. |
| §6.1.6 keyboard map | Task 15. ⌃\`, ⌘Z, ⌘↵, ⌘S, and ⌘⇧N belong to features built later. |
| §6.1.7 toasts with action | Task 7 |
| §6.1.8 `ask()` dialog | Task 7 |
| §6.1.9 theme settings | Task 8 |
| §3.4 SQLite settings | Task 5 |
| §8 CSP, least privilege | Task 2 |
| Default UI language English, single catalog | Task 3 |

**Type consistency checks:**
- `StageState`, `Side`, `Dir`, `ScreenId`, `MenuItem`, and `AskOptions` are defined once and reused.
- `useStage` actions (`go`, `focusPane`, `openSplit`, `closePane`, `toggleSplit`, `swap`, `toggleDir`, `setRatio`, `load`) match their usages in Sidebar, PaneControls, Stage, the palette commands, and globalKeys.
- `SCREEN_MIME` is shared by Sidebar (drag source) and Stage (drop target).
