import { useEffect } from "react";
import { TitleBar } from "./shell/TitleBar";
import { Sidebar } from "./shell/Sidebar";
import { Stage } from "./stage/Stage";
import { useSettings } from "./state/settings";
import { useStage } from "./state/stage";
import { applyTheme } from "./theme/theme";
import { Toaster } from "./ui/toast";
import { DialogHost } from "./ui/dialog";

export default function App() {
  useEffect(() => {
    void useSettings.getState().load();
    void useStage.getState().load();
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
      <Toaster />
      <DialogHost />
    </div>
  );
}
