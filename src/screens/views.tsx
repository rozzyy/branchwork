import { lazy, Suspense, useEffect, useState, type FC } from "react";
import { SCREENS, screenById, type ScreenId } from "./registry";
import { t } from "../i18n/t";
import { ScreenLoader } from "../ui/ScreenLoader";
import { SettingsToolbar, SettingsView } from "./settings/SettingsScreen";
import { GraphToolbar, GraphView } from "./graph/GraphScreen";
import { ChangesToolbar, ChangesView } from "./changes/ChangesScreen";
import { FilesToolbar, FilesView } from "./files/FilesScreen";
import { BlameToolbar, BlameView } from "./blame/BlameScreen";
import { TerminalScreen, TerminalToolbar } from "../terminal/TerminalScreen";
import { AgentsToolbar, AgentsView } from "./agents/AgentsScreen";
import { InboxToolbar, InboxView } from "./inbox/InboxScreen";
import { LaunchpadToolbar, LaunchpadView } from "./launchpad/LaunchpadScreen";
import { ConflictsToolbar, ConflictsView } from "./conflicts/ConflictsScreen";
import { RebaseToolbar, RebaseView } from "./rebase/RebaseScreen";

export interface ScreenView {
  Toolbar: FC;
  View: FC;
}

const RepoView = lazy(() => import("./repo/RepoScreen").then((module) => ({ default: module.RepoView })));

function RepoToolbar() {
  return <h1 className="pane-title">{t("nav.repo")}</h1>;
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
VIEWS.graph = { Toolbar: GraphToolbar, View: GraphView };
VIEWS.changes = { Toolbar: ChangesToolbar, View: ChangesView };
VIEWS.files = { Toolbar: FilesToolbar, View: FilesView };
VIEWS.blame = { Toolbar: BlameToolbar, View: BlameView };
VIEWS.terminal = { Toolbar: TerminalToolbar, View: TerminalScreen };
VIEWS.agents = { Toolbar: AgentsToolbar, View: AgentsView };
VIEWS.repo = { Toolbar: RepoToolbar, View: RepoViewBoundary };
VIEWS.inbox = { Toolbar: InboxToolbar, View: InboxView };
VIEWS.launchpad = { Toolbar: LaunchpadToolbar, View: LaunchpadView };
VIEWS.conflicts = { Toolbar: ConflictsToolbar, View: ConflictsView };
VIEWS.rebase = { Toolbar: RebaseToolbar, View: RebaseView };
