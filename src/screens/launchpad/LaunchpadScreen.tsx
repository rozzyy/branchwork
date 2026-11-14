import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "../../i18n/t";
import { useSessions } from "../../agents/sessions";
import { useGithubAccounts } from "../../github/store";
import {
  ghRateLimitStatus, ghRepoAssignedIssues, ghRepoPulls, ghRepoRemote, ghRepoRuns, ghRepoRerun,
  type RepoIssue, type RepoPull, type RepoRun,
} from "../../ipc/repo";
import { createWorktree, summarizeWorktrees, type Worktree } from "../../ipc/worktrees";
import { errorMessage } from "../../ipc/errors";
import { useRepos, projectsForGroup } from "../../state/repos";
import type { Project } from "../../ipc/catalog";
import { useWorktrees } from "../../state/worktrees";
import { useStage } from "../../state/stage";
import { useDock } from "../../terminal/dock";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/controls";
import { ask } from "../../ui/dialog";
import { toast } from "../../ui/toast";
import { useLaunchpadUi } from "./launchpadUi";
import "./launchpad.css";

const MAX_PROJECTS = 8;
const MAX_WORKTREES_PER_PROJECT = 200;
const ROW_LIMIT = 8;
const MAX_RUNS_PER_PROJECT = 30;
const POLL_MS = 300_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type ProjectData = {
  id: string;
  name: string;
  owner: string | null;
  path: string;
  groupId: string | null;
  remote: { owner: string; repo: string } | null;
  account: string | null;
  worktrees: Worktree[];
  worktreeCount: number;
  pulls: RepoPull[];
  pullTotal: number;
  issues: RepoIssue[];
  runs: RepoRun[];
  error: string | null;
};

function greeting(): string {
  const hour = new Date().getHours();
  return t(hour < 12 ? "launchpad.goodMorning" : hour < 18 ? "launchpad.goodAfternoon" : "launchpad.goodEvening");
}

function formatRunStatus(run: RepoRun): string {
  if (run.status === "queued") return t("repo.runQueued");
  if (run.status === "in_progress") return t("repo.runInProgress");
  if (run.status !== "completed") return t("repo.runUnknown");
  if (run.conclusion === "success") return t("repo.runSuccess");
  if (run.conclusion === "failure") return t("repo.runFailure");
  return run.conclusion ?? run.status;
}

function runFailed(run: RepoRun): boolean {
  return run.status === "completed" && run.conclusion === "failure";
}

function ageLabel(value: string | null): string {
  if (!value) return "";
  const age = Math.max(0, Date.now() - Date.parse(value));
  if (!Number.isFinite(age)) return "";
  if (age < 60_000) return t("launchpad.justNow");
  if (age < 3_600_000) return t("launchpad.minutesAgo", { count: Math.floor(age / 60_000) });
  return t("launchpad.hoursAgo", { count: Math.floor(age / 3_600_000) });
}

function scopeProjects(projects: Project[], groupId: string | null, all: boolean) {
  if (all) return [...projects].sort((a, b) => a.name.localeCompare(b.name));
  return projectsForGroup(projects, groupId);
}

export function LaunchpadToolbar() {
  const allGroups = useLaunchpadUi((state) => state.allGroups);
  const setAllGroups = useLaunchpadUi((state) => state.setAllGroups);
  const requestRefresh = useLaunchpadUi((state) => state.requestRefresh);
  return (
    <>
      <h1 className="pane-title">{t("nav.home")}</h1>
      <div className="launchpad-toolbar-actions pane-actions">
        <Segmented
          label={t("launchpad.scope")}
          value={allGroups ? "all" : "group"}
          onChange={(value) => setAllGroups(value === "all")}
          options={[
            { value: "group", label: t("launchpad.thisGroup") },
            { value: "all", label: t("launchpad.allGroups") },
          ]}
        />
        <Button size="sm" onClick={requestRefresh}>↻ {t("launchpad.refresh")}</Button>
      </div>
    </>
  );
}

/** "＋ New worktree" primary action; lives in the Home greeting row (prototype). */
export function NewWorktreeButton() {
  const activeProjectId = useRepos((state) => state.activeProjectId);
  const creatingWorktree = useLaunchpadUi((state) => state.creatingWorktree);
  const setCreatingWorktree = useLaunchpadUi((state) => state.setCreatingWorktree);
  const requestRefresh = useLaunchpadUi((state) => state.requestRefresh);
  const createNewWorktree = async () => {
    const repoState = useRepos.getState();
    const project = repoState.projects.find((candidate) => candidate.id === repoState.activeProjectId);
    if (!project) return;
    const answer = await ask({
      title: t("launchpad.newWorktreeTitle"),
      input: "",
      placeholder: t("launchpad.newWorktreePlaceholder"),
      icon: "⌂",
    });
    if (typeof answer !== "string") return;
    const branch = answer.trim();
    const parent = project.localPath.slice(0, project.localPath.lastIndexOf("/")) || "/";
    const destination = `${parent}/${branch.replaceAll("/", "-")}`;
    setCreatingWorktree(true);
    try {
      const created = await createWorktree(project.id, destination, branch);
      await useWorktrees.getState().load(project);
      useWorktrees.getState().select(created.path);
      requestRefresh();
      toast({ title: t("launchpad.worktreeCreated", { branch }), icon: "✓" });
    } catch (failure) {
      toast({ title: errorMessage(failure), icon: "⚠" });
    } finally {
      setCreatingWorktree(false);
    }
  };
  return (
    <Button
      variant="primary"
      disabled={!activeProjectId || creatingWorktree}
      title={!activeProjectId ? t("launchpad.noActiveProject") : undefined}
      onClick={() => void createNewWorktree()}
    >
      {creatingWorktree ? <><span className="spin" /> {t("launchpad.creatingWorktree")}</> : <>＋ {t("launchpad.newWorktree")}</>}
    </Button>
  );
}

export function LaunchpadView({ attention }: { attention?: ReactNode } = {}) {
  const projects = useRepos((state) => state.projects);
  const groups = useRepos((state) => state.groups);
  const activeGroupId = useRepos((state) => state.activeGroupId);
  const accountNames = useGithubAccounts((state) => state.accounts);
  const defaultAccount = useGithubAccounts((state) => state.defaultAccount);
  const ownerAccounts = useGithubAccounts((state) => state.ownerAccounts);
  const go = useStage((state) => state.go);
  const allGroups = useLaunchpadUi((state) => state.allGroups);
  const refreshRequest = useLaunchpadUi((state) => state.refreshRequest);
  const [data, setData] = useState<ProjectData[]>([]);
  const [loading, setLoading] = useState(true);
  const [rateLimited, setRateLimited] = useState(false);
  const [limitNote, setLimitNote] = useState(false);
  const [worktreeLimitNote, setWorktreeLimitNote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState<number | null>(null);
  const refreshGeneration = useRef(0);

  const selectedProjects = useMemo(
    () => scopeProjects(projects, activeGroupId, allGroups).slice(0, MAX_PROJECTS),
    [projects, activeGroupId, allGroups],
  );
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const limit = await ghRateLimitStatus().catch(() => null);
      const throttled = !!limit?.limit && limit.remaining != null && limit.remaining < Math.ceil(limit.limit / 10);
      if (generation === refreshGeneration.current) setRateLimited(throttled);
      const local = await Promise.all(selectedProjects.map(async (project) => {
        const [remote, worktreeResult] = await Promise.all([
          ghRepoRemote(project.localPath).catch(() => null),
          summarizeWorktrees(project.id).then((summary) => ({ worktrees: summary.worktrees, total: summary.total, error: null as string | null }))
            .catch((failure: unknown) => ({ worktrees: [] as Worktree[], total: 0, error: errorMessage(failure) })),
        ]);
        return { project, remote, worktrees: worktreeResult.worktrees.slice(0, MAX_WORKTREES_PER_PROJECT),
          worktreeCount: worktreeResult.total, worktreeError: worktreeResult.error };
      }));
      const next: ProjectData[] = [];
      for (const { project, remote, worktrees, worktreeCount, worktreeError } of local) {
        const common: ProjectData = {
          id: project.id, name: project.name, owner: project.owner, path: project.localPath,
          groupId: project.groupId, remote: remote ? { owner: remote.owner, repo: remote.repo } : null,
          account: null, worktrees, worktreeCount, pulls: [], pullTotal: 0, issues: [], runs: [], error: worktreeError,
        };
        if (!remote || throttled || accountNames.length === 0) {
          next.push(common);
          continue;
        }
        const preferred = ownerAccounts[remote.owner.toLowerCase()];
        const account = (preferred && accountNames.includes(preferred) ? preferred : null) ??
          accountNames.find((name) => name.toLowerCase() === remote.owner.toLowerCase()) ??
          (defaultAccount && accountNames.includes(defaultAccount) ? defaultAccount : accountNames[0]);
        try {
          const [pulls, issues, runs] = await Promise.all([
            ghRepoPulls(remote.owner, remote.repo, account, "open"),
            ghRepoAssignedIssues(remote.owner, remote.repo, account),
            ghRepoRuns(remote.owner, remote.repo, account),
          ]);
          next.push({ ...common, account, pulls: pulls.pulls.slice(0, ROW_LIMIT), pullTotal: pulls.total,
            issues: issues.issues.slice(0, ROW_LIMIT), runs: runs.slice(0, MAX_RUNS_PER_PROJECT) });
        } catch (failure) {
          next.push({ ...common, account, error: [common.error, errorMessage(failure)].filter(Boolean).join(" · ") });
        }
      }
      if (generation === refreshGeneration.current) {
        setData(next);
        setLimitNote(scopeProjects(projects, activeGroupId, allGroups).length > MAX_PROJECTS);
        setWorktreeLimitNote(local.some((item) => item.worktreeCount > MAX_WORKTREES_PER_PROJECT));
      }
    } catch (failure) {
      if (generation === refreshGeneration.current) setError(errorMessage(failure));
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [selectedProjects, accountNames, defaultAccount, ownerAccounts, projects, activeGroupId, allGroups]);

  useEffect(() => {
    if (useRepos.getState().status === "idle") void useRepos.getState().load();
    if (!useGithubAccounts.getState().loaded) void useGithubAccounts.getState().load();
    if (!useSessions.getState().loaded) void useSessions.getState().load();
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (refreshRequest > 0) void refresh(); }, [refreshRequest, refresh]);
  useEffect(() => () => { refreshGeneration.current += 1; }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const {
    worktreeCount,
    openPullCount,
    recentRuns,
    completedRecent,
    passedRecent,
    spark,
    issues,
    ciFeed,
  } = useMemo(() => {
    const runs = data.flatMap((project) => project.runs.map((run) => ({ project, run })));
    const now = Date.now();
    const recentRuns = runs.filter(({ run }) => {
      const epoch = run.createdAt ? Date.parse(run.createdAt) : NaN;
      return Number.isFinite(epoch) && epoch <= now && now - epoch <= DAY_MS;
    });
    const completedRecent = recentRuns.filter(({ run }) => run.status === "completed" && run.conclusion != null);
    const passedRecent = completedRecent.filter(({ run }) => run.conclusion === "success").length;
    const spark = Array.from({ length: 6 }, (_, index) => {
      const from = now - DAY_MS + index * (DAY_MS / 6);
      const to = from + DAY_MS / 6;
      return recentRuns.filter(({ run }) => {
        const epoch = run.createdAt ? Date.parse(run.createdAt) : NaN;
        return epoch >= from && epoch < to;
      }).length;
    });
    const issues = data.flatMap((project) => project.issues.map((issue) => ({ project, issue }))).slice(0, 12);
    const ciFeed = [...runs]
      .sort((a, b) => (Date.parse(b.run.createdAt ?? "") || 0) - (Date.parse(a.run.createdAt ?? "") || 0))
      .slice(0, 10);
    return {
      worktreeCount: data.reduce((sum, project) => sum + project.worktreeCount, 0),
      openPullCount: data.reduce((sum, project) => sum + project.pullTotal, 0),
      recentRuns,
      completedRecent,
      passedRecent,
      spark,
      issues,
      ciFeed,
    };
  }, [data]);
  const ensureProject = async (project: ProjectData, path?: string) => {
    const record = projects.find((candidate) => candidate.id === project.id);
    if (!record) return false;
    useRepos.getState().selectProject(project.id);
    await useWorktrees.getState().load(record);
    const wt = useWorktrees.getState();
    if (wt.projectId !== project.id) return false;
    const target = path && wt.worktrees.some((item) => item.path === path) ? path : record.localPath;
    if (wt.worktrees.some((item) => item.path === target)) wt.select(target);
    return true;
  };

  const startIssue = async (project: ProjectData, issue: RepoIssue) => {
    try {
      if (!(await ensureProject(project))) throw new Error(t("launchpad.projectUnavailable"));
      const branch = `fix/issue-${issue.number}`;
      const existing = useWorktrees.getState().worktrees.find((item) => item.branch === branch);
      let target = existing?.path;
      if (!target) {
        const parent = project.path.slice(0, project.path.lastIndexOf("/")) || "/";
        const destination = `${parent}/${branch.replaceAll("/", "-")}`;
        const created = await createWorktree(project.id, destination, branch);
        target = created.path;
        const record = projects.find((candidate) => candidate.id === project.id);
        if (record) await useWorktrees.getState().load(record);
      }
      useWorktrees.getState().select(target);
      await useDock.getState().openHere(target);
      toast({ title: t("repo.worktreeReady", { branch }), detail: t("repo.closesLink", { number: issue.number }), icon: "✓" });
    } catch (failure) {
      toast({ title: errorMessage(failure), icon: "⚠" });
    }
  };

  const assignIssue = async (project: ProjectData, issue: RepoIssue) => {
    try {
      if (!(await ensureProject(project))) throw new Error(t("launchpad.projectUnavailable"));
      useSessions.getState().setNewAgentPrompt(t("launchpad.issuePrompt", {
        title: issue.title,
        repo: `${project.remote?.owner ?? project.owner ?? ""}/${project.remote?.repo ?? project.name}`,
        number: issue.number,
      }));
      go("agents");
      useSessions.getState().setNewAgentOpen(true);
    } catch (failure) {
      toast({ title: errorMessage(failure), icon: "⚠" });
    }
  };

  const scopeLabel = allGroups ? t("launchpad.allGroups") : groups.find((group) => group.id === activeGroupId)?.name ?? t("launchpad.ungrouped");
  const notes = [
    error && <p className="launchpad-error" role="alert" key="error">{error}</p>,
    limitNote && <p className="launchpad-note" role="status" key="limit">{t("launchpad.projectLimit", { count: MAX_PROJECTS })}</p>,
    worktreeLimitNote && <p className="launchpad-note" role="status" key="wt-limit">{t("launchpad.worktreeLimit")}</p>,
    rateLimited && <p className="launchpad-note" role="status" key="rate">{t("launchpad.rateLimited")}</p>,
    ...data.filter((project) => project.error).map((project) => <p className="launchpad-error" role="alert" key={project.id}>{t("launchpad.repoError", { repo: project.name, message: project.error! })}</p>),
  ].filter(Boolean);
  const runTone = (run: RepoRun) => runFailed(run) ? "bad" : run.status === "completed" && run.conclusion === "success" ? "ok" : "warn";
  const runGlyph = (run: RepoRun) => runFailed(run) ? "✕" : run.status === "completed" && run.conclusion === "success" ? "✓" : "●";
  return (
    <main className="home">
      <div className="home-top">
        <div>
          <div className="faint">{t("launchpad.workspaceIn", { group: scopeLabel })}</div>
          <h2>{greeting()}</h2>
        </div>
        <span className="grow" />
        <NewWorktreeButton />
      </div>
      <section className="kpis" aria-label={t("launchpad.kpis")}>
        <article className="panel kpi"><span className="muted">{t("launchpad.openPulls")}</span><b>{loading ? "—" : openPullCount}</b><span className="faint">{t("launchpad.openPullsHint")}</span></article>
        <article className="panel kpi"><span className="muted">{t("launchpad.worktrees")}</span><b>{loading ? "—" : worktreeCount}</b><span className="faint">{t("launchpad.worktreesHint")}</span></article>
        <article className="panel kpi"><span className="muted">{t("launchpad.ciPassRate")}</span><b>{loading || completedRecent.length === 0 ? "—" : `${passedRecent}/${completedRecent.length}`}</b>
          <div className="launchpad-spark" role="img" aria-label={t("launchpad.ciSparkline")}>
            {spark.map((value, index) => <i key={index} style={{ height: `${Math.max(3, Math.min(20, 4 + value * 4))}px` }} />)}
          </div><span className="faint">{t("launchpad.last24h")}</span></article>
      </section>
      {attention}
      {notes.length > 0 && <div className="home-notes">{notes}</div>}
      <div className="cols2">
        <section className="panel" aria-label={t("launchpad.issuesForYou")}><div className="section-h"><h3>{t("launchpad.issuesForYou")}</h3></div>
          {loading ? <p className="launchpad-muted">{t("launchpad.loading")}</p> : issues.length === 0 ? <p className="launchpad-muted">{t("launchpad.noIssues")}</p> :
            issues.map(({ project, issue }) => <div className="list-row" key={`${project.id}:${issue.number}`}>
              <span className="status ok" aria-hidden>●</span>
              <span className="grow" title={`${project.name} · #${issue.number} · ${issue.author}`}>#{issue.number} {issue.title}</span>
              <Button size="sm" onClick={() => void startIssue(project, issue)}>{t("launchpad.start")}</Button>
              <Button size="sm" variant="ghost" onClick={() => void assignIssue(project, issue)}>{t("launchpad.assign")}</Button>
            </div>)}
        </section>
        <section className="panel" aria-label={t("launchpad.ciFeed")}><div className="section-h"><h3>{t("launchpad.ciFeed")}</h3><span className="grow" /><span className="faint">{recentRuns.length}</span></div>
          {loading ? <p className="launchpad-muted">{t("launchpad.loading")}</p> : ciFeed.length === 0 ? <p className="launchpad-muted">{t("launchpad.noRuns")}</p> :
            ciFeed.map(({ project, run }) => <div className="list-row" key={`${project.id}:${run.id}`}>
              <span className={`status ${runTone(run)}`}>{runGlyph(run)} {formatRunStatus(run)}</span>
              <span className="grow">{project.name} · {run.branch} · {run.name}</span>
              <span className="faint">{ageLabel(run.createdAt)}</span>
              {runFailed(run) && project.remote && project.account && <Button size="sm" variant="ghost" disabled={rerunning === run.id} onClick={() => {
                if (rerunning !== null) return;
                void ask({ title: t("repo.rerunTitle"), body: t("repo.rerunBody", { name: run.name, id: run.id, branch: run.branch }), ok: t("repo.rerunOk"), icon: "↻" }).then((answer) => {
                  if (answer !== true) return;
                  setRerunning(run.id);
                  ghRepoRerun(project.remote!.owner, project.remote!.repo, project.account!, run.id)
                    .then(() => { toast({ title: t("repo.rerunStarted"), detail: `${run.name} #${run.id}`, icon: "✓" }); void refresh(); })
                    .catch((failure: unknown) => toast({ title: errorMessage(failure), icon: "⚠" }))
                    .finally(() => setRerunning(null));
                });
              }}>{rerunning === run.id ? t("repo.rerunning") : t("launchpad.ciRerun")}</Button>}
            </div>)}
        </section>
      </div>
      {!loading && selectedProjects.length === 0 && <p className="launchpad-muted">{t("launchpad.noProjects")}</p>}
    </main>
  );
}
