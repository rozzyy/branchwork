import { NAV_SCREENS, SCREENS, type ScreenId } from "../screens/registry";
import { closeMenus, type MenuItem } from "../ui/Menu";
import { t } from "../i18n/t";
import { SIDES } from "./dnd";
import type { Side } from "./stageModel";

export function splitMenuItems(panes: ScreenId[], open: (id: ScreenId, side: Side) => void, preset: (panes: ScreenId[]) => void = () => undefined): MenuItem[] {
  return [
    { kind: "header", label: t("split.openBeside") },
    ...NAV_SCREENS.filter((id) => !panes.includes(id)).map((id): MenuItem => {
      const s = SCREENS.find((screen) => screen.id === id)!;
      return ({
      kind: "item",
      icon: s.icon,
      label: t(s.label),
      onSelect: () => open(s.id, "right"),
      extra: (
        <span className="dirs">
          {SIDES.map((d) => (
            <span
              key={d.side}
              className="dir"
              title={t(d.label)}
              onClick={(e) => { e.stopPropagation(); closeMenus(); open(s.id, d.side); }}
            >
              {d.icon}
            </span>
          ))}
        </span>
      ),
    });
    }),
    { kind: "separator" },
    { kind: "item", label: t("split.presetAgentChanges"), onSelect: () => preset(["agents", "changes"]) },
    { kind: "item", label: t("split.presetHistoryFiles"), onSelect: () => preset(["history", "files"]) },
    { kind: "separator" },
    { kind: "note", label: t("split.menuNote") },
  ];
}
