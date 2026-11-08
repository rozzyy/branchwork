import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DiffRenderer } from "../../diff/DiffRenderer";
import { errorMessage } from "../../ipc/errors";
import { readDiff, type DiffArea, type DiffModel } from "../../ipc/diff";
import { t } from "../../i18n/t";
import { useChanges, type ChangesCommand } from "../../state/changes";
import { useFiles } from "../../state/files";
import { useStage } from "../../state/stage";

const GRAPH_TAB_ID = "graph";

interface DiffTab {
  id: string;
  path: string;
  area: DiffArea;
}

export function GraphEditorTabs({
  worktreePath,
  children,
  renderInspector,
}: {
  worktreePath: string;
  children(openDiff: (path: string, area: DiffArea) => void): ReactNode;
  renderInspector(openDiff: (path: string, area: DiffArea) => void): ReactNode;
}) {
  const dispatch = useChanges((state) => state.dispatch);
  const [tabs, setTabs] = useState<DiffTab[]>([]);
  const [activeTabId, setActiveTabId] = useState(GRAPH_TAB_ID);
  const [diff, setDiff] = useState<DiffModel | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([]);
  const requestId = useRef(0);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  useEffect(() => () => {
    requestId.current++;
  }, []);

  const loadDiff = useCallback((tab: DiffTab) => {
    const currentRequest = ++requestId.current;
    setDiff(null);
    setDiffError(null);
    setDiffLoading(true);
    setSelectedLineIds([]);
    void readDiff(worktreePath, tab.path, tab.area)
      .then((model) => {
        if (requestId.current === currentRequest) setDiff(model);
      })
      .catch((reason: unknown) => {
        if (requestId.current === currentRequest) setDiffError(errorMessage(reason));
      })
      .finally(() => {
        if (requestId.current === currentRequest) setDiffLoading(false);
      });
  }, [worktreePath]);

  const openDiff = useCallback((path: string, area: DiffArea) => {
    const tab: DiffTab = { id: JSON.stringify([area, path]), path, area };
    setTabs((current) => current.some((existing) => existing.id === tab.id) ? current : [...current, tab]);
    setActiveTabId(tab.id);
    loadDiff(tab);
  }, [loadDiff]);

  const activateTab = (tab: DiffTab) => {
    setActiveTabId(tab.id);
    loadDiff(tab);
  };

  const closeTab = (tab: DiffTab) => {
    const nextTabs = tabs.filter((item) => item.id !== tab.id);
    setTabs(nextTabs);
    if (activeTabId !== tab.id) return;
    const currentIndex = tabs.findIndex((item) => item.id === tab.id);
    const nextActive = nextTabs[Math.max(0, currentIndex - 1)];
    if (nextActive) activateTab(nextActive);
    else {
      requestId.current++;
      setActiveTabId(GRAPH_TAB_ID);
      setDiff(null);
      setDiffError(null);
      setDiffLoading(false);
      setSelectedLineIds([]);
    }
  };

  const runAction = async (command: ChangesCommand) => {
    const succeeded = await dispatch(command);
    if (succeeded && activeTab) loadDiff(activeTab);
  };

  return (
    <div className="graph-screen">
      <div className="graph-main-pane">
        <div className="graph-editor-tabs" role="tablist" aria-label={t("graph.editorTabs")}>
          <button
            aria-selected={activeTabId === GRAPH_TAB_ID}
            className={"graph-editor-tab" + (activeTabId === GRAPH_TAB_ID ? " selected" : "")}
            onClick={() => {
              requestId.current++;
              setActiveTabId(GRAPH_TAB_ID);
              setDiffLoading(false);
            }}
            role="tab"
            type="button"
          >
            {t("nav.graph")}
          </button>
          {tabs.map((tab) => {
            const label = t(tab.area === "staged" ? "graph.files.staged" : "graph.files.unstaged");
            return (
              <div className="graph-editor-tab-wrap" key={tab.id}>
                <button
                  aria-selected={activeTabId === tab.id}
                  className={"graph-editor-tab" + (activeTabId === tab.id ? " selected" : "")}
                  onClick={() => activateTab(tab)}
                  role="tab"
                  title={tab.path}
                  type="button"
                >
                  {t("graph.diffTab", { path: tab.path, area: label })}
                </button>
                <button
                  aria-label={t("graph.closeDiffTab", { path: tab.path, area: label.toLowerCase() })}
                  className="graph-editor-tab-close"
                  onClick={() => closeTab(tab)}
                  title={t("graph.closeDiffTab", { path: tab.path, area: label.toLowerCase() })}
                  type="button"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {activeTab ? (
          <div className="graph-diff-editor" role="tabpanel">
            {diffLoading && <p className="graph-muted">{t("graph.loadingDiff")}</p>}
            {diffError && <p className="graph-inline-error" role="alert">{t("graph.wipDiffError", { message: diffError })}</p>}
            {diff && (
              <DiffRenderer
                area={activeTab.area}
                fileName={activeTab.path}
                hunkAreas={diff.hunks.map(() => activeTab.area)}
                key={activeTab.id}
                mode="inline"
                model={diff}
                onOpenFile={() => {
                  useFiles.getState().openFile(activeTab.path);
                  useStage.getState().go("files");
                }}
                onRequestHunkAction={(_hunk, action, hunkIndex) => {
                  if (action === "stage") {
                    void runAction({
                      type: "stage-hunks",
                      path: activeTab.path,
                      hunkIndices: [hunkIndex],
                      area: activeTab.area,
                    });
                  } else if (action === "unstage") {
                    void runAction({
                      type: "unstage-hunks",
                      path: activeTab.path,
                      hunkIndices: [hunkIndex],
                    });
                  } else {
                    void runAction({ type: "revert-hunk", path: activeTab.path, hunkIndex });
                  }
                }}
                onStageSelectedLines={() => {
                  void runAction({
                    type: "stage-lines",
                    path: activeTab.path,
                    lineIds: selectedLineIds,
                    area: activeTab.area,
                  });
                }}
                onToggleLine={(_hunk, lineId) => {
                  setSelectedLineIds((current) => current.includes(lineId)
                    ? current.filter((id) => id !== lineId)
                    : [...current, lineId]);
                }}
                selectedLineIds={selectedLineIds}
              />
            )}
          </div>
        ) : children(openDiff)}
      </div>
      {renderInspector(openDiff)}
    </div>
  );
}
