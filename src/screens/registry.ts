import type { MsgKey } from "../i18n/en";

export type ScreenId =
  | "launchpad" | "graph" | "files" | "changes" | "agents" | "terminal" | "prs" | "repo" | "inbox"
  | "conflicts" | "rebase" | "blame" | "compare" | "settings";

/** Sidebar categories above the worktree list, in display order (header key + member screens). */
export type NavSection = "workspace" | "code" | "ai" | "github";
export const NAV_SECTIONS: { id: NavSection; label: MsgKey }[] = [
  { id: "workspace", label: "sidebar.sectionWorkspace" },
  { id: "code", label: "sidebar.sectionCode" },
  { id: "ai", label: "sidebar.sectionAi" },
  { id: "github", label: "sidebar.sectionGithub" },
];

export interface ScreenDef {
  id: ScreenId;
  icon: string;
  label: MsgKey;
  section: NavSection | "tools" | "footer";
}

export const SCREENS: ScreenDef[] = [
  { id: "launchpad", icon: "⌂", label: "nav.launchpad", section: "workspace" },
  { id: "inbox", icon: "◉", label: "nav.inbox", section: "workspace" },
  { id: "graph", icon: "⎇", label: "nav.graph", section: "code" },
  { id: "files", icon: "▤", label: "nav.files", section: "code" },
  { id: "changes", icon: "±", label: "nav.changes", section: "code" },
  { id: "agents", icon: "✦", label: "nav.agents", section: "ai" },
  { id: "terminal", icon: "❯_", label: "nav.terminal", section: "ai" },
  { id: "prs", icon: "⇄", label: "nav.prs", section: "github" },
  { id: "repo", icon: "◫", label: "nav.repo", section: "github" },
  { id: "conflicts", icon: "⚠", label: "tools.conflicts", section: "tools" },
  { id: "rebase", icon: "↕", label: "tools.rebase", section: "tools" },
  { id: "blame", icon: "≡", label: "tools.blame", section: "tools" },
  { id: "compare", icon: "⇆", label: "tools.compare", section: "tools" },
  { id: "settings", icon: "⚙", label: "nav.settings", section: "footer" },
];

export const SCREEN_IDS = SCREENS.map((s) => s.id);

export const screenById = (id: ScreenId): ScreenDef => SCREENS.find((s) => s.id === id)!;

/** Screens reachable with the number keys 1–9 (spec §6.1.6). */
export const NUMBER_KEYS: ScreenId[] = ["launchpad", "graph", "files", "changes", "agents", "terminal", "prs", "repo", "inbox"];
