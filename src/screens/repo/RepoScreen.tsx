// Repository screen (M4 Task 07): header, Code tab, sidebar.
// Serves the active worktree's GitHub repo as the linked account.
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { useWorktrees } from "../../state/worktrees";
import { useGithubAccounts } from "../../github/store";
import { useStage } from "../../state/stage";
import { useFiles } from "../../state/files";
import { Button } from "../../ui/Button";
import { Menu, type MenuItem } from "../../ui/Menu";
import { FileIcon } from "../../ui/fileIcon";
import { toast } from "../../ui/toast";
import { ask } from "../../ui/dialog";
import { errorMessage } from "../../ipc/errors";
import { MarkdownPreview } from "../../editor/MarkdownPreview";
import {
  ghRepoContributors,
  ghRepoFork,
  ghRepoIssues,
  ghRepoMeta,
  ghRepoPulls,
  ghRepoRemote,
  ghRepoRerun,
  ghRepoRuns,
  ghRepoSetStarred,
  ghRepoSetWatched,
  openGithubRepoPage,
  gitRepoBranches,
  gitRepoLatestCommit,
  gitRepoReadFile,
  gitRepoTree,
  type IssueState,
  type RepoBranches,
  type RepoCommit,
  type RepoContributor,
  type RepoIssue,
  type RepoMeta,
  type RepoPage,
  type RepoPull,
  type RepoRemote,
  type RepoRun,
  type RepoTreeEntry,
} from "../../ipc/repo";
import { createWorktree } from "../../ipc/worktrees";
import { useRepos } from "../../state/repos";
import { useSessions } from "../../agents/sessions";
import { useDock } from "../../terminal/dock";
import { ScreenLoader } from "../../ui/ScreenLoader";
import "./repo.css";

export function RepoToolbar() {
  return <h1 className="pane-title">{t("nav.repo")}</h1>;
}

/** Compact GitHub-style count: 12.4k instead of 12400. */
function formatCount(count: number): string {
  if (count < 1000) return `${count}`;
  const scaled = Math.round(count / 100) / 10;
  return `${scaled}k`;
}

/** Deterministic avatar hue per login; initials stay readable on both themes. */
function avatarColor(login: string): string {
  let hash = 0;
  for (let index = 0; index < login.length; index += 1) {
    hash = (hash * 31 + login.charCodeAt(index)) % 360;
  }
  return `hsl(${hash} 45% 42%)`;
}

/** Short age from a Unix-epoch timestamp, mirroring GraphScreen. */
function repoAge(epoch: number): string {
  if (!epoch) return "";
  const seconds = Math.round(Date.now() / 1000 - epoch);
  const absolute = Math.abs(seconds);
  if (absolute < 60) return t("graph.timeNow");
  const [amount, unit] =
    absolute < 3600
      ? [Math.round(absolute / 60), "minutes"]
      : absolute < 86400
        ? [Math.round(absolute / 3600), "hours"]
        : absolute < 604800
          ? [Math.round(absolute / 86400), "days"]
          : absolute < 2_592_000
            ? [Math.round(absolute / 604_800), "weeks"]
            : absolute < 31_536_000
              ? [Math.round(absolute / 2_592_000), "months"]
              : [Math.round(absolute / 31_536_000), "years"];
  const units: Record<string, string> = {
    minutes: t("graph.timeUnit.minutes"),
    hours: t("graph.timeUnit.hours"),
    days: t("graph.timeUnit.days"),
    weeks: t("graph.timeUnit.weeks"),
    months: t("graph.timeUnit.months"),
    years: t("graph.timeUnit.years"),
  };
  const short = t("graph.timeShort", { amount, unit: units[unit] });
  return seconds >= 0 ? short : `+${short}`;
}

function cloneUrlFor(remote: RepoRemote): string {
  return `https://github.com/${remote.owner}/${remote.repo}.git`;
}

function readmeName(entries: RepoTreeEntry[]): string | null {
  const found = entries.find((entry) => /^readme(\..*)?$/i.test(entry.name));
  return found ? found.name : null;
}

export function RepoView() {
  const activePath = useWorktrees((s) => s.activePath);
  const projectId = useWorktrees((s) => s.projectId);
  const activeProjectId = useRepos((s) => s.activeProjectId);
  const reposLoading = useRepos((s) => s.status === "loading");
  const accounts = useGithubAccounts((s) => s.accounts);
  const defaultAccount = useGithubAccounts((s) => s.defaultAccount);
  const ownerAccounts = useGithubAccounts((s) => s.ownerAccounts);
  const setAccountForOwner = useGithubAccounts((s) => s.setAccountForOwner);
  const worktrees = useWorktrees((s) => s.worktrees);
  const worktreesLoading = useWorktrees((s) => s.loading);
  const sessions = useSessions((s) => s.sessions);
  const accountsLoaded = useGithubAccounts((s) => s.loaded);
  const projects = useRepos((s) => s.projects);
  const groups = useRepos((s) => s.groups);
  const project = projects.find((item) => item.id === projectId);
  const projectGroup = groups.find((group) => group.id === project?.groupId);
  const [remote, setRemote] = useState<RepoRemote | null | "missing">(null);
  const [meta, setMeta] = useState<RepoMeta | null>(null);
  const [contributors, setContributors] = useState<RepoContributor[] | null>(null);
  const [branches, setBranches] = useState<RepoBranches | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const [subdir, setSubdir] = useState("");
  const [entries, setEntries] = useState<RepoTreeEntry[] | null>(null);
  const [commit, setCommit] = useState<RepoCommit | null>(null);
  const [codeNote, setCodeNote] = useState<string | null>(null);
  const [readme, setReadme] = useState<string | null | "missing">(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState<"code" | "issues" | "pulls" | "actions">("code");
  const [accountMenu, setAccountMenu] = useState<{ x: number; y: number } | null>(null);
  const [issues, setIssues] = useState<{ total: number; rows: RepoIssue[] } | null>(null);
  const [issueTotals, setIssueTotals] = useState<{ open: number; closed: number } | null>(null);
  const [issueFilter, setIssueFilter] = useState<IssueState>("open");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [starting, setStarting] = useState<number | null>(null);
  const [runs, setRuns] = useState<RepoRun[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runsTick, setRunsTick] = useState(0);
  const [rerunning, setRerunning] = useState<number | null>(null);
  const [pullFilter, setPullFilter] = useState<IssueState>("open");
  const [pullLists, setPullLists] = useState<Record<IssueState, { total: number; pulls: RepoPull[] }> | null>(null);
  const [pullsError, setPullsError] = useState<string | null>(null);

  useEffect(() => {
    if (accountsLoaded) return;
    void useGithubAccounts.getState().load();
  }, [accountsLoaded]);

  // Remote of the active worktree.
  useEffect(() => {
    if (!activePath) {
      setRemote("missing");
      return;
    }
    let live = true;
    setRemote(null);
    ghRepoRemote(activePath)
      .then((found) => {
        if (live) setRemote(found);
      })
      .catch(() => {
        if (live) setRemote("missing");
      });
    return () => {
      live = false;
    };
  }, [activePath]);

  // Org owners match no username, so the stored per-owner choice wins
  // over the username match and default fallback (multi-account setups).
  const remembered =
    remote && remote !== "missing" ? (ownerAccounts[remote.owner.toLowerCase()] ?? null) : null;
  const account =
    remote && remote !== "missing"
      ? (remembered && accounts.includes(remembered)
          ? remembered
          : (accounts.find((name) => name.toLowerCase() === remote.owner.toLowerCase()) ??
            (defaultAccount && accounts.includes(defaultAccount)
              ? defaultAccount
              : (accounts[0] ?? null))))
      : null;
  const repoKey = remote && remote !== "missing" ? `${remote.owner}/${remote.repo}` : "";
  const selectionRef = useRef({ repoKey, account, activePath });
  selectionRef.current = { repoKey, account, activePath };

  // Overview, contributors, branches for the remote + account.
  useEffect(() => {
    if (!remote || remote === "missing" || !account || !activePath) return;
    let live = true;
    setError(null);
    setMeta(null);
    setContributors(null);
    setBranches(null);
    const { owner, repo } = remote;
    void Promise.all([
      ghRepoMeta(owner, repo, account),
      ghRepoContributors(owner, repo, account).catch(() => [] as RepoContributor[]),
      gitRepoBranches(activePath),
    ])
      .then(([loadedMeta, loadedContributors, loadedBranches]) => {
        if (!live) return;
        setMeta(loadedMeta);
        setContributors(loadedContributors);
        setBranches(loadedBranches);
        setRef((current) => {
          if (current && loadedBranches.branches.includes(current)) return current;
          return (
            loadedMeta.defaultBranch ||
            loadedBranches.current ||
            loadedBranches.branches[0] ||
            null
          );
        });
      })
      .catch((failure: unknown) => {
        if (live) setError(errorMessage(failure));
      });
    return () => {
      live = false;
    };
  }, [repoKey, account, activePath, reload]);

  // Workflow runs for the Actions tab.
  useEffect(() => {
    if (!remote || remote === "missing" || !account || tab !== "actions") return;
    let live = true;
    setRuns(null);
    setRunsError(null);
    ghRepoRuns(remote.owner, remote.repo, account)
      .then((loaded) => {
        if (live) setRuns(loaded);
      })
      .catch((failure: unknown) => {
        if (live) setRunsError(errorMessage(failure));
      });
    return () => {
      live = false;
    };
  }, [repoKey, account, tab, reload, runsTick]);

  // File table + latest commit for the viewed ref and subdir.
  useEffect(() => {
    if (!remote || remote === "missing" || !ref || !activePath) return;
    let live = true;
    setEntries(null);
    setCommit(null);
    setCodeNote(null);
    void Promise.all([
      gitRepoTree(activePath, ref, subdir),
      gitRepoLatestCommit(activePath, ref).catch(() => null),
    ])
      .then(([loadedEntries, loadedCommit]) => {
        if (!live) return;
        setEntries(loadedEntries);
        setCommit(loadedCommit);
        if (!loadedCommit) setCodeNote(t("repo.noCommits"));
      })
      .catch((failure: unknown) => {
        if (live) {
          setEntries([]);
          setCodeNote(errorMessage(failure));
        }
      });
    return () => {
      live = false;
    };
  }, [repoKey, ref, subdir, activePath, reload]);

  // Open/closed totals for the Issues header, independent of the filter.
  useEffect(() => {
    if (!remote || remote === "missing" || !account || tab !== "issues") return;
    let live = true;
    setIssueTotals(null);
    for (const state of ["open", "closed"] as const) {
      ghRepoIssues(remote.owner, remote.repo, account, state)
        .then((list) => {
          if (live) {
            setIssueTotals((current) => {
              const next = { open: current?.open ?? 0, closed: current?.closed ?? 0 };
              next[state] = list.total;
              return next;
            });
          }
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [repoKey, account, tab, reload]);

  // Issues for the Issues tab, reloaded with the tab and its filters.
  useEffect(() => {
    if (!remote || remote === "missing" || !account || tab !== "issues") return;
    let live = true;
    setIssues(null);
    setIssuesError(null);
    ghRepoIssues(remote.owner, remote.repo, account, issueFilter)
      .then((loaded) => {
        if (live) {
          setIssues({ total: loaded.total, rows: loaded.issues });
          setLabelFilter((current) =>
            current &&
            loaded.issues.some((issue) => issue.labels.some((label) => label.name === current))
              ? current
              : null,
          );
        }
      })
      .catch((failure: unknown) => {
        if (live) setIssuesError(errorMessage(failure));
      });
    return () => {
      live = false;
    };
  }, [repoKey, account, tab, issueFilter, reload]);

  // The repository menu shows both pull-request counts and the selected list.
  useEffect(() => {
    if (!remote || remote === "missing" || !account || tab !== "pulls") return;
    let live = true;
    setPullLists(null);
    setPullsError(null);
    Promise.all([
      ghRepoPulls(remote.owner, remote.repo, account, "open"),
      ghRepoPulls(remote.owner, remote.repo, account, "closed"),
    ])
      .then(([open, closed]) => {
        if (live) {
          setPullLists({
            open: { total: open.total, pulls: open.pulls },
            closed: { total: closed.total, pulls: closed.pulls },
          });
        }
      })
      .catch((failure: unknown) => {
        if (live) setPullsError(errorMessage(failure));
      });
    return () => {
      live = false;
    };
  }, [repoKey, account, tab, reload]);

  // README of the viewed root, rendered below the file table.
  useEffect(() => {
    if (!activePath || !ref || subdir !== "" || !entries) return;
    const name = readmeName(entries);
    if (!name) {
      setReadme("missing");
      return;
    }
    let live = true;
    setReadme(null);
    gitRepoReadFile(activePath, ref, name)
      .then((bytes) => {
        if (live) setReadme(new TextDecoder().decode(new Uint8Array(bytes)));
      })
      .catch(() => {
        if (live) setReadme("missing");
      });
    return () => {
      live = false;
    };
  }, [activePath, ref, subdir, entries]);

  const worktreePending =
    reposLoading ||
    worktreesLoading ||
    (activeProjectId !== null && projectId !== activeProjectId);
  if (!activePath && worktreePending) {
    return <ScreenLoader>{t("repo.loading")}</ScreenLoader>;
  }

  if (!activePath || remote === "missing") {
    return (
      <div className="placeholder">
        <div className="placeholder-icon" aria-hidden>
          ◫
        </div>
        <p>{t("repo.noRepo")}</p>
      </div>
    );
  }

  if (!remote) {
    return <ScreenLoader>{t("repo.loading")}</ScreenLoader>;
  }

  if (!accountsLoaded) {
    return <ScreenLoader>{t("repo.loading")}</ScreenLoader>;
  }

  if (!account) {
    return (
      <div className="placeholder">
        <div className="placeholder-icon" aria-hidden>
          ◫
        </div>
        <p>{t("repo.noAccount")}</p>
        <Button size="sm" onClick={() => useStage.getState().go("settings")}>
          {t("repo.connectAccount")}
        </Button>
      </div>
    );
  }

  const openInFiles = (relPath: string) => {
    useFiles.getState().openFile(relPath);
    useStage.getState().go("files");
  };

  const copyCloneUrl = () => {
    void navigator.clipboard
      .writeText(cloneUrlFor(remote))
      .then(() => toast({ title: t("repo.cloned"), icon: "✓" }))
      .catch((reason: unknown) =>
        toast({
          title: t("repo.copyFailed"),
          detail: reason instanceof Error ? reason.message : String(reason),
          icon: "⚠",
        }),
      );
  };

  const toggleStar = () => {
    if (!meta || acting) return;
    setActing("star");
    ghRepoSetStarred(remote.owner, remote.repo, account, !meta.viewerStarred)
      .then((starred) => {
        if (selectionRef.current.repoKey !== repoKey || selectionRef.current.account !== account) return;
        setMeta({
          ...meta,
          viewerStarred: starred,
          stars: Math.max(0, meta.stars + (starred ? 1 : -1)),
        });
      })
      .catch((failure: unknown) => toast({ title: errorMessage(failure), icon: "⚠" }))
      .finally(() => setActing(null));
  };

  const toggleWatch = () => {
    if (!meta || acting) return;
    const watch = meta.viewerSubscription !== "SUBSCRIBED";
    setActing("watch");
    ghRepoSetWatched(remote.owner, remote.repo, account, watch)
      .then((subscription) => {
        if (selectionRef.current.repoKey !== repoKey || selectionRef.current.account !== account) return;
        setMeta({
          ...meta,
          viewerSubscription: subscription,
          watchers: Math.max(0, meta.watchers + (subscription === "SUBSCRIBED" ? 1 : -1)),
        });
      })
      .catch((failure: unknown) => toast({ title: errorMessage(failure), icon: "⚠" }))
      .finally(() => setActing(null));
  };

  const forkRepo = () => {
    if (acting) return;
    void ask({
      title: t("repo.forkTitle"),
      body: t("repo.forkBody", { repo: repoKey, account }),
      ok: t("repo.forkOk"),
      icon: "⑂",
    }).then((answer) => {
      if (answer !== true) return;
      setActing("fork");
      ghRepoFork(remote.owner, remote.repo, account)
        .then((url) => toast({ title: t("repo.forked"), detail: url, icon: "⑂" }))
        .catch((failure: unknown) => toast({ title: errorMessage(failure), icon: "⚠" }))
        .finally(() => setActing(null));
    });
  };

  const watching = meta?.viewerSubscription === "SUBSCRIBED";
  const accountMenuItems: MenuItem[] = accounts.map((name) => ({
    kind: "item",
    label: name,
    icon: name === account ? "✓" : undefined,
    onSelect: () => setAccountForOwner(remote.owner, name),
  }));
  const openRepoPage = (page: RepoPage, pullNumber?: number) => {
    const opening =
      pullNumber === undefined
        ? openGithubRepoPage(remote.owner, remote.repo, page)
        : openGithubRepoPage(remote.owner, remote.repo, page, pullNumber);
    void opening.catch((failure: unknown) => toast({ title: errorMessage(failure), icon: "⚠" }));
  };

  const runFailed = (run: RepoRun) =>
    run.status === "completed" && run.conclusion === "failure";

  type RunTone = "pending" | "success" | "failure" | "neutral";
  const runTone = (run: RepoRun): { tone: RunTone; label: string } => {
    if (run.status === "queued") {
      return {
        tone: "pending",
        label: t("repo.runQueued"),
      };
    }
    if (run.status === "in_progress") {
      return { tone: "pending", label: t("repo.runInProgress") };
    }
    if (run.status !== "completed") {
      return { tone: "neutral", label: t("repo.runUnknown") };
    }
    if (run.conclusion === "success") return { tone: "success", label: t("repo.runSuccess") };
    if (runFailed(run)) return { tone: "failure", label: t("repo.runFailure") };
    return { tone: "neutral", label: run.conclusion ?? run.status };
  };

  const rerunRun = (run: RepoRun) => {
    // Reachable only past the loaded-remote guards above, so remote is set.
    if (!account || rerunning !== null) return;
    void ask({
      title: t("repo.rerunTitle"),
      body: t("repo.rerunBody", { name: run.name, id: run.id, branch: run.branch }),
      ok: t("repo.rerunOk"),
      icon: "↻",
    }).then((answer) => {
      if (answer !== true) return;
      setRerunning(run.id);
      ghRepoRerun(remote.owner, remote.repo, account, run.id)
        .then(() => {
          toast({ title: t("repo.rerunStarted"), detail: `${run.name} #${run.id}`, icon: "✓" });
          setRunsTick((n) => n + 1);
        })
        .catch((failure: unknown) => toast({ title: errorMessage(failure), icon: "⚠" }))
        .finally(() => setRerunning(null));
    });
  };

  const branchFor = (issueNumber: number) => `fix/issue-${issueNumber}`;
  const linkedWorktreeFor = (issueNumber: number) =>
    worktrees.find((worktree) => worktree.branch === branchFor(issueNumber)) ?? null;
  const hasLiveAgent = (worktreePath: string | undefined) =>
    !!worktreePath &&
    sessions.some(
      (session) =>
        session.worktreePath === worktreePath &&
        (session.status === "running" || session.status === "waiting"),
    );

  const startIssue = (issue: RepoIssue) => {
    // Reachable only past the loaded-remote guards above, so remote is set.
    if (!account || starting !== null) return;
    const branch = branchFor(issue.number);
    const linked = linkedWorktreeFor(issue.number);
    const openTerminalHere = async (path: string) => {
      const wtState = useWorktrees.getState();
      wtState.select(path);
      await useDock.getState().openHere(path);
    };
    if (linked) {
      setStarting(issue.number);
      void openTerminalHere(linked.path)
        .catch((failure: unknown) => toast({ title: errorMessage(failure), icon: "⚠" }))
        .finally(() => setStarting(null));
      return;
    }
    const wtState = useWorktrees.getState();
    const projectId = wtState.projectId;
    const project = useRepos.getState().projects.find((candidate) => candidate.id === projectId);
    if (!projectId || !project) {
      toast({ title: t("repo.noProject"), icon: "⚠" });
      return;
    }
    setStarting(issue.number);
    const parent = project.localPath.slice(0, project.localPath.lastIndexOf("/")) || "/";
    const destination = `${parent}/${branch.replaceAll("/", "-")}`;
    void createWorktree(projectId, destination, branch)
      .then(async (created) => {
        await wtState.load(project).catch(() => undefined);
        wtState.select(created.path);
        await openTerminalHere(created.path);
        toast({
          title: t("repo.worktreeReady", { branch }),
          detail: `${t("repo.closesLink", { number: issue.number })} · ${issue.url}`,
          icon: "✓",
        });
      })
      .catch((failure: unknown) => toast({ title: errorMessage(failure), icon: "⚠" }))
      .finally(() => setStarting(null));
  };
  const visibleEntries = (entries ?? []).filter((entry) =>
    entry.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const allLabels = Array.from(
    new Set((issues?.rows ?? []).flatMap((issue) => issue.labels.map((label) => label.name))),
  ).sort();
  const visibleIssues = (issues?.rows ?? []).filter(
    (issue) => !labelFilter || issue.labels.some((label) => label.name === labelFilter),
  );
  const crumbs = subdir === "" ? [] : subdir.split("/");

  const openFirstMatch = () => {
    const first = visibleEntries[0];
    if (!first) return;
    const rel = subdir === "" ? first.name : `${subdir}/${first.name}`;
    if (first.kind === "dir") setSubdir(rel);
    else openInFiles(rel);
  };

  const totalLang = (meta?.languages ?? []).reduce((sum, lang) => sum + lang.size, 0);
  const selectedPulls = pullLists?.[pullFilter];

  return (
    <div className="repo">
      <header className="repo-head">
        <div>
          <h2 className="repo-title mono">
            <span className="repo-owner">{remote.owner}</span>
            <span className="repo-slash" aria-hidden="true">
              /
            </span>
            <span className="repo-name">{remote.repo}</span>
            {meta ? (
              <span className="chip repo-visibility">
                {meta.isPrivate ? t("repo.private") : t("repo.public")}
              </span>
            ) : null}
            {projectGroup && (
              <span className="chip repo-group-chip">
                <span
                  className="repo-group-mark"
                  aria-hidden="true"
                  style={{ backgroundColor: projectGroup.color }}
                />
                {projectGroup.name}
              </span>
            )}
          </h2>
          {meta?.description && <p className="repo-desc">{meta.description}</p>}
        </div>
        <div className="repo-actions">
          {accounts.length > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              className="repo-account"
              aria-label={t("repo.accountSwitcher", { account })}
              aria-haspopup="menu"
              aria-expanded={accountMenu !== null}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setAccountMenu({ x: rect.left, y: rect.bottom + 4 });
              }}
            >
              <span
                className="repo-account-avatar"
                aria-hidden="true"
                style={{ backgroundColor: avatarColor(account) }}
              >
                {account[0]?.toUpperCase() ?? "?"}
              </span>
              <span className="repo-account-name">{account}</span>
              <span aria-hidden="true">⌄</span>
            </Button>
          ) : (
            <span className="chip repo-account" title={account}>
              <span
                className="repo-account-avatar"
                aria-hidden="true"
                style={{ backgroundColor: avatarColor(account) }}
              >
                {account[0]?.toUpperCase() ?? "?"}
              </span>
              <span className="repo-account-name">{account}</span>
            </span>
          )}
          {accountMenu && (
            <Menu
              x={accountMenu.x}
              y={accountMenu.y}
              width={220}
              onClose={() => setAccountMenu(null)}
              items={[{ kind: "header", label: t("repo.account") }, ...accountMenuItems]}
            />
          )}
          <span className="repo-actions-divider" aria-hidden="true" />
          <Button
            size="sm"
            variant={meta?.viewerStarred ? undefined : "ghost"}
            disabled={!meta || acting !== null}
            aria-pressed={meta?.viewerStarred ?? false}
            onClick={toggleStar}
          >
            <span aria-hidden="true">{meta?.viewerStarred ? "★" : "☆"}</span>
            {meta?.viewerStarred ? t("repo.unstar") : t("repo.star")}
            <span className="repo-action-count">{meta ? formatCount(meta.stars) : "…"}</span>
          </Button>
          <Button
            size="sm"
            variant={watching ? undefined : "ghost"}
            disabled={!meta || acting !== null}
            aria-pressed={watching}
            onClick={toggleWatch}
          >
            <span aria-hidden="true">◉</span>
            {watching ? t("repo.unwatch") : t("repo.watch")}
            <span className="repo-action-count">{meta ? formatCount(meta.watchers) : "…"}</span>
          </Button>
          <Button size="sm" variant="ghost" disabled={!meta || acting !== null} onClick={forkRepo}>
            <span aria-hidden="true">⑂</span>
            {t("repo.fork")}
            <span className="repo-action-count">{meta ? formatCount(meta.forks) : "…"}</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="repo-refresh"
            disabled={!activePath || acting !== null}
            onClick={() => {
              if (!activePath) return;
              const requestedPath = activePath;
              setActing("refresh");
              setError(null);
              ghRepoRemote(requestedPath)
                .then((found) => {
                  if (selectionRef.current.activePath !== requestedPath) return;
                  setRemote(found);
                  setReload((n) => n + 1);
                })
                .catch((failure: unknown) => {
                  if (selectionRef.current.activePath === requestedPath) {
                    setError(errorMessage(failure));
                  }
                })
                .finally(() => setActing(null));
            }}
          >
            <span aria-hidden="true">↻</span>
            {t("repo.refresh")}
          </Button>
        </div>
      </header>

      {error && <p className="repo-status">{error}</p>}
      <nav className="repo-tabs" aria-label={t("repo.sections")}>
        <button
          type="button"
          aria-current={tab === "code" ? "page" : undefined}
          className={tab === "code" ? "repo-tab on" : "repo-tab"}
          onClick={() => setTab("code")}
        >
          <span aria-hidden="true">‹› </span>
          {t("repo.codeTab")}
        </button>
        <button
          type="button"
          aria-current={tab === "issues" ? "page" : undefined}
          className={tab === "issues" ? "repo-tab on" : "repo-tab"}
          onClick={() => setTab("issues")}
        >
          <span aria-hidden="true">◉ </span>
          {t("repo.issuesTab")}{" "}
          {issues !== null && (
            <span className="repo-count">{formatCount(issues.total)}</span>
          )}
        </button>
        <button
          type="button"
          aria-current={tab === "pulls" ? "page" : undefined}
          className={tab === "pulls" ? "repo-tab on" : "repo-tab"}
          onClick={() => setTab("pulls")}
        >
          <span aria-hidden="true">⇄ </span>
          {t("repo.pullsTab")}{" "}
          {pullLists && (
            <span className="repo-count">
              {formatCount(pullLists.open.total + pullLists.closed.total)}
            </span>
          )}
        </button>
        <button
          type="button"
          aria-current={tab === "actions" ? "page" : undefined}
          className={tab === "actions" ? "repo-tab on" : "repo-tab"}
          onClick={() => setTab("actions")}
        >
          <span aria-hidden="true">▶ </span>
          {t("repo.actionsTab")}
        </button>
      </nav>
      {tab === "code" ? (
        !meta || !branches ? (
        !error && (
          <span className="repo-status" role="status">
            <span className="spin" aria-hidden="true" />
          </span>
        )
      ) : (
        <div className="repo-body">
          <section className="repo-code">
            <div className="repo-bar">
              <select
                className="input"
                aria-label={t("repo.branch")}
                value={ref ?? ""}
                onChange={(e) => {
                  setRef(e.target.value || null);
                  setSubdir("");
                  setFilter("");
                }}
              >
                {(branches.branches.includes(ref ?? "")
                  ? branches.branches
                  : [...branches.branches, ...(ref ? [ref] : [])]
                ).map((name) => (
                  <option key={name} value={name}>
                    {name}
                    {meta.defaultBranch === name ? " ★" : ""}
                  </option>
                ))}
              </select>
              <span className="repo-hint">
                {t("repo.branchCounts", {
                  branches: branches.branches.length,
                  tags: branches.tagCount,
                })}
              </span>
              <span className="repo-sp" />
              <input
                className="input repo-filter"
                placeholder={t("repo.goToFile")}
                aria-label={t("repo.goToFile")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") openFirstMatch();
                }}
              />
              <Button size="sm" variant="ghost" onClick={copyCloneUrl}>
                {t("repo.cloneUrl")}
              </Button>
            </div>

            {crumbs.length > 0 && (
              <div className="repo-crumbs">
                <button type="button" className="repo-crumb" onClick={() => setSubdir("")}>
                  {t("repo.backToRoot")}
                </button>
                {crumbs.map((part, index) => (
                  <span key={crumbs.slice(0, index + 1).join("/")}>
                    <span aria-hidden> / </span>
                    <button
                      type="button"
                      className="repo-crumb"
                      onClick={() => setSubdir(crumbs.slice(0, index + 1).join("/"))}
                    >
                      {part}
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="repo-box">
              <div className="repo-boxhd">
                {commit ? (
                  <>
                    <span
                      className="chip repo-avatar repo-avatar-inline"
                      aria-hidden="true"
                      style={{ backgroundColor: avatarColor(commit.author) }}
                    >
                      {(commit.author[0] ?? "?").toUpperCase()}
                    </span>
                    <b>{commit.author}</b>
                    <span className="repo-commitmsg">{commit.message}</span>
                    <span className="repo-hint mono">
                      {commit.hash.slice(0, 7)} · {repoAge(commit.epoch)}
                    </span>
                  </>
                ) : codeNote ? (
                  <span className="repo-hint">{codeNote}</span>
                ) : (
                  <span className="repo-status" role="status">
                    <span className="spin" aria-hidden="true" />
                  </span>
                )}
              </div>
              {entries === null ? (
                <span className="repo-status repo-boxempty" role="status">
                  <span className="spin" aria-hidden="true" />
                </span>
              ) : visibleEntries.length === 0 ? (
                <p className="repo-hint repo-boxempty">{t("repo.emptyTree")}</p>
              ) : (
                <ul className="repo-boxlist">
                  {visibleEntries.map((entry) => {
                    const rel = subdir === "" ? entry.name : `${subdir}/${entry.name}`;
                    const isDir = entry.kind === "dir";
                    return (
                      <li key={rel}>
                        <button
                          type="button"
                          className="repo-row"
                          onClick={() => (isDir ? setSubdir(rel) : openInFiles(rel))}
                          aria-label={`${rel} ${entry.message}`.trim()}
                        >
                          <FileIcon path={entry.name} />
                          <span className="repo-rowname">{entry.name}</span>
                          <span className="repo-rowmsg">{entry.message}</span>
                          <span className="repo-hint">{repoAge(entry.epoch)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {subdir === "" && readme !== "missing" && (
              <section className="repo-box">
                <div className="repo-boxhd">
                  <b>▤ {t("repo.readme")}</b>
                  {meta.license && <span className="repo-hint">⚖ {meta.license}</span>}
                </div>
                <div className="repo-md">
                  {readme === null ? (
                    <span className="repo-status repo-boxempty" role="status">
                      <span className="spin" aria-hidden="true" />
                    </span>
                  ) : (
                    <MarkdownPreview content={readme} />
                  )}
                </div>
              </section>
            )}
          </section>

          <aside className="repo-side">
            <section>
              <div className="repo-h4">{t("repo.about")}</div>
              {meta.homepageUrl && <div className="repo-stat">{meta.homepageUrl}</div>}
              {meta.topics.length > 0 && (
                <div className="repo-topics">
                  {meta.topics.map((topic) => (
                    <span key={topic} className="chip">
                      {topic}
                    </span>
                  ))}
                </div>
              )}
              {meta.license && <span className="chip">{meta.license}</span>}
              <div className="repo-stat">
                <span aria-hidden="true">☆</span>{" "}
                {t("repo.starsCount", { count: formatCount(meta.stars) })}
              </div>
              <div className="repo-stat">
                <span aria-hidden="true">◉</span>{" "}
                {t("repo.watchingCount", { count: formatCount(meta.watchers) })}
              </div>
              <div className="repo-stat">
                <span aria-hidden="true">⑂</span>{" "}
                {t("repo.forksCount", { count: formatCount(meta.forks) })}
              </div>
            </section>
            {meta.releases.length > 0 && (
              <section>
                <div className="repo-h4">
                  {t("repo.releases")} <span className="chip repo-count">{meta.releases.length}</span>
                </div>
                <ul className="repo-plain">
                  {meta.releases.map((release) => (
                    <li key={release.tag}>
                      <span className="mono">{release.name ?? release.tag}</span>
                      {release.isLatest && (
                        <span className="chip repo-pill-latest">{t("repo.latest")}</span>
                      )}
                      {release.draft && <span className="chip">{t("repo.draft")}</span>}
                      {release.publishedAt && (
                        <span className="repo-hint">
                          {" "}
                          · {repoAge(Math.round(Date.parse(release.publishedAt) / 1000))}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {contributors && contributors.length > 0 && (
              <section>
                <div className="repo-h4">
                  {t("repo.contributors")}{" "}
                  <span className="chip repo-count">{contributors.length}</span>
                </div>
                <ul className="repo-plain">
                  {contributors.map((person) => (
                    <li key={person.login} className="repo-person">
                      <span
                        className="chip repo-avatar"
                        aria-hidden
                        style={{ backgroundColor: avatarColor(person.login) }}
                      >
                        {(person.login[0] ?? "?").toUpperCase()}
                      </span>
                      <span>{person.login}</span>
                      <span className="repo-hint">
                        {t("repo.contributions", { count: person.contributions })}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {meta.languages.length > 0 && totalLang > 0 && (
              <section>
                <div className="repo-h4">{t("repo.languages")}</div>
                <div
                  className="repo-langbar"
                  role="img"
                  aria-label={meta.languages.map((lang) => lang.name).join(", ")}
                >
                  {meta.languages.map((lang) => (
                    <span
                      key={lang.name}
                      title={`${lang.name} ${Math.round((lang.size / totalLang) * 100)}%`}
                      style={{
                        width: `${(lang.size / totalLang) * 100}%`,
                        backgroundColor: lang.color ?? "var(--fg3)",
                      }}
                    />
                  ))}
                </div>
                <ul className="repo-plain">
                  {meta.languages.map((lang) => (
                    <li key={lang.name}>
                      <span
                        className="repo-dot"
                        aria-hidden
                        style={{ backgroundColor: lang.color ?? "var(--fg3)" }}
                      />
                      {lang.name}{" "}
                      <span className="repo-hint">
                        {Math.round((lang.size / totalLang) * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>
        )
      ) : tab === "issues" ? (
        <section className="repo-issues">
          {allLabels.length > 0 && (
            <div className="repo-bar">
              <select
                className="input"
                aria-label={t("repo.labelFilter")}
                value={labelFilter ?? ""}
                onChange={(e) => setLabelFilter(e.target.value || null)}
              >
                <option value="">{t("repo.labelAll")}</option>
                {allLabels.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {issuesError && <p className="repo-status">{issuesError}</p>}
          {issues === null && issueTotals === null ? (
            !issuesError && (
              <span className="repo-status" role="status">
                <span className="spin" aria-hidden="true" />
              </span>
            )
          ) : (
            <div className="repo-box">
              <div className="repo-boxhd">
                <button
                  type="button"
                  className={issueFilter === "open" ? "repo-htotal on" : "repo-htotal"}
                  aria-pressed={issueFilter === "open"}
                  onClick={() => setIssueFilter("open")}
                >
                  <span aria-hidden="true">◉</span>{" "}
                  {issueTotals === null ? "…" : formatCount(issueTotals.open)}{" "}
                  {t("repo.filterOpen")}
                </button>
                <button
                  type="button"
                  className={issueFilter === "closed" ? "repo-htotal on" : "repo-htotal"}
                  aria-pressed={issueFilter === "closed"}
                  onClick={() => setIssueFilter("closed")}
                >
                  <span aria-hidden="true">✓</span>{" "}
                  {issueTotals === null ? "…" : formatCount(issueTotals.closed)}{" "}
                  {t("repo.filterClosed")}
                </button>
              </div>
              {issues !== null && visibleIssues.length === 0 ? (
                <p className="repo-hint repo-boxempty">{t("repo.emptyIssues")}</p>
              ) : (
                issues !== null && (
                  <ul className="repo-boxlist">
                    {visibleIssues.map((issue) => {
                      const linked = linkedWorktreeFor(issue.number);
                      const live = hasLiveAgent(linked?.path);
                      const busy = starting === issue.number;
                      return (
                        <li key={issue.number}>
                          <div className="repo-row repo-issuerow">
                            <span
                              aria-hidden="true"
                              className={
                                issueFilter === "open" ? "repo-issue-open" : "repo-issue-closed"
                              }
                            >
                              {issueFilter === "open" ? "◉" : "✓"}
                            </span>
                            <span className="mono">#{issue.number}</span>
                                  <div className="repo-issuemain">
                              <span className="repo-rowname">{issue.title}</span>
                              <span className="repo-rowmsg">
                                {issue.author}
                                {issue.updatedAt &&
                                  ` · ${repoAge(Math.round(Date.parse(issue.updatedAt) / 1000))}`}
                                {issue.comments > 0 &&
                                  ` · ${t("repo.comments", { count: issue.comments })}`}
                              </span>
                              {issue.labels.length > 0 && (
                                <span className="repo-issuelabels">
                                  {issue.labels.map((label) => (
                                    <span key={label.name} className="chip">
                                      <span
                                        className="repo-dot"
                                        aria-hidden
                                        style={{ backgroundColor: `#${label.color}` }}
                                      />
                                      {label.name}
                                    </span>
                                  ))}
                                </span>
                              )}
                            </div>
                            {live && (
                              <span
                                className="chip"
                                title={t("repo.linkedAgent")}
                                aria-label={t("repo.linkedAgent")}
                              >
                                ✦
                              </span>
                            )}
                            <Button
                              size="sm"
                              disabled={starting !== null}
                              onClick={() => startIssue(issue)}
                            >
                              {busy
                                ? t("repo.starting")
                                : linked
                                  ? t("repo.openTerminal")
                                  : t("repo.start")}
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )
              )}
            </div>
          )}
        </section>
      ) : tab === "pulls" ? (
        <section className="repo-issues">
          {pullsError && <p className="repo-status">{pullsError}</p>}
          <div className="repo-box">
            <div className="repo-boxhd">
              <button
                type="button"
                className={pullFilter === "open" ? "repo-htotal on" : "repo-htotal"}
                aria-pressed={pullFilter === "open"}
                onClick={() => setPullFilter("open")}
              >
                <span aria-hidden="true">⇄</span>{" "}
                {pullLists === null ? "…" : formatCount(pullLists.open.total)}{" "}
                {t("repo.filterOpen")}
              </button>
              <button
                type="button"
                className={pullFilter === "closed" ? "repo-htotal on" : "repo-htotal"}
                aria-pressed={pullFilter === "closed"}
                onClick={() => setPullFilter("closed")}
              >
                <span aria-hidden="true">✓</span>{" "}
                {pullLists === null ? "…" : formatCount(pullLists.closed.total)}{" "}
                {t("repo.filterClosed")}
              </button>
            </div>
            {pullLists === null ? (
              !pullsError && (
                <span className="repo-status repo-boxempty" role="status">
                  <span className="spin" aria-hidden="true" />
                </span>
              )
            ) : selectedPulls?.pulls.length === 0 ? (
              <p className="repo-hint repo-boxempty">{t("repo.emptyPulls")}</p>
            ) : (
              <ul className="repo-boxlist">
                {selectedPulls?.pulls.map((pull) => {
                  const status = pull.merged
                    ? { label: t("repo.pullMerged"), tone: "success" }
                    : pull.state === "CLOSED"
                      ? { label: t("repo.pullClosed"), tone: "neutral" }
                      : { label: t("repo.pullOpen"), tone: "pending" };
                  const openInBrowser = () => openRepoPage("pull", pull.number);
                  return (
                    <li key={pull.number}>
                      <div className="repo-row repo-issuerow repo-pull-row">
                        <span className="repo-issue-open" aria-hidden="true">
                          {pull.merged ? "✓" : "⇄"}
                        </span>
                        <span className="mono">#{pull.number}</span>
                        <div className="repo-issuemain">
                          <button
                            type="button"
                            className="repo-pull-title"
                            aria-label={t("repo.openPull", { number: pull.number })}
                            onClick={openInBrowser}
                          >
                            {pull.title}
                          </button>
                          <span className="repo-rowmsg">
                            {pull.author} · {pull.headBranch} → {pull.baseBranch}
                            {pull.comments > 0 && ` · ${t("repo.comments", { count: pull.comments })}`}
                          </span>
                        </div>
                        <span className={`chip repo-tone-${status.tone}`}>{status.label}</span>
                        {pull.updatedAt && (
                          <span className="repo-hint">
                            {repoAge(Math.round(Date.parse(pull.updatedAt) / 1000))}
                          </span>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="repo-open-pull"
                          aria-label={t("repo.openPull", { number: pull.number })}
                          title={t("repo.openOnGitHub")}
                          onClick={openInBrowser}
                        >
                          ↗
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      ) : (
        <section className="repo-issues">
          {runsError && <p className="repo-status">{runsError}</p>}
          {runs === null ? (
            !runsError && (
              <span className="repo-status" role="status">
                <span className="spin" aria-hidden="true" />
              </span>
            )
          ) : runs.length === 0 ? (
            <p className="repo-hint">{t("repo.emptyRuns")}</p>
          ) : (
            <ul className="repo-rows">
              {runs.map((run) => {
                const tone = runTone(run);
                const failed = runFailed(run);
                const busy = rerunning === run.id;
                return (
                  <li key={run.id}>
                    <div className="repo-row repo-issuerow">
                      <span className={`chip repo-tone-${tone.tone}`}>{tone.label}</span>
                      <div className="repo-issuemain">
                        <span className="repo-rowname">
                          {run.name} · {run.branch} ·{" "}
                          <span className="mono">{run.sha.slice(0, 7)}</span>
                        </span>
                        <span className="repo-rowmsg">
                          <span
                            className="chip repo-avatar repo-avatar-inline"
                            aria-hidden
                            style={{ backgroundColor: avatarColor(run.actor) }}
                          >
                            {(run.actor[0] ?? "?").toUpperCase()}
                          </span>
                          {run.message || "—"} · {run.actor}
                          {run.updatedAt &&
                            ` · ${repoAge(Math.round(Date.parse(run.updatedAt) / 1000))}`}
                        </span>
                      </div>
                      {failed && (
                        <Button
                          size="sm"
                          disabled={rerunning !== null}
                          onClick={() => rerunRun(run)}
                        >
                          {busy ? t("repo.rerunning") : t("repo.rerun")}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
