import { useEffect, useState } from "react";
import { readGraphPage, type GraphCommit } from "../../ipc/graph";
import { t } from "../../i18n/t";
import { useRepos } from "../../state/repos";
import { useRebaseUi } from "./rebaseState";
import { useWorktrees } from "../../state/worktrees";
import { graphAncestry } from "../graph/graphUtils";

export function BasePicker({ worktree }: { worktree: string }) {
  const projectId = useRepos((s) => s.activeProjectId);
  const headSha = useWorktrees((s) => s.worktrees.find((w) => w.path === worktree)?.head);
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId || !worktree) { setCommits([]); return; }
    let live = true;
    void readGraphPage(projectId, worktree, 0).then((page) => { if (live) setCommits(page.commits.slice(0, 50)); })
      .catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; };
  }, [projectId, worktree]);
  if (error) return <div role="alert" className="rebase-state">{error}</div>;
  if (!commits.length) return <div className="rebase-state"><p>{t("rebase.loading")}</p></div>;
  const ancestry = graphAncestry(commits, headSha ?? null);
  const ancestors = commits.filter((commit) => commit.sha !== headSha && (!ancestry || ancestry.has(commit.sha))).slice(0, 50);
  return <section className="base-picker" aria-label={t("rebase.pickBase")}><h2>{t("rebase.pickBase")}</h2>
    {ancestors.map((commit) => <button key={commit.sha} className="base-picker-row" aria-label={t("rebase.selectBase", { sha:commit.shortSha, subject:commit.message.split("\n",1)[0] })} onClick={() => useRebaseUi.getState().setBase(worktree, commit.sha)}>
      <span>{commit.message.split("\n",1)[0]}</span><code>{commit.shortSha}</code><small>{new Date(commit.timestamp * 1000).toLocaleDateString()}</small>
    </button>)}
    {ancestors.length === 0 && <p>{t("rebase.noBaseCandidates")}</p>}
  </section>;
}
