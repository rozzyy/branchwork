import type { MsgKey } from "../i18n/en";
import { t } from "../i18n/t";
import { NUMBER_KEYS, SCREENS } from "../screens/registry";
import { useStage } from "../state/stage";
import { useSettings } from "../state/settings";
import { prefersDark, resolveMode } from "../theme/theme";
import { toast } from "../ui/toast";
import { useSidebar } from "../state/sidebar";

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
    { id: "split:close", group: "palette.group.split", icon: "✕", title: t("palette.closeSplit"), kbd: "⌘\\", run: () => { const s = stage(); if (s.panes.length > 1) s.closePane(s.focus); } },
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
    { id: "sidebar:toggle", group: "palette.group.appearance", icon: "◧", title: t("palette.toggleSidebar"), kbd: "⌘B", run: () => useSidebar.getState().toggle() },
  ];
  return [...nav, ...split, ...appearance];
}

export function askClaudeCommand(q: string): Command {
  return { id: "ask", group: "palette.group.ai", icon: "✦", title: t("palette.askClaude", { q }), run: () => toast({ title: t("palette.aiLater"), icon: "✦" }) };
}
