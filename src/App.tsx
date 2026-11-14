import { useEffect } from "react";
import { ConflictWatcher } from "./screens/conflicts/ConflictsScreen";
import { PublishDialogHost } from "./screens/repo/PublishDialog";
import { TitleBar } from "./shell/TitleBar";
import { Sidebar } from "./shell/Sidebar";
import { StatusBar } from "./shell/StatusBar";
import { ShortcutSheet } from "./shell/ShortcutSheet";
import { Stage } from "./stage/Stage";
import { useSettings } from "./state/settings";
import { useStage } from "./state/stage";
import { useDock } from "./terminal/dock";
import { TerminalDock } from "./terminal/TerminalDock";
import "./terminal/terminal-dock.css";
import { applyTheme } from "./theme/theme";
import { Toaster } from "./ui/toast";
import { DialogHost } from "./ui/dialog";
import { Palette } from "./palette/Palette";
import { useGlobalKeys } from "./keys/globalKeys";
import { useSidebar } from "./state/sidebar";
import { useRepos } from "./state/repos";
import { subscribeUndoState } from "./ipc/undo";
import { useSessions } from "./agents/sessions";
import { useProfiles } from "./agents/profiles";
import { errorMessage } from "./ipc/errors";
import { toast } from "./ui/toast";

export default function App() {
  useGlobalKeys();
  const collapsed = useSidebar((s) => s.collapsed);
  const dockMode = useDock((s) => s.mode);
  const dockOpen = useDock((s) => s.open);
  useEffect(() => {
    void useSettings.getState().load();
    void useSidebar.getState().load();
    void useRepos.getState().load();
    void useDock.getState().load();
    void (async () => {
      await useStage.getState().load();
      try {
        await useProfiles.getState().load();
      } catch (error) {
        toast({ title: errorMessage(error), icon: "⚠" });
      }
      await useSessions.getState().load();
    })().catch((error) => {
      toast({ title: errorMessage(error), icon: "⚠" });
    });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(useSettings.getState().theme);
    mq?.addEventListener("change", onChange);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      void subscribeUndoState().then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      });
    }
    return () => {
      disposed = true;
      mq?.removeEventListener("change", onChange);
      unlisten?.();
    };
  }, []);
  const dockFlow = dockOpen && (dockMode === "bottom" || dockMode === "right") ? dockMode : "none";
  return (
    <div
      className="app"
      data-sidebar={collapsed ? "collapsed" : "expanded"}
      data-dock={dockFlow}
    >
      <TitleBar />
      <div className="body">
        <Sidebar />
        <div className={"main main-dock-" + dockFlow}>
          <Stage />
          <TerminalDock />
        </div>
      </div>
      <StatusBar />
      <ShortcutSheet />
      <ConflictWatcher />
      <PublishDialogHost />
      <Toaster />
      <DialogHost />
      <Palette />
    </div>
  );
}
