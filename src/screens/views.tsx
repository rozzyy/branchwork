import { lazy, Suspense, useEffect, useState, type FC } from "react";
import { SCREENS, screenById, type ScreenId } from "./registry";
import { t } from "../i18n/t";
import { ScreenLoader } from "../ui/ScreenLoader";
import { SettingsToolbar, SettingsView } from "./settings/SettingsScreen";
import { ChangesToolbar, ChangesView } from "./changes/ChangesScreen";
import { FilesToolbar, FilesView } from "./files/FilesScreen";
import { TerminalScreen, TerminalToolbar } from "../terminal/TerminalScreen";
import { AgentsToolbar, AgentsView } from "./agents/AgentsScreen";
import { ConflictsToolbar, ConflictsView } from "./conflicts/ConflictsScreen";
import { HistoryToolbar, HistoryView } from "./history/HistoryScreen";
import { HomeToolbar, HomeView } from "./home/HomeScreen";

export interface ScreenView {
  Toolbar: FC;
  View: FC;
}

const RepoView = lazy(() => import("./repo/RepoScreen").then((module) => ({ default: module.RepoView })));

function RepoToolbar() {
  return <h1 className="pane-title">{t("nav.github")}</h1>;
}

function RepoViewBoundary() {
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setStarted(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (!started) return <ScreenLoader>{t("repo.loading")}</ScreenLoader>;
  return (
    <Suspense fallback={<ScreenLoader>{t("repo.loading")}</ScreenLoader>}>
      <RepoView />
    </Suspense>
  );
}

function placeholder(id: ScreenId): ScreenView {
  const def = screenById(id);
  return {
    Toolbar: () => <h1 className="pane-title">{t(def.label)}</h1>,
    View: () => (
      <div className="placeholder">
        <div className="placeholder-icon" aria-hidden>{def.icon}</div>
        <h2>{t(def.label)}</h2>
        <p>{t("placeholder.body")}</p>
      </div>
    ),
  };
}

export const VIEWS = Object.fromEntries(SCREENS.map((s) => [s.id, placeholder(s.id)])) as Record<ScreenId, ScreenView>;

VIEWS.settings = { Toolbar: SettingsToolbar, View: SettingsView };
VIEWS.history = { Toolbar: HistoryToolbar, View: HistoryView };
VIEWS.changes = { Toolbar: ChangesToolbar, View: ChangesView };
VIEWS.files = { Toolbar: FilesToolbar, View: FilesView };
VIEWS.terminal = { Toolbar: TerminalToolbar, View: TerminalScreen };
VIEWS.agents = { Toolbar: AgentsToolbar, View: AgentsView };
VIEWS.github = { Toolbar: RepoToolbar, View: RepoViewBoundary };
VIEWS.home = { Toolbar: HomeToolbar, View: HomeView };
VIEWS.conflicts = { Toolbar: ConflictsToolbar, View: ConflictsView };
