import type { DiffArea } from "../../ipc/diff";
import type { WipSummary } from "../../ipc/graph";
import { t } from "../../i18n/t";

const fileGroupKeys = {
  staged: "graph.files.staged",
  unstaged: "graph.files.unstaged",
  untracked: "graph.files.untracked",
  conflicted: "graph.files.conflicted",
} as const;
type WipFileGroup = keyof typeof fileGroupKeys;
const fileGroupBadges = { staged: "S", unstaged: "M", untracked: "U", conflicted: "C" } as const;

function diffArea(group: WipFileGroup): DiffArea {
  return group === "staged" ? "staged" : "unstaged";
}

export function WipInspector({
  wip,
  onOpenChanges,
  onOpenDiff,
}: {
  wip: WipSummary | null;
  onOpenChanges(): void;
  onOpenDiff(path: string, area: DiffArea): void;
}) {
  const groups = [
    ["staged", wip?.stagedFiles ?? []],
    ["unstaged", wip?.unstagedFiles ?? []],
    ["untracked", wip?.untrackedFiles ?? []],
    ["conflicted", wip?.conflictedFiles ?? []],
  ] as const;
  const count = groups.reduce((total, [, files]) => total + files.length, 0);

  return (
    <div className="graph-inspector-content graph-wip-inspector">
      <div className="graph-wip-meta">
        <span className="graph-chip">{t("graph.wipFileCount", { count })}</span>
        <button className="btn sm primary" onClick={onOpenChanges}>± {t("graph.commitChanges")}</button>
        <span className="graph-chip mono">{wip?.branch ?? t("sidebar.detached")}</span>
      </div>
      <h2 className="graph-commit-heading">{t("graph.wip")}</h2>
      <div className="graph-wip-file-groups">
        {groups.map(([group, files]) => (
          <section key={group} className="graph-file-group">
            <h3>{t(fileGroupKeys[group])} <span>{files.length}</span></h3>
            {files.length ? (
              <ul>{files.map((path) => (
                <li key={`${group}:${path}`} className="graph-wip-file-row">
                  <button
                    aria-label={t("graph.openDiff", { area: t(fileGroupKeys[group]).toLowerCase(), path })}
                    className="graph-wip-file"
                    onClick={() => onOpenDiff(path, diffArea(group))}
                    title={path}
                    type="button"
                  >
                    <span className="graph-status-badge" aria-hidden>{fileGroupBadges[group]}</span>
                    <code>{path}</code>
                  </button>
                </li>
              ))}</ul>
            ) : <p className="graph-muted">{t("graph.noFiles")}</p>}
          </section>
        ))}
      </div>
    </div>
  );
}
