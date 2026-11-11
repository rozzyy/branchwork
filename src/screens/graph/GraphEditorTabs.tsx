import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DiffRenderer } from "../../diff/DiffRenderer";
import { errorMessage } from "../../ipc/errors";
import { readDiff, type DiffArea, type DiffModel } from "../../ipc/diff";
import { readGraphCommitFileDiff } from "../../ipc/graph";
import { t } from "../../i18n/t";
import { useChanges, type ChangesCommand } from "../../state/changes";
import { useFiles } from "../../state/files";
import { useStage } from "../../state/stage";

const GRAPH_TAB_ID = "graph";

interface WipDiffTab {
  id: string;
  path: string;
  area: DiffArea;
  kind: "wip";
}

interface CommitDiffTab {
  id: string;
  path: string;
  sha: string;
  kind: "commit";
}

type DiffTab = WipDiffTab | CommitDiffTab;

export function GraphEditorTabs({
  projectId,
  worktreePath,
  children,
  renderInspector,
}: {
  projectId: string;
  worktreePath: string;
  children(openDiff: (path: string, area: DiffArea) => void): ReactNode;
  renderInspector(
    openDiff: (path: string, area: DiffArea) => void,
    openCommitDiff: (sha: string, path: string) => void,
  ): ReactNode;
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

  useEffect(() => {
    void useChanges.getState().load();
    return () => {
      requestId.current++;
    };
  }, []);

  const loadDiff = useCallback((tab: DiffTab) => {
    const currentRequest = ++requestId.current;
    setDiff(null);
    setDiffError(null);
    setDiffLoading(true);
    setSelectedLineIds([]);
    const request = tab.kind === "commit"
      ? readGraphCommitFileDiff(projectId, worktreePath, tab.sha, tab.path)
      : readDiff(worktreePath, tab.path, tab.area);
    void request
      .then((model) => {
        if (requestId.current === currentRequest) setDiff(model);
      })
      .catch((reason: unknown) => {
        if (requestId.current === currentRequest) setDiffError(errorMessage(reason));
      })
      .finally(() => {
        if (requestId.current === currentRequest) setDiffLoading(false);
      });
  }, [projectId, worktreePath]);

  const openDiff = useCallback((path: string, area: DiffArea) => {
    const tab: WipDiffTab = { id: JSON.stringify(["wip", area, path]), path, area, kind: "wip" };
    setTabs((current) => current.some((existing) => existing.id === tab.id) ? current : [...current, tab]);
    setActiveTabId(tab.id);
    loadDiff(tab);
  }, [loadDiff]);

  const openCommitDiff = useCallback((sha: string, path: string) => {
    const tab: CommitDiffTab = {
      id: JSON.stringify(["commit", sha, path]),
      path,
      sha,
      kind: "commit",
    };
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
    if (activeTab?.kind !== "wip") return;
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
            const label = tab.kind === "commit"
              ? t("graph.files.commit")
              : t(tab.area === "staged" ? "graph.files.staged" : "graph.files.unstaged");
            const areaName = tab.kind === "commit" ? `${label} ${tab.sha.slice(0, 7)}` : label;
            return (
              <div className="graph-editor-tab-wrap" key={tab.id}>
                <button
                  aria-selected={activeTabId === tab.id}
                  className={"graph-editor-tab" + (activeTabId === tab.id ? " selected" : "")}
                  onClick={() => activateTab(tab)}
                  role="tab"
                  title={tab.kind === "commit" ? `${tab.path} (${tab.sha})` : tab.path}
                  type="button"
                >
                  {t("graph.diffTab", { path: tab.path, area: areaName })}
                </button>
                <button
                  aria-label={t("graph.closeDiffTab", { path: tab.path, area: areaName.toLowerCase() })}
                  className="graph-editor-tab-close"
                  onClick={() => closeTab(tab)}
                  title={t("graph.closeDiffTab", { path: tab.path, area: areaName.toLowerCase() })}
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
            {diffError && <p className="graph-inline-error" role="alert">{t("graph.diffError", { message: diffError })}</p>}
            {diff && (
              <DiffRenderer
                area={activeTab.kind === "commit" ? "all" : activeTab.area}
                fileName={activeTab.path}
                hunkAreas={activeTab.kind === "wip" ? diff.hunks.map(() => activeTab.area) : undefined}
                key={activeTab.id}
                mode="inline"
                model={diff}
                onOpenFile={activeTab.kind === "wip" ? () => {
                  useFiles.getState().openFile(activeTab.path);
                  useStage.getState().go("files");
                } : undefined}
                onRequestHunkAction={(_hunk, action, hunkIndex) => {
                  if (activeTab.kind !== "wip") return;
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
                onStageSelectedLines={activeTab.kind === "wip" ? () => {
                  void runAction({
                    type: "stage-lines",
                    path: activeTab.path,
                    lineIds: selectedLineIds,
                    area: activeTab.area,
                  });
                } : undefined}
                onToggleLine={activeTab.kind === "wip" ? (_hunk, lineId) => {
                  setSelectedLineIds((current) => current.includes(lineId)
                    ? current.filter((id) => id !== lineId)
                    : [...current, lineId]);
                } : undefined}
                selectedLineIds={selectedLineIds}
              />
            )}
          </div>
        ) : children(openDiff)}
      </div>
      {renderInspector(openDiff, openCommitDiff)}
    </div>
  );
}
