import type { MsgKey } from "../i18n/en";

export type ScreenId =
  | "launchpad" | "graph" | "files" | "changes" | "agents" | "terminal" | "prs" | "repo" | "inbox"
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
  { id: "terminal", icon: "❯_", label: "nav.terminal", section: "nav" },
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
export const NUMBER_KEYS: ScreenId[] = ["launchpad", "graph", "files", "changes", "agents", "terminal", "prs", "repo", "inbox"];
