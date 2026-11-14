import { moveFocusedPaneToNewWindow, openNewWindow } from "../state/windows";
import type { MsgKey } from "../i18n/en";
import { t } from "../i18n/t";
import { NAV_SCREENS, SCREENS } from "../screens/registry";
import { useStage } from "../state/stage";
import { useSettings } from "../state/settings";
import { toast } from "../ui/toast";
import { useSidebar } from "../state/sidebar";
import { useWorktrees } from "../state/worktrees";
import { useDock } from "../terminal/dock";
import { useTerminalScreen } from "../terminal/screen";
import { undoLast } from "../ipc/undo";
import { useChanges } from "../state/changes";
import { ask } from "../ui/dialog";
import { openHistory } from "../state/history";
import { useConflicts } from "../screens/conflicts/conflictsState";

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
  const nav: Command[] = SCREENS.filter((s) => s.section !== "tools").map((s) => {
    const n = NAV_SCREENS.indexOf(s.id);
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
    { id: "split:close", group: "palette.group.split", icon: "✕", title: t("palette.closeSplit"), kbd: "⌘⌥\\", run: () => { const s = stage(); if (s.panes.length > 1) s.closePane(s.focus); } },
    { id: "split:swap", group: "palette.group.split", icon: "⇄", title: t("palette.swapSplit"), run: () => stage().swap() },
    { id: "window:new", group: "palette.group.split", icon: "⧉", title: t("windows.new"), kbd: "⌘⇧N", run: () => void openNewWindow() },
    { id: "window:move", group: "palette.group.split", icon: "⧉", title: t("windows.moveToNew"), run: () => void moveFocusedPaneToNewWindow() },
    { id: "split:equalize", group: "palette.group.split", icon: "⊞", title: t("palette.equalizeSplits"), run: () => stage().equalizeAll() },
  ];
  const appearance: Command[] = [
    {
      id: "theme:toggle",
      group: "palette.group.appearance",
      icon: "◐",
      title: t("palette.toggleTheme"),
      run: () => useSettings.getState().toggleTheme(),
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
    { id: "open.blame", group: "palette.group.navigate", icon: "≡", title: t("palette.openBlame"), run: () => openHistory("file") },
  ];
  const active = useWorktrees.getState().activePath;
  const conflictList = useConflicts.getState();
  if (active && conflictList.worktree === active && conflictList.list?.operation !== "none" && conflictList.list) {
    open.push({ id:"open.conflicts", group:"palette.group.navigate", icon:"⚠", title:t("operation.resolve"), run:() => stage().go("conflicts") });
  }
  const terminal: Command[] = [
    { id: "terminal.toggle", group: "palette.group.navigate", icon: "❯_", title: t("palette.toggleTerminal"), kbd: "⌃`", run: () => useDock.getState().toggle() },
    { id: "terminal.newTab", group: "palette.group.navigate", icon: "＋", title: t("palette.newTerminalTab"), run: () => { void useDock.getState().newTab(); } },
    { id: "terminal.screen", group: "palette.group.navigate", icon: "❯_", title: t("palette.terminalScreen"), run: () => useStage.getState().go("terminal") },
    { id: "terminal.screenNewTab", group: "palette.group.navigate", icon: "＋", title: t("palette.terminalNewTab"), run: () => { void useTerminalScreen.getState().newTab(); } },
    { id: "terminal.screenSplitRight", group: "palette.group.navigate", icon: "⫴", title: t("palette.terminalSplitRight"), run: () => { const s = useTerminalScreen.getState(); if (s.selectedTabId) void s.splitFocusedPane(s.selectedTabId, "h"); } },
    { id: "terminal.screenSplitDown", group: "palette.group.navigate", icon: "⫴", title: t("palette.terminalSplitDown"), run: () => { const s = useTerminalScreen.getState(); if (s.selectedTabId) void s.splitFocusedPane(s.selectedTabId, "v"); } },
    { id: "terminal.screenBroadcast", group: "palette.group.navigate", icon: "◉", title: t("palette.terminalBroadcast"), run: () => { const s = useTerminalScreen.getState(); if (s.selectedTabId) s.toggleBroadcast(s.selectedTabId); } },
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
  return [...nav, ...split, ...appearance, ...open, ...terminal, ...git, ...undo];
}

export function askClaudeCommand(q: string): Command {
  return { id: "ask", group: "palette.group.ai", icon: "✦", title: t("palette.askClaude", { q }), run: () => toast({ title: t("palette.aiLater"), icon: "✦" }) };
}
