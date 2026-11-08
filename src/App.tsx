import { useEffect } from "react";
import { TitleBar } from "./shell/TitleBar";
import { Sidebar } from "./shell/Sidebar";
import { Stage } from "./stage/Stage";
import { useSettings } from "./state/settings";
import { useStage } from "./state/stage";
import { applyTheme } from "./theme/theme";
import { Toaster } from "./ui/toast";
import { DialogHost } from "./ui/dialog";
import { Palette } from "./palette/Palette";
import { useGlobalKeys } from "./keys/globalKeys";
import { useSidebar } from "./state/sidebar";
import { useRepos } from "./state/repos";
import { useChanges } from "./state/changes";
import { subscribeUndoState } from "./ipc/undo";

export default function App() {
  useGlobalKeys();
  const collapsed = useSidebar((s) => s.collapsed);
  useEffect(() => {
    void useSettings.getState().load();
    void useStage.getState().load();
    void useSidebar.getState().load();
    void useRepos.getState().load();
    void useChanges.getState().load();
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
  return (
    <div className="app" data-sidebar={collapsed ? "collapsed" : "expanded"}>
      <TitleBar />
      <div className="body">
        <Sidebar />
        <Stage />
      </div>
      <Toaster />
      <DialogHost />
      <Palette />
    </div>
  );
}
