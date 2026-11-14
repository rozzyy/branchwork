import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { CLI_REGISTRY } from "../../agents/registry";
import { useSessions } from "../../agents/sessions";
import { useGithubAccounts } from "../../github/store";
import {
  ghRateLimitStatus, ghRepoAssignedIssues, ghRepoPulls, ghRepoRemote, ghRepoRuns, ghRepoRerun,
  openGithubRepoPage, type RepoIssue, type RepoPull, type RepoRun,
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
  const groups = useRepos((state) => state.groups);
  const projects = useRepos((state) => state.projects);
  const activeGroupId = useRepos((state) => state.activeGroupId);
  const activeProjectId = useRepos((state) => state.activeProjectId);
  const allGroups = useLaunchpadUi((state) => state.allGroups);
  const creatingWorktree = useLaunchpadUi((state) => state.creatingWorktree);
  const setAllGroups = useLaunchpadUi((state) => state.setAllGroups);
  const requestRefresh = useLaunchpadUi((state) => state.requestRefresh);
  const setCreatingWorktree = useLaunchpadUi((state) => state.setCreatingWorktree);
  const activeGroupName = groups.find((group) => group.id === activeGroupId)?.name ?? t("launchpad.ungrouped");
  const scopeProjectsCount = allGroups
    ? projects.length
    : scopeProjects(projects, activeGroupId, false).length;

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
    <>
      <h1 className="pane-title">
        {t("nav.home")}
        <span className="launchpad-toolbar-subtitle">{allGroups ? t("launchpad.allGroups") : activeGroupName} · {scopeProjectsCount}</span>
      </h1>
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
        <Button className="launchpad-refresh" variant="ghost" size="sm" aria-label={t("launchpad.refresh")} title={t("launchpad.refresh")} onClick={requestRefresh}>
          ↻
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!activeProjectId || creatingWorktree}
          title={!activeProjectId ? t("launchpad.noActiveProject") : undefined}
          onClick={() => void createNewWorktree()}
        >
          {creatingWorktree ? <><span className="spin" /> {t("launchpad.creatingWorktree")}</> : <>＋ {t("launchpad.newWorktree")}</>}
        </Button>
      </div>
    </>
  );
}

export function LaunchpadView() {
  const projects = useRepos((state) => state.projects);
  const activeGroupId = useRepos((state) => state.activeGroupId);
  const accountNames = useGithubAccounts((state) => state.accounts);
  const defaultAccount = useGithubAccounts((state) => state.defaultAccount);
  const ownerAccounts = useGithubAccounts((state) => state.ownerAccounts);
  const sessions = useSessions((state) => state.sessions);
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
    openPulls,
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
    const openPulls = data.flatMap((project) => project.pulls.map((pull) => ({ project, pull }))).slice(0, 12);
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
      openPulls,
      issues,
      ciFeed,
    };
  }, [data]);
  const scopedAgentCards = useMemo(() => {
    const worktreePaths = new Set<string>();
    for (const project of data) {
      worktreePaths.add(project.path);
      for (const worktree of project.worktrees) worktreePaths.add(worktree.path);
    }
    return sessions
      .filter((session) => ["running", "waiting", "done"].includes(session.status) && worktreePaths.has(session.worktreePath))
      .slice(-8)
      .reverse();
  }, [data, sessions]);

  const safeOpen = (project: ProjectData, page: "pull" | "issues" | "actions", number?: number) => {
    if (!project.remote) return;
    void openGithubRepoPage(project.remote.owner, project.remote.repo, page, number).catch((failure) =>
      toast({ title: errorMessage(failure), icon: "⚠" }));
  };

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

  const focusAgent = async (session: (typeof sessions)[number]) => {
    const project = data.find((item) => item.worktrees.some((worktree) => worktree.path === session.worktreePath));
    if (project) await ensureProject(project, session.worktreePath);
    if (useSessions.getState().sessions.find((candidate) => candidate.id === session.id)?.slot !== "full") {
      useSessions.getState().toggleSlot(session.id, "full");
    }
    go("agents");
  };

  const openHandover = (sessionId: string) => {
    useSessions.getState().setHandoverFor(sessionId);
    go("agents");
  };

  return (
    <main className="launchpad-screen">
      <header className="launchpad-welcome">
        <div><p className="launchpad-eyebrow">{t("launchpad.eyebrow")}</p><h2>{greeting()}</h2>
          <p>{t("launchpad.summary", { projects: selectedProjects.length, worktrees: worktreeCount })}</p></div>
        <section className="launchpad-kpis" aria-label={t("launchpad.kpis")}>
          <article className="launchpad-kpi"><span>{t("launchpad.openPulls")}</span><strong>{loading ? "—" : openPullCount}</strong><small>{t("launchpad.openPullsHint")}</small></article>
          <article className="launchpad-kpi"><span>{t("launchpad.worktrees")}</span><strong>{loading ? "—" : worktreeCount}</strong><small>{t("launchpad.worktreesHint")}</small></article>
          <article className="launchpad-kpi"><span>{t("launchpad.ciPassRate")}</span><strong>{loading || completedRecent.length === 0 ? "—" : `${passedRecent}/${completedRecent.length}`}</strong>
            <div className="launchpad-spark" role="img" aria-label={t("launchpad.ciSparkline")}>
              {spark.map((value, index) => <i key={index} style={{ height: `${Math.max(3, Math.min(20, 4 + value * 4))}px` }} />)}
            </div><small>{t("launchpad.last24h")}</small></article>
        </section>
      </header>
      <div className="launchpad-columns">
        <section className="launchpad-card launchpad-attention"><header><h3>{t("launchpad.attention")}</h3><span>{openPulls.length + issues.length}</span></header>
          {error && <p className="launchpad-error" role="alert">{error}</p>}
          {limitNote && <p className="launchpad-note" role="status">{t("launchpad.projectLimit", { count: MAX_PROJECTS })}</p>}
          {worktreeLimitNote && <p className="launchpad-note" role="status">{t("launchpad.worktreeLimit")}</p>}
          {rateLimited && <p className="launchpad-note" role="status">{t("launchpad.rateLimited")}</p>}
          {data.filter((project) => project.error).map((project) => <p className="launchpad-error" role="alert" key={project.id}>{t("launchpad.repoError", { repo: project.name, message: project.error! })}</p>)}
          <h4>{t("launchpad.openPulls")}</h4>
          {loading ? <p className="launchpad-muted">{t("launchpad.loading")}</p> : openPulls.length === 0 ? <p className="launchpad-muted">{t("launchpad.noPulls")}</p> :
            <div className="launchpad-list">{openPulls.map(({ project, pull }) => <article key={`${project.id}:${pull.number}`}>
              <div className="launchpad-row-main"><strong>{pull.title}</strong><small>{project.name} · #{pull.number} · {pull.author}</small></div>
              <Button size="sm" onClick={() => safeOpen(project, "pull", pull.number)}>{t("launchpad.open")}</Button>
            </article>)}</div>}
          <h4 className="launchpad-subsection-title">{t("launchpad.issuesForYou")}</h4>
          {loading ? <p className="launchpad-muted">{t("launchpad.loading")}</p> : issues.length === 0 ? <p className="launchpad-muted">{t("launchpad.noIssues")}</p> :
            <div className="launchpad-list">{issues.map(({ project, issue }) => <article key={`${project.id}:${issue.number}`}>
              <div className="launchpad-row-main"><strong>{issue.title}</strong><small>{project.name} · #{issue.number} · {issue.author}</small></div>
              <div className="launchpad-row-actions"><Button size="sm" onClick={() => void startIssue(project, issue)}>{t("launchpad.start")}</Button><Button size="sm" variant="ghost" onClick={() => void assignIssue(project, issue)}>{t("launchpad.assign")}</Button></div>
            </article>)}</div>}
        </section>
        <section className="launchpad-card launchpad-agents"><header><h3>{t("launchpad.agents")}</h3><Button size="sm" variant="ghost" onClick={() => go("agents")}>{t("launchpad.openAll")}</Button></header>
          {scopedAgentCards.length === 0 ? <p className="launchpad-muted">{t("launchpad.noAgents")}</p> : <div className="launchpad-list">{scopedAgentCards.map((session) => <article key={session.id}>
            <div className="launchpad-row-main"><strong><i className={`launchpad-agent-dot ${session.status}`} />{CLI_REGISTRY[session.cliId].name}</strong><span className={`launchpad-status ${session.status}`}>{session.status}</span><small>{session.profile.slug} · {session.worktreePath.split("/").filter(Boolean).pop()}</small></div>
            <div className="launchpad-row-actions"><Button size="sm" onClick={() => void focusAgent(session)}>{t("launchpad.openCli")}</Button><Button size="sm" variant="ghost" onClick={() => openHandover(session.id)}>{t("launchpad.handover")}</Button></div>
          </article>)}</div>}
        </section>
        <section className="launchpad-card launchpad-ci"><header><h3>{t("launchpad.ciFeed")}</h3><span>{recentRuns.length}</span></header>
          {loading ? <p className="launchpad-muted">{t("launchpad.loading")}</p> : ciFeed.length === 0 ? <p className="launchpad-muted">{t("launchpad.noRuns")}</p> :
            <div className="launchpad-list">{ciFeed.map(({ project, run }) => <article key={`${project.id}:${run.id}`}>
              <div className="launchpad-row-main"><strong><i className={`launchpad-ci-dot ${run.conclusion ?? run.status}`} />{run.name}</strong><small>{project.name} · {run.branch} · {formatRunStatus(run)} · {ageLabel(run.createdAt)}</small></div>
              {runFailed(run) && project.remote && project.account ? <Button size="sm" variant="ghost" disabled={rerunning === run.id} onClick={() => {
                if (rerunning !== null) return;
                void ask({ title: t("repo.rerunTitle"), body: t("repo.rerunBody", { name: run.name, id: run.id, branch: run.branch }), ok: t("repo.rerunOk"), icon: "↻" }).then((answer) => {
                  if (answer !== true) return;
                  setRerunning(run.id);
                  ghRepoRerun(project.remote!.owner, project.remote!.repo, project.account!, run.id)
                    .then(() => { toast({ title: t("repo.rerunStarted"), detail: `${run.name} #${run.id}`, icon: "✓" }); void refresh(); })
                    .catch((failure: unknown) => toast({ title: errorMessage(failure), icon: "⚠" }))
                    .finally(() => setRerunning(null));
                });
              }}>{rerunning === run.id ? t("repo.rerunning") : t("launchpad.ciRerun")}</Button> : <Button size="sm" variant="ghost" onClick={() => safeOpen(project, "actions")}>{t("launchpad.open")}</Button>}
            </article>)}</div>}
        </section>
      </div>
      {!loading && selectedProjects.length === 0 && <p className="launchpad-muted">{t("launchpad.noProjects")}</p>}
    </main>
  );
}
