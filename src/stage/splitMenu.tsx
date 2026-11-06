import { SCREENS, type ScreenId } from "../screens/registry";
import { closeMenus, type MenuItem } from "../ui/Menu";
import { t } from "../i18n/t";
import { SIDES } from "./dnd";
import type { Side } from "./stageModel";

export function splitMenuItems(panes: ScreenId[], open: (id: ScreenId, side: Side) => void): MenuItem[] {
  return [
    { kind: "header", label: t("split.menuTitle") },
    ...SCREENS.filter((s) => !panes.includes(s.id)).map((s): MenuItem => ({
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
    })),
    { kind: "separator" },
    { kind: "note", label: t("split.menuNote") },
  ];
}
