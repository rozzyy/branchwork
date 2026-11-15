import { useEffect, useRef, useState } from "react";
import { useStage } from "../state/stage";
import { screenById } from "../screens/registry";
import { t } from "../i18n/t";

export function StageTabs() {
  const tabs = useStage((s) => s.tabs);
  const activeTabId = useStage((s) => s.activeTabId);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const { newTab, activateTab, closeTab, renameTab } = useStage.getState();

  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);

  const beginRename = (id: string, name: string) => {
    activateTab(id);
    setDraft(name);
    setInvalid(false);
    setEditing(id);
  };
  const restoreTabFocus = (id: string) => requestAnimationFrame(() => tabRefs.current.get(id)?.focus());
  const commit = (returnFocus = false) => {
    if (!editing) return;
    const id = editing;
    if (!renameTab(id, draft)) {
      setInvalid(true);
      requestAnimationFrame(() => input.current?.focus());
      return;
    }
    setInvalid(false);
    setEditing(null);
    if (returnFocus) restoreTabFocus(id);
  };
  const cancel = () => {
    const id = editing;
    setInvalid(false);
    setEditing(null);
    if (id) restoreTabFocus(id);
  };
  const labelFor = (tab: (typeof tabs)[number]) => tab.name || t(screenById(tab.stage.screens[tab.stage.focusId]).label);
  return (
    <div className="stage-tabs">
      <div className="stage-tablist" role="tablist" aria-label={t("stage.tabs.label")}>
      {tabs.map((tab) => {
        const selected = tab.id === activeTabId;
        const label = labelFor(tab);
        return (
          <div className={"stage-tab-card" + (selected ? " active" : "")} key={tab.id} role="presentation">
            {editing === tab.id ? (
              <input
                ref={input}
                className={"stage-tab stage-tab-input" + (invalid ? " invalid" : "")}
                role="tab"
                aria-selected="true"
                aria-label={t("stage.tabs.nameLabel")}
                aria-describedby={invalid ? "stage-tab-name-error" : "stage-tab-rename-hint"}
                value={draft}
                onChange={(event) => { setDraft(event.target.value); setInvalid(false); }}
                onBlur={() => commit()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); commit(true); }
                  if (event.key === "Escape") { event.preventDefault(); cancel(); }
                }}
              />
            ) : (
              <button
                type="button"
                className="stage-tab stage-tab-select"
                ref={(element) => { if (element) tabRefs.current.set(tab.id, element); else tabRefs.current.delete(tab.id); }}
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => activateTab(tab.id)}
                onDoubleClick={() => beginRename(tab.id, label)}
                onKeyDown={(event) => {
                  if (event.key === "F2") {
                    event.preventDefault();
                    beginRename(tab.id, label);
                    return;
                  }
                  const index = tabs.findIndex((candidate) => candidate.id === tab.id);
                  const nextIndex = event.key === "ArrowRight" ? (index + 1) % tabs.length
                    : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                    : event.key === "Home" ? 0
                    : event.key === "End" ? tabs.length - 1
                    : -1;
                  if (nextIndex < 0) return;
                  event.preventDefault();
                  const nextId = tabs[nextIndex].id;
                  activateTab(nextId);
                  requestAnimationFrame(() => tabRefs.current.get(nextId)?.focus());
                }}
              >{label}</button>
            )}
            <button
              type="button"
              className="stage-tab-close"
              aria-label={`${t("stage.tabs.close")} ${label}`}
              title={t("stage.tabs.close")}
              disabled={tabs.length === 1}
              onClick={() => closeTab(tab.id)}
            >×</button>
          </div>
        );
      })}
        <div className="stage-tab-new-slot" role="presentation">
          <button type="button" className="stage-tab-new" aria-label={t("stage.tabs.new")} title={t("stage.tabs.new")} onClick={() => newTab()}>＋</button>
        </div>
      </div>
      <span className={invalid ? "stage-tab-feedback invalid" : "stage-tab-feedback"} id={invalid ? "stage-tab-name-error" : "stage-tab-rename-hint"} aria-live="polite">
        {invalid ? t("stage.tabs.nameInvalid") : editing ? t("stage.tabs.renameHint") : ""}
      </span>
    </div>
  );
}
