import type { FC } from "react";
import { SCREENS, screenById, type ScreenId } from "./registry";
import { t } from "../i18n/t";
import { SettingsToolbar, SettingsView } from "./settings/SettingsScreen";
import { GraphToolbar, GraphView } from "./graph/GraphScreen";

export interface ScreenView {
  Toolbar: FC;
  View: FC;
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
