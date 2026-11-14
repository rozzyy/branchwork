import type { MsgKey } from "../i18n/en";

export type ScreenId =
  | "home" | "changes" | "history" | "files" | "agents" | "terminal" | "github"
  | "settings" | "conflicts";
export type HistoryMode = "graph" | "file" | "rewrite";

export type NavSection = "screens" | "tools" | "footer";

export interface ScreenDef {
  id: ScreenId;
  icon: string;
  label: MsgKey;
  section: NavSection;
}

/** The seven primary destinations, in their permanent ⌘1–⌘7 order. */
export const NAV_SCREENS: ScreenId[] = ["home", "changes", "history", "files", "agents", "terminal", "github"];

/** All screens currently addressable by panes, palette, or a contextual route. */
export const SCREENS: ScreenDef[] = [
  { id: "home", icon: "⌂", label: "nav.home", section: "screens" },
  { id: "changes", icon: "±", label: "nav.changes", section: "screens" },
  { id: "history", icon: "⎇", label: "nav.history", section: "screens" },
  { id: "files", icon: "▤", label: "nav.files", section: "screens" },
  { id: "agents", icon: "✦", label: "nav.agents", section: "screens" },
  { id: "terminal", icon: "❯_", label: "nav.terminal", section: "screens" },
  { id: "github", icon: "◫", label: "nav.github", section: "screens" },
  { id: "conflicts", icon: "⚠", label: "tools.conflicts", section: "tools" },
  { id: "settings", icon: "⚙", label: "nav.settings", section: "footer" },
];
export const NAV_SECTIONS: { id: NavSection; label: MsgKey }[] = [
  { id: "screens", label: "sidebar.sectionScreens" },
];

export const SCREEN_IDS: ScreenId[] = [...NAV_SCREENS, "settings", "conflicts"];

export const screenById = (id: ScreenId): ScreenDef => SCREENS.find((s) => s.id === id)!;

/** Compatibility alias while the existing global-key handler is migrated in Task 07. */
export const NUMBER_KEYS = NAV_SCREENS;

/** Map persisted pane ids and old internal routes into the M7 screen model. */
export function migrateScreenId(id: string): { screen: ScreenId; historyMode?: HistoryMode } {
  switch (id) {
    case "launchpad":
    case "inbox":
    case "compare":
      return { screen: "home" };
    case "graph":
      return { screen: "history", historyMode: "graph" };
    case "blame":
      return { screen: "history", historyMode: "file" };
    case "rebase":
      return { screen: "history", historyMode: "rewrite" };
    case "repo":
      return { screen: "github" };
    case "home":
    case "changes":
    case "history":
    case "files":
    case "agents":
    case "terminal":
    case "github":
    case "conflicts":
    case "settings":
      return { screen: id };
    default:
      return { screen: "home" };
  }
}
