import type { MsgKey } from "../i18n/en";
import { t } from "../i18n/t";
import { NUMBER_KEYS, SCREENS } from "../screens/registry";
import { useStage } from "../state/stage";
import { useSettings } from "../state/settings";
import { prefersDark, resolveMode } from "../theme/theme";
import { toast } from "../ui/toast";
import { useSidebar } from "../state/sidebar";
import { useWorktrees } from "../state/worktrees";
import { undoLast } from "../ipc/undo";
import { useChanges } from "../state/changes";
import { ask } from "../ui/dialog";

export interface Command {
  id: string;
  group: MsgKey;
  icon: string;
  title: string;
  kbd?: string;
  run(): void;
}

const stage = () => useStage.getState();

async function discardAllChanges(): Promise<void> {
  const worktree = useWorktrees.getState().activePath;
  if (!worktree) {
    toast({ title: t("changes.worktreeRequired"), icon: "!" });
    return;
  }

  await useChanges.getState().refresh(worktree);
  const changes = useChanges.getState();
  if (changes.worktree !== worktree || useWorktrees.getState().activePath !== worktree) return;
  if (changes.error) {
    toast({ title: t("changes.error", { message: changes.error }), icon: "!" });
    return;
  }

  const paths = changes.entries.unstaged.map((entry) => entry.path);
  if (paths.length === 0) return;
  const confirmed = await ask({
    title: t("changes.discardAllTitle"),
    body: t("changes.discardAllBody"),
    ok: t("changes.discardAllOk"),
    danger: true,
    icon: "↶",
    meta: paths.join("\n"),
  });
  if (confirmed !== true) return;

  await useChanges.getState().dispatch({
    type: "discard-paths",
    paths,
    discardUntracked: true,
  });
}

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
  const undo: Command[] = [
    {
      id: "undo.last_action",
      group: "palette.group.git",
      icon: "↶",
      title: t("palette.undoLastAction"),
      run: () => {
        const worktree = useWorktrees.getState().activePath;
        if (worktree) undoLast(worktree);
      },
    },
  ];
  const open: Command[] = [
    { id: "open.changes", group: "palette.group.navigate", icon: "±", title: t("palette.openChanges"), run: () => stage().go("changes") },
    { id: "open.files", group: "palette.group.navigate", icon: "▤", title: t("palette.openFiles"), run: () => stage().go("files") },
    { id: "open.blame", group: "palette.group.navigate", icon: "≡", title: t("palette.openBlame"), run: () => stage().go("blame") },
  ];
  const git: Command[] = [
    {
      id: "view.toggle_staged",
      group: "palette.group.git",
      icon: "⇅",
      title: t("palette.toggleStaged"),
      run: () => {
        const { selection, select } = useChanges.getState();
        if (!selection || (selection.area !== "staged" && selection.area !== "unstaged")) return;
        select({
          path: selection.path,
          area: selection.area === "staged" ? "unstaged" : "staged",
        });
      },
    },
    {
      id: "changes.discard_all",
      group: "palette.group.git",
      icon: "↶",
      title: t("palette.discardAll"),
      run: () => { void discardAllChanges(); },
    },
  ];
  return [...nav, ...split, ...appearance, ...open, ...git, ...undo];
}

export function askClaudeCommand(q: string): Command {
  return { id: "ask", group: "palette.group.ai", icon: "✦", title: t("palette.askClaude", { q }), run: () => toast({ title: t("palette.aiLater"), icon: "✦" }) };
}
