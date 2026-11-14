// Multi-window (M10): each window is an independent workspace. Window-scoped
// settings are namespaced in ipc/settings.ts; this module opens windows,
// seeds a new window's workspace, restores windows at launch, cleans up a
// window the user closes, and keeps app-wide settings in sync across windows.
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "../ipc/bindings";
import { onGlobalSettingSaved, windowLabel } from "../ipc/settings";
import { layoutOf } from "../stage/stageModel";
import type { ScreenId } from "../screens/registry";
import { useStage } from "./stage";
import { useSettings } from "./settings";
import { useProfiles } from "../agents/profiles";
import { useSessions } from "../agents/sessions";
import { useDock } from "../terminal/dock";
import { useTerminalScreen } from "../terminal/screen";
import { closeTerminal } from "../ipc/pty";
import { ask } from "../ui/dialog";
import { toast } from "../ui/toast";
import { useGithubAccounts } from "../github/store";
import { t } from "../i18n/t";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const SETTINGS_EVENT = "settings:changed";
/**
 * App-wide keys whose store reloads when another window saves them, so a
 * window never writes back a stale snapshot over another window's change.
 */
const RELOADERS: Record<string, () => Promise<unknown>> = {
  theme: () => useSettings.getState().load(),
  agentAutoSwitch: () => useSettings.getState().load(),
  agentTokenSaver: () => useSettings.getState().load(),
  agentSaverProtected: () => useSettings.getState().load(),
  singleKeyShortcuts: () => useSettings.getState().load(),
  agentProfiles: () => useProfiles.getState().load(),
  githubAccounts: () => useGithubAccounts.getState().load(),
};

export const isMainWindow = () => windowLabel() === "main";

let opening = false;
/**
 * Open a new, empty workspace window showing `screen` (default Home) as a
 * single pane. Rust picks the label and seeds it atomically; returns null
 * when no window was created.
 */
export async function openNewWindow(screen: ScreenId = "home"): Promise<string | null> {
  if (!inTauri() || opening) return null;
  opening = true;
  try {
    // A new window is an isolated workspace: no group, no project tabs, no
    // worktree carried over (`openProjectIds: []` keeps the selection empty
    // instead of falling back to the first project).
    const seeds = [
      { key: "repos", value: JSON.stringify({ activeGroupId: null, activeProjectId: null, openProjectIds: [], collapsedGroupIds: [] }) },
      { key: "stage", value: JSON.stringify({ version: 2, current: layoutOf([screen]), layouts: {} }) },
    ];
    return await commands.windowCreate(seeds);
  } catch (error) {
    toast({ title: error instanceof Error ? error.message : String(error), icon: "⚠" });
    return null;
  } finally {
    opening = false;
  }
}

/**
 * Move pane `index` (default: focused) to a new window: it opens there as a
 * single pane, and leaves this window's split (a lone pane just stays).
 */
export async function moveFocusedPaneToNewWindow(index?: number): Promise<void> {
  const stage = useStage.getState();
  const at = index ?? stage.focus;
  const screen = stage.panes[at];
  if (!screen) return;
  const opened = await openNewWindow(screen);
  if (opened && useStage.getState().panes.length > 1) useStage.getState().closePane(at);
}

/** PTY sessions of this window's terminal dock and Terminal screen. */
function terminalSessions(): string[] {
  const dock = useDock.getState().tabs.flatMap((tab) => (tab.sessionId ? [tab.sessionId] : []));
  const screen = useTerminalScreen
    .getState()
    .tabs.flatMap((tab) => Object.values(tab.panes).flatMap((pane) => (pane.sessionId ? [pane.sessionId] : [])));
  return [...new Set([...dock, ...screen])];
}

/** Wire window lifecycle and cross-window settings sync; returns a disposer. */
export async function startWindowSync(): Promise<() => void> {
  if (!inTauri()) return () => undefined;
  const self = windowLabel();
  onGlobalSettingSaved((key) => void emit(SETTINGS_EVENT, { key, source: self }).catch(() => undefined));
  const unlisten = await listen<{ key: string; source: string }>(SETTINGS_EVENT, (event) => {
    if (event.payload.source === self) return;
    const reload = RELOADERS[event.payload.key];
    if (reload) void reload().catch(() => undefined);
  });
  let unlistenClose: (() => void) | undefined;
  if (self === "main") {
    void commands.windowRestore().catch(() => []);
  } else {
    // A window the user closes is gone for good: its agents and terminals
    // stop (no invisible PTYs) and it is not reopened at the next launch.
    // App quit does not pass through here, so quit keeps the window list.
    unlistenClose = await getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      const agents = useSessions.getState().sessions.filter((session) => session.sessionId && !useSessions.getState().isExited(session.sessionId));
      const terminals = terminalSessions();
      if (agents.length + terminals.length > 0) {
        const ok = await ask({
          title: t("windows.closeTitle"),
          body: t("windows.closeBody", { count: agents.length + terminals.length }),
          ok: t("windows.closeOk"),
          danger: true,
        });
        if (ok !== true) return;
      }
      for (const session of [...useSessions.getState().sessions]) {
        await useSessions.getState().closeSession(session.id, { confirm: false }).catch(() => undefined);
      }
      await Promise.all(terminals.map((id) => closeTerminal(id).catch(() => undefined)));
      // Rust forgets the caller (its own label) and destroys it.
      await commands.windowCloseSelf().catch(() => undefined);
    });
  }
  return () => {
    onGlobalSettingSaved(null);
    unlisten();
    unlistenClose?.();
  };
}
