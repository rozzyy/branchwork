import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme/tokens.css";
import "./ui/ui.css";
import "./shell/shell.css";
import "./stage/stage.css";
import "./screens/settings/settings.css";

if ("__TAURI_INTERNALS__" in window) document.documentElement.classList.add("tauri");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
