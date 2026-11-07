import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { t } from "../../i18n/t";
import type { Project } from "../../ipc/catalog";
import {
  readGraphCommitDetail,
  readGraphPage,
  type GraphCommit,
  type GraphCommitDetail,
  type GraphPage,
  type GraphRefKind,
  type WipSummary,
} from "../../ipc/graph";
import { createWorktreeAtCommit, onGitChanged } from "../../ipc/worktrees";
import { useRepos } from "../../state/repos";
import { useWorktrees } from "../../state/worktrees";
import { useStage } from "../../state/stage";
import { ask } from "../../ui/dialog";
import { Menu, type MenuItem } from "../../ui/Menu";
import { toast } from "../../ui/toast";
import { useGraphUi, type GraphFilter } from "./graphState";
import "./graph.css";

const ROW_HEIGHT = 38;
const OVERSCAN = 8;
const PAGE_PREFETCH_ROWS = 30;
// ponytail: lane spacing sized for the 19px avatar nodes (criterion 10), not the old 8px dots.
const LANE_STEP = 20;
const LANE_OFFSET = 11;
// Fixed lanes column (criterion 9/10): every row's message starts at the same x; only a row
// with more lanes than this fits grows the column (prototype uses a fixed 132px column).
const LANE_FIXED_WIDTH = 100;
// Token palette cycled by lane index (matches the lane-N classes in graph.css). Ordered so
// adjacent lanes never land on near-identical hues (--acc and --blu are both blue-ish).
const LANE_COLORS = ["var(--acc)", "var(--grn)", "var(--yel)", "var(--pur)", "var(--blu)"];
// Wider palette for deterministic per-author colors, independent of lane coloring.
const AVATAR_PALETTE = ["var(--acc)", "var(--blu)", "var(--grn)", "var(--yel)", "var(--pur)", "var(--red)"];

/** djb2-ish string hash with better bucket spread than a plain polynomial hash for short strings. */
function hashString(value: string): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) hash = ((hash * 33) ^ value.charCodeAt(index)) | 0;
  return Math.abs(hash);
}
const timeUnitKeys = {
  seconds: "graph.timeUnit.seconds",
  minutes: "graph.timeUnit.minutes",
  hours: "graph.timeUnit.hours",
  days: "graph.timeUnit.days",
  weeks: "graph.timeUnit.weeks",
  months: "graph.timeUnit.months",
  years: "graph.timeUnit.years",
} as const;
const filterKeys = {
  all: "graph.filter.all",
  worktrees: "graph.filter.worktrees",
  mine: "graph.filter.mine",
} as const;
const deferredMenuActions = [
  "graph.action.checkout",
  "graph.action.createBranch",
  "graph.action.cherryPick",
  "graph.action.revert",
  "graph.action.rebase",
  "graph.action.openPullRequest",
  "graph.action.diff",
  "graph.action.blame",
  "graph.action.terminal",
  "graph.action.agent",
] as const;
const fileGroupKeys = {
  staged: "graph.files.staged",
  unstaged: "graph.files.unstaged",
  untracked: "graph.files.untracked",
  conflicted: "graph.files.conflicted",
} as const;
// ponytail: a badge letter for the known bucket a WIP file is in; not a real git status
// letter (we don't have per-file M/A/D data), so it stays neutral rather than color-coded.
const fileGroupBadges = { staged: "S", unstaged: "M", untracked: "U", conflicted: "C" } as const;
const refKindKeys: Record<GraphRefKind, "graph.ref.localBranch" | "graph.ref.remoteBranch" | "graph.ref.tag"> = {
  localBranch: "graph.ref.localBranch",
  remoteBranch: "graph.ref.remoteBranch",
  tag: "graph.ref.tag",
};
const refIcons: Record<GraphRefKind, string> = { localBranch: "", remoteBranch: "☁ ", tag: "◆ " };

function laneX(lane: number): number {
  return LANE_OFFSET + lane * LANE_STEP;
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function avatarColor(seed: string): string {
  return AVATAR_PALETTE[hashString(seed) % AVATAR_PALETTE.length];
}

function authorInitial(name: string | null): string {
  const trimmed = (name ?? "").trim();
  return trimmed ? trimmed[0].toUpperCase() : "?";
}

async function copySha(sha: string) {
  try {
    await navigator.clipboard.writeText(sha);
    toast({ title: t("graph.copiedSha"), detail: sha, icon: "✓" });
  } catch (reason) {
    toast({
      title: t("graph.copyFailed"),
      detail: reason instanceof Error ? reason.message : String(reason),
      icon: "⚠",
    });
  }
}

export function filterGraphCommits(
  commits: GraphCommit[],
  filter: GraphFilter,
  userEmail: string | null,
): GraphCommit[] {
  if (filter === "worktrees") return commits.filter((commit) => commit.worktreeHeads.length > 0);
  if (filter === "mine") {
    if (!userEmail) return [];
    const email = userEmail.trim().toLocaleLowerCase();
    return commits.filter((commit) => commit.authorEmail?.trim().toLocaleLowerCase() === email);
  }
  return commits;
}

interface GraphLaneRow {
  incoming: boolean;
  continuingLanes: number[];
}

/** Full ancestry (criterion 1) of `headSha` within the loaded `commits`, for the GitKraken-style
 * branch highlight. `null` means "no head" (empty repo, unborn branch): nothing fades. */
export function graphAncestry(commits: GraphCommit[], headSha: string | null): Set<string> | null {
  if (!headSha) return null;
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const ancestry = new Set<string>();
  const stack = [headSha];
  while (stack.length > 0) {
    const sha = stack.pop();
    if (!sha || ancestry.has(sha)) continue;
    ancestry.add(sha);
    stack.push(...(bySha.get(sha)?.parents ?? []));
  }
  return ancestry;
}

export function graphLaneRows(commits: GraphCommit[]): Map<string, GraphLaneRow> {
  const activeLanes = new Map<number, string>();
  const rows = new Map<string, GraphLaneRow>();
  for (const commit of commits) {
    const incoming = activeLanes.get(commit.lane) === commit.sha;
    const continuingLanes = [...activeLanes.keys()].filter((lane) => lane !== commit.lane);
    activeLanes.delete(commit.lane);
    for (const edge of commit.edges) {
      const parent = commit.parents[edge.parentIndex];
      if (parent) activeLanes.set(edge.toLane, parent);
    }
    rows.set(commit.sha, { incoming, continuingLanes });
  }
  return rows;
}

// Short form (criterion 9): now / 5m / 5h / 3d / 2w / 4mo / 3y — never "X ago" or full unit words.
function relativeTime(timestamp: number): string {
  const seconds = Math.round(Date.now() / 1000 - timestamp);
  const absolute = Math.abs(seconds);
  if (absolute < 60) return t("graph.timeNow");
  const [amount, unit] =
    absolute < 3600 ? [Math.round(absolute / 60), "minutes"] :
    absolute < 86400 ? [Math.round(absolute / 3600), "hours"] :
    absolute < 604800 ? [Math.round(absolute / 86400), "days"] :
    absolute < 2_592_000 ? [Math.round(absolute / 604_800), "weeks"] :
    absolute < 31_536_000 ? [Math.round(absolute / 2_592_000), "months"] :
    [Math.round(absolute / 31_536_000), "years"];
  const short = t("graph.timeShort", { amount, unit: t(timeUnitKeys[unit as keyof typeof timeUnitKeys]) });
  return seconds >= 0 ? short : `+${short}`;
}

function formatCommitTimestamp(commit: GraphCommit): string {
  const localSeconds = commit.timestamp + commit.timezoneOffsetMinutes * 60;
  const localTime = new Date(localSeconds * 1000).toISOString().slice(0, 16).replace("T", " ");
  const offset = commit.timezoneOffsetMinutes;
  const sign = offset < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return t("graph.timezoneOffset", { datetime: localTime, sign, hours, minutes });
}

function filterLabel(filter: GraphFilter): string {
  return t(filterKeys[filter]);
}

/** Ref pills for a commit row or the inspector's meta row: tinted with the commit's lane color.
 * The active worktree's own head pill (criterion 4) gets a solid lane-color fill instead. */
function RefPills({ commit }: { commit: GraphCommit }) {
  const activePath = useWorktrees((state) => state.activePath);
  const style = { "--ref-c": laneColor(commit.lane) } as CSSProperties;
  return (
    <>
      {commit.worktreeHeads.map((head) => (
        <span
          key={head.path}
          className={"graph-ref worktree" + (head.path === activePath ? " active" : "")}
          style={style}
          title={head.path}
        >
          ⌂ {head.branch ?? t("sidebar.detached")}
        </span>
      ))}
      {commit.refs.map((ref) => (
        <span key={`${ref.kind}:${ref.name}`} className="graph-ref" style={style} title={t(refKindKeys[ref.kind])}>
          {refIcons[ref.kind]}{ref.name}
        </span>
      ))}
    </>
  );
}

export function GraphToolbar() {
  const selectedCommit = useGraphUi((state) => state.selectedCommit);
  const selection = useGraphUi((state) => state.selection);
  const projectId = useRepos((state) => state.activeProjectId);
  const project = useRepos((state) => state.projects.find((item) => item.id === state.activeProjectId) ?? null);
  const activePath = useWorktrees((state) => state.activePath);
  const worktreesProjectId = useWorktrees((state) => state.projectId);
  const activeBranch = useWorktrees(
    (state) => state.worktrees.find((worktree) => worktree.path === state.activePath)?.branch ?? null,
  );
  return (
    <>
      <h1 className="pane-title">
        {t("nav.graph")} <span className="graph-subtitle mono" aria-hidden="true">{activeBranch ?? t("sidebar.detached")}</span>
      </h1>
      <div className="graph-toolbar-actions">
        <button className="btn sm graph-deferred-action" disabled title={t("graph.deferredTitle")}>{t("graph.fetch")} · {t("graph.later")}</button>
        <button className="btn sm graph-deferred-action" disabled title={t("graph.deferredTitle")}>{t("graph.pull")} · {t("graph.later")}</button>
        <button className="btn sm graph-deferred-action" disabled title={t("graph.deferredTitle")}>{t("graph.push")} · {t("graph.later")}</button>
        <button
          className="btn primary"
          disabled={selection.kind !== "commit" || !selectedCommit || !project || !activePath || worktreesProjectId !== projectId}
          title={selectedCommit ? t("graph.createAtCommitTitle") : t("graph.selectCommitToCreateWorktree")}
          onClick={() => {
            if (selection.kind === "commit" && selectedCommit && project && activePath) {
              void createWorktreeFromCommit(project, selectedCommit);
            }
          }}
        >
          {t("graph.worktreeToolbar")}
        </button>
      </div>
    </>
  );
}

/** Sticky filter bar under the toolbar (criterion 7): highlights, doesn't hide (criterion 8). */
function GraphFilterBar({
  totalLoaded,
  hasMore,
  totalCommits,
}: {
  totalLoaded: number;
  hasMore: boolean;
  totalCommits: number | null;
}) {
  const filter = useGraphUi((state) => state.filter);
  const setFilter = useGraphUi((state) => state.setFilter);
  const atEnd = !hasMore && totalCommits != null;
  const hint = t(atEnd ? "graph.filterEndHistory" : "graph.filterCommitCount", {
    count: atEnd ? totalCommits : totalLoaded,
  });
  return (
    <div className="graph-filter-bar">
      <div className="graph-filter-chips" role="group" aria-label={t("graph.filters")}>
        {(["all", "worktrees", "mine"] as const).map((value) => (
          <button
            key={value}
            className={"graph-filter" + (filter === value ? " on" : "")}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === "worktrees" ? "⌂ " : ""}{filterLabel(value)}
          </button>
        ))}
        <button
          className="graph-filter"
          disabled
          title={t("graph.agentUnavailable")}
          aria-label={t("graph.filter.agentUnavailable")}
        >
          ✦ {t("graph.filter.agent")}
        </button>
      </div>
      <span className="graph-filter-hint mono">{hint}</span>
    </div>
  );
}

async function createWorktreeFromCommit(project: Project, commit: GraphCommit) {
  const branch = await ask({
    title: t("graph.worktreeTitle"),
    body: t("graph.worktreeBody", { sha: commit.shortSha }),
    input: `commit/${commit.shortSha}`,
    placeholder: t("graph.branchPlaceholder"),
    ok: t("graph.createWorktree"),
    icon: "⌂",
  });
  if (typeof branch !== "string") return;
  const safeBranch = branch.trim();
  const safeDirectory = safeBranch.replaceAll("/", "-").replaceAll("\\", "-");
  const parent = project.localPath.slice(0, project.localPath.lastIndexOf("/")) || "/";
  const destination = `${parent}/${safeDirectory}`;
  try {
    const created = await createWorktreeAtCommit(project.id, destination, safeBranch, commit.sha);
    await useWorktrees.getState().load(project);
    useWorktrees.getState().select(created.path);
    toast({ title: t("graph.worktreeCreated"), detail: created.branch ?? created.path, icon: "✓" });
  } catch (reason) {
    toast({
      title: t("graph.worktreeError", { message: reason instanceof Error ? reason.message : String(reason) }),
      icon: "⚠",
    });
  }
}

interface MenuPosition {
  x: number;
  y: number;
  commit: GraphCommit;
}

export function GraphView() {
  const projectId = useRepos((state) => state.activeProjectId);
  const project = useRepos((state) => state.projects.find((item) => item.id === state.activeProjectId) ?? null);
  const activePath = useWorktrees((state) => state.activePath);
  const worktreesProjectId = useWorktrees((state) => state.projectId);
  const activeWorktreeHead = useWorktrees(
    (state) => state.worktrees.find((worktree) => worktree.path === state.activePath)?.head ?? null,
  );
  const filter = useGraphUi((state) => state.filter);
  const selection = useGraphUi((state) => state.selection);
  const setSelectedCommit = useGraphUi((state) => state.setSelectedCommit);
  const select = useGraphUi((state) => state.select);
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [wip, setWip] = useState<WipSummary | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [totalCommits, setTotalCommits] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<GraphCommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuPosition | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);
  const detailRequestId = useRef(0);
  const nextPage = useRef(0);
  const pageLoading = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(500);

  const loadFirstPage = useCallback(async () => {
    if (!projectId || !activePath || worktreesProjectId !== projectId) return;
    const currentRequest = ++requestId.current;
    nextPage.current = 0;
    pageLoading.current = true;
    setCommits([]);
    setWip(null);
    setHasMore(false);
    setTotalCommits(0);
    setError(null);
    setLoading(true);
    select({ kind: "wip" });
    setSelectedCommit(null);
    setMenu(null);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
    try {
      const page = await readGraphPage(projectId, activePath, 0);
      if (requestId.current !== currentRequest) return;
      applyPage(page, true);
    } catch (reason) {
      if (requestId.current !== currentRequest) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestId.current === currentRequest) {
        pageLoading.current = false;
        setLoading(false);
      }
    }
  }, [activePath, projectId, select, setSelectedCommit, worktreesProjectId]);

  const applyPage = (page: GraphPage, first: boolean) => {
    setCommits((current) => {
      if (first) return page.commits;
      // Defensive dedupe: the backend guarantees page consistency, but duplicate shas would
      // otherwise produce duplicate React keys.
      const seen = new Set(current.map((commit) => commit.sha));
      return [...current, ...page.commits.filter((commit) => !seen.has(commit.sha))];
    });
    setWip(page.wip);
    setUserEmail(page.userEmail);
    setHasMore(page.hasMore);
    setTotalCommits(page.totalCommits);
    nextPage.current = page.page + 1;
  };

  useEffect(() => {
    void loadFirstPage();
    return () => {
      requestId.current++;
    };
  }, [loadFirstPage]);

  // Reload page 0 when the repo changes on disk (code review I4), keeping the current
  // selection: `selectedCommit` is derived from `commits`, so it falls back to "no selection"
  // on its own if the selected sha disappeared, and stays selected if it's still there.
  const refreshOnGitChange = useCallback(async () => {
    if (!projectId || !activePath || worktreesProjectId !== projectId || pageLoading.current) return;
    const currentRequest = ++requestId.current;
    pageLoading.current = true;
    try {
      const page = await readGraphPage(projectId, activePath, 0);
      if (requestId.current !== currentRequest) return;
      applyPage(page, true);
    } catch (reason) {
      if (requestId.current !== currentRequest) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestId.current === currentRequest) pageLoading.current = false;
    }
  }, [activePath, projectId, worktreesProjectId]);

  useEffect(() => {
    if (!projectId || !activePath || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let subscription: Promise<() => void>;
    try {
      subscription = onGitChanged((event) => {
        if (event.worktree === activePath) void refreshOnGitChange();
      });
    } catch {
      return;
    }
    void subscription.then((stop) => {
      if (disposed) void stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      if (unlisten) void unlisten();
    };
  }, [activePath, projectId, refreshOnGitChange]);

  // Filters highlight matching rows rather than hiding the rest (criterion 8).
  const matchingShas = useMemo(() => {
    if (filter === "all") return null;
    return new Set(filterGraphCommits(commits, filter, userEmail).map((commit) => commit.sha));
  }, [commits, filter, userEmail]);
  const laneRows = useMemo(() => graphLaneRows(commits), [commits]);
  // Active worktree's branch ancestry (criterion 1), GitKraken-style highlight.
  const branchAncestry = useMemo(
    () => graphAncestry(commits, activeWorktreeHead ?? wip?.head ?? null),
    [commits, wip?.head, activeWorktreeHead],
  );
  const selectedCommit = selection.kind === "commit"
    ? commits.find((commit) => commit.sha === selection.sha) ?? null
    : null;

  const loadNextPage = useCallback(async () => {
    if (
      !projectId ||
      !activePath ||
      loading ||
      pageLoading.current ||
      !hasMore
    ) return;
    const currentRequest = requestId.current;
    const pageIndex = nextPage.current;
    pageLoading.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await readGraphPage(projectId, activePath, pageIndex);
      if (requestId.current !== currentRequest) return;
      applyPage(page, false);
    } catch (reason) {
      if (requestId.current !== currentRequest) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestId.current === currentRequest) {
        pageLoading.current = false;
        setLoading(false);
      }
    }
  }, [activePath, hasMore, loading, projectId]);

  const scrollToTop = useCallback(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    setScrollTop(0);
  }, []);

  const onScroll = () => {
    const element = listRef.current;
    if (!element) return;
    setScrollTop(element.scrollTop);
  };

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const measure = () => {
      if (element.clientHeight > 0) setViewportHeight(element.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [projectId, activePath]);

  const rowCount = commits.length + 1;
  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endVisible = Math.min(rowCount, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visibleRows = [];
  for (let index = firstVisible; index < endVisible; index++) visibleRows.push(index);

  useEffect(() => {
    const loadedRows = commits.length + 1;
    const remaining = loadedRows * ROW_HEIGHT - (scrollTop + viewportHeight);
    if (scrollTop > 0 && remaining <= PAGE_PREFETCH_ROWS * ROW_HEIGHT && hasMore && !loading && !error) {
      void loadNextPage();
    }
  }, [commits.length, error, hasMore, loadNextPage, loading, scrollTop, viewportHeight]);

  useEffect(() => {
    scrollToTop();
  }, [activePath, filter, projectId, scrollToTop]);

  useEffect(() => {
    const currentRequest = ++detailRequestId.current;
    if (!selectedCommit || !projectId || !activePath) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    void readGraphCommitDetail(projectId, activePath, selectedCommit.sha)
      .then((result) => {
        if (detailRequestId.current === currentRequest) setDetail(result);
      })
      .catch((reason: unknown) => {
        if (detailRequestId.current === currentRequest) {
          setDetailError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (detailRequestId.current === currentRequest) setDetailLoading(false);
      });
    return () => {
      if (detailRequestId.current === currentRequest) detailRequestId.current++;
    };
  }, [activePath, projectId, selectedCommit?.sha]);

  const showMenu = (event: MouseEvent, commit: GraphCommit) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, commit });
  };

  const menuItems: MenuItem[] = menu ? [
    { kind: "item", label: t("graph.copySha"), icon: "⧉", onSelect: () => void copySha(menu.commit.sha) },
    { kind: "item", label: t("graph.createWorktreeHere"), icon: "⌂", onSelect: () => {
      if (project) void createWorktreeFromCommit(project, menu.commit);
    } },
    { kind: "separator" },
    { kind: "header", label: t("graph.deferredActions") },
    ...deferredMenuActions.map((labelKey) => ({
      kind: "item" as const,
      label: `${t(labelKey)} · ${t("graph.later")}`,
      disabled: true,
      onSelect: () => {},
    })),
  ] : [];

  if (!projectId) {
    return <div className="graph-state"><p>{t("graph.noProject")}</p></div>;
  }
  if (worktreesProjectId !== projectId || !activePath) {
    return <div className="graph-state"><p>{t("graph.waitingForWorktree")}</p></div>;
  }

  return (
    <div className="graph-screen">
      <section className="graph-list-panel" aria-label={t("graph.commitHistory")}>
        <GraphFilterBar totalLoaded={commits.length} hasMore={hasMore} totalCommits={totalCommits} />
        {error && commits.length === 0 ? (
          <div className="graph-state" role="alert">
            <p>{t("graph.loadError", { message: error })}</p>
            <button className="btn sm" onClick={() => void loadFirstPage()}>{t("graph.retry")}</button>
          </div>
        ) : (
          <div className="graph-scroll" ref={listRef} onScroll={onScroll} role="listbox" aria-label={t("graph.commitHistory")}>
            {filter === "mine" && !userEmail && !loading && (
              <div className="graph-notice" role="status">{t("graph.mineNoEmail")}</div>
            )}
            {commits.length === 0 && !loading && !error && (
              <div className="graph-empty" role="status">{t("graph.empty")}</div>
            )}
            <div style={{ height: firstVisible * ROW_HEIGHT }} aria-hidden />
            {visibleRows.map((rowIndex) => rowIndex === 0 ? (
              <WipRow
                key="wip"
                wip={wip}
                selected={selection.kind === "wip"}
                onSelect={() => {
                  setSelectedCommit(null);
                  select({ kind: "wip" });
                }}
              />
            ) : (
              <CommitRow
                key={commits[rowIndex - 1].sha}
                commit={commits[rowIndex - 1]}
                laneRow={laneRows.get(commits[rowIndex - 1].sha)}
                selected={selection.kind === "commit" && selection.sha === commits[rowIndex - 1].sha}
                dim={matchingShas !== null && !matchingShas.has(commits[rowIndex - 1].sha)}
                offBranch={branchAncestry !== null && !branchAncestry.has(commits[rowIndex - 1].sha)}
                onSelect={() => {
                  const commit = commits[rowIndex - 1];
                  setSelectedCommit(commit);
                  select({ kind: "commit", sha: commit.sha });
                }}
                onContextMenu={(event) => showMenu(event, commits[rowIndex - 1])}
              />
            ))}
            <div style={{ height: Math.max(0, rowCount - endVisible) * ROW_HEIGHT }} aria-hidden />
            {loading && <div className="graph-list-status" role="status">{t("graph.loading")}</div>}
            {error && commits.length > 0 && (
              <div className="graph-inline-error" role="alert">
                <span>{t("graph.pageError", { message: error })}</span>
                <button className="btn sm" onClick={() => void loadNextPage()}>{t("graph.retry")}</button>
              </div>
            )}
            {!loading && !error && !hasMore && commits.length > 0 && (
              <div className="graph-list-status">{t("graph.endHistory", { count: totalCommits ?? commits.length })}</div>
            )}
          </div>
        )}
      </section>
      <aside className="graph-inspector" aria-label={t("graph.inspector")}>
        {selection.kind === "wip" ? (
          <WipInspector wip={wip} onOpenChanges={() => useStage.getState().go("changes")} />
        ) : selectedCommit ? (
          <CommitInspector
            commit={selectedCommit}
            detail={detail}
            loading={detailLoading}
            error={detailError}
            onRetry={() => {
              const commit = selectedCommit;
              if (!projectId || !activePath) return;
              const currentRequest = ++detailRequestId.current;
              setDetailError(null);
              setDetailLoading(true);
              void readGraphCommitDetail(projectId, activePath, commit.sha)
                .then((result) => {
                  if (detailRequestId.current === currentRequest) setDetail(result);
                })
                .catch((reason: unknown) => {
                  if (detailRequestId.current === currentRequest) {
                    setDetailError(reason instanceof Error ? reason.message : String(reason));
                  }
                })
                .finally(() => {
                  if (detailRequestId.current === currentRequest) setDetailLoading(false);
                });
            }}
          />
        ) : (
          <div className="graph-inspector-empty">{t("graph.selectCommit")}</div>
        )}
      </aside>
      {menu && <Menu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} width={260} />}
    </div>
  );
}

function WipRow({ wip, selected, onSelect }: { wip: WipSummary | null; selected: boolean; onSelect(): void }) {
  const count = wip
    ? wip.stagedFiles.length + wip.unstagedFiles.length + wip.untrackedFiles.length + wip.conflictedFiles.length
    : 0;
  return (
    <button
      className={"graph-row wip-row" + (selected ? " selected" : "")}
      role="option"
      aria-selected={selected}
      aria-label={t("graph.wipRowLabel", {
        branch: wip?.branch ?? t("sidebar.detached"),
        count,
        sha: wip?.head?.slice(0, 7) ?? "—",
      })}
      onClick={onSelect}
    >
      <span className="graph-lanes" aria-hidden>
        <svg width={LANE_FIXED_WIDTH} height={ROW_HEIGHT} viewBox={`0 0 ${LANE_FIXED_WIDTH} ${ROW_HEIGHT}`}>
          <circle
            cx={laneX(0)}
            cy={ROW_HEIGHT / 2}
            r={9.5}
            fill="var(--surf)"
            stroke="var(--fg3)"
            strokeWidth={2}
            strokeDasharray="3 2"
          />
        </svg>
      </span>
      <span className="graph-message-cell"><span className="graph-message-text">{t("graph.wip")}</span></span>
      <span className="graph-row-ref">{wip?.branch ?? t("sidebar.detached")}</span>
      <span className="graph-author">{wip ? t("graph.wipFileCount", { count }) : t("graph.loading")}</span>
      <span className="graph-sha">{wip?.head?.slice(0, 7) ?? "—"}</span>
    </button>
  );
}

function CommitRow({
  commit,
  selected,
  dim,
  offBranch,
  onSelect,
  onContextMenu,
  laneRow,
}: {
  commit: GraphCommit;
  selected: boolean;
  dim: boolean;
  offBranch: boolean;
  onSelect(): void;
  onContextMenu(event: MouseEvent): void;
  laneRow?: GraphLaneRow;
}) {
  const laneWidth = Math.max(
    LANE_FIXED_WIDTH,
    (Math.max(commit.lane, ...commit.edges.map((edge) => edge.toLane), ...(laneRow?.continuingLanes ?? []), 0) + 1) * LANE_STEP + LANE_OFFSET,
  );
  const color = avatarColor(commit.authorEmail ?? commit.authorName ?? commit.sha);
  return (
    <button
      className={"graph-row" + (selected ? " selected" : "") + (dim ? " dim" : "") + (offBranch ? " off-branch" : "")}
      role="option"
      aria-selected={selected}
      aria-label={t("graph.rowLabel", {
        message: commit.message.split("\n")[0],
        author: commit.authorName ?? t("graph.unknownAuthor"),
        sha: commit.shortSha,
      })}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <span className="graph-lanes" style={{ width: laneWidth }} aria-hidden>
        <svg width={laneWidth} height={ROW_HEIGHT} viewBox={`0 0 ${laneWidth} ${ROW_HEIGHT}`}>
          {laneRow?.incoming && (
            <line
              x1={laneX(commit.lane)}
              y1={0}
              x2={laneX(commit.lane)}
              y2={ROW_HEIGHT / 2}
              className={`graph-lane graph-continuation lane-${commit.lane % 5}`}
            />
          )}
          {laneRow?.continuingLanes.map((lane) => (
            <line
              key={`continue-${lane}`}
              x1={laneX(lane)}
              y1={0}
              x2={laneX(lane)}
              y2={ROW_HEIGHT}
              className={`graph-lane graph-continuation lane-${lane % 5}`}
            />
          ))}
          {commit.edges.map((edge) => {
            const x1 = laneX(edge.fromLane);
            const x2 = laneX(edge.toLane);
            const y1 = ROW_HEIGHT / 2;
            const y2 = ROW_HEIGHT;
            const key = `${edge.parentIndex}-${edge.fromLane}-${edge.toLane}`;
            // Straight when the lane doesn't change, a smooth cubic curve when it does (criterion 10).
            if (x1 === x2) {
              return <line key={key} x1={x1} y1={y1} x2={x2} y2={y2} className={`graph-lane lane-${edge.fromLane % 5}`} />;
            }
            const midY = y1 + (y2 - y1) / 2;
            return (
              <path
                key={key}
                d={`M${x1} ${y1} C${x1} ${midY} ${x2} ${midY} ${x2} ${y2}`}
                fill="none"
                className={`graph-lane lane-${edge.fromLane % 5}`}
              />
            );
          })}
          <circle
            cx={laneX(commit.lane)}
            cy={ROW_HEIGHT / 2}
            r={9.5}
            fill={color}
            stroke="oklch(.16 .01 var(--bh))"
            strokeWidth={2.5}
          />
          <text x={laneX(commit.lane)} y={ROW_HEIGHT / 2 + 3} className="graph-node-initial">
            {authorInitial(commit.authorName)}
          </text>
        </svg>
      </span>
      <span className="graph-message-cell">
        <RefPills commit={commit} />
        <span className="graph-message-text">{commit.message.split("\n")[0] || t("graph.emptyMessage")}</span>
      </span>
      <span className="graph-author">
        <span className="graph-author-avatar" style={{ background: color }} aria-hidden>{authorInitial(commit.authorName)}</span>
        <span className="graph-author-name">{commit.authorName ?? t("graph.unknownAuthor")}</span>
      </span>
      <time className="graph-time" dateTime={new Date(commit.timestamp * 1000).toISOString()} title={formatCommitTimestamp(commit)}>
        {relativeTime(commit.timestamp)}
      </time>
      <span className="graph-sha">{commit.shortSha}</span>
    </button>
  );
}

function WipInspector({ wip, onOpenChanges }: { wip: WipSummary | null; onOpenChanges(): void }) {
  const groups = [
    ["staged", wip?.stagedFiles ?? []],
    ["unstaged", wip?.unstagedFiles ?? []],
    ["untracked", wip?.untrackedFiles ?? []],
    ["conflicted", wip?.conflictedFiles ?? []],
  ] as const;
  const count = wip
    ? wip.stagedFiles.length + wip.unstagedFiles.length + wip.untrackedFiles.length + wip.conflictedFiles.length
    : 0;
  return (
    <div className="graph-inspector-content">
      <div className="graph-wip-meta">
        <span className="graph-chip">{t("graph.wipFileCount", { count })}</span>
        <button className="btn sm" onClick={onOpenChanges}>± {t("graph.openChanges")}</button>
        <span className="graph-chip mono">{wip?.branch ?? t("sidebar.detached")}</span>
      </div>
      <h2 className="graph-commit-heading">{t("graph.wip")}</h2>
      <div className="graph-file-groups">
        {groups.map(([group, files]) => (
          <section key={group} className="graph-file-group">
            <h3>{t(fileGroupKeys[group])} <span>{files.length}</span></h3>
            {files.length ? (
              <ul>{files.map((path) => (
                <li key={`${group}:${path}`} className="graph-wip-file" title={path}>
                  <span className="graph-status-badge" aria-hidden>{fileGroupBadges[group]}</span>
                  <code>{path}</code>
                </li>
              ))}</ul>
            ) : <p className="graph-muted">{t("graph.noFiles")}</p>}
          </section>
        ))}
      </div>
    </div>
  );
}

function CommitInspector({
  commit,
  detail,
  loading,
  error,
  onRetry,
}: {
  commit: GraphCommit;
  detail: GraphCommitDetail | null;
  loading: boolean;
  error: string | null;
  onRetry(): void;
}) {
  const color = avatarColor(commit.authorEmail ?? commit.authorName ?? commit.sha);
  return (
    <div className="graph-inspector-content">
      <div className="graph-commit-meta">
        <button type="button" className="graph-chip mono" title={commit.sha} onClick={() => void copySha(commit.sha)}>
          {commit.shortSha}
        </button>
        <RefPills commit={commit} />
      </div>
      <h2 className="graph-commit-heading">{commit.message.trim() || t("graph.emptyMessage")}</h2>
      <div className="graph-commit-author">
        <span className="graph-author-avatar lg" style={{ background: color }} aria-hidden>{authorInitial(commit.authorName)}</span>
        <span><b>{commit.authorName ?? t("graph.unknownAuthor")}</b> · <time title={formatCommitTimestamp(commit)}>{relativeTime(commit.timestamp)}</time></span>
      </div>
      <section className="graph-file-group">
        <h3>{t("graph.files")} <span>{detail?.changedPaths.length ?? 0}</span></h3>
        {loading && <p className="graph-muted">{t("graph.loadingPaths")}</p>}
        {error && <div role="alert" className="graph-inline-error"><span>{t("graph.pathsError", { message: error })}</span><button className="btn sm" onClick={onRetry}>{t("graph.retry")}</button></div>}
        {!loading && !error && detail?.changedPaths.length === 0 && <p className="graph-muted">{t("graph.noFiles")}</p>}
        {detail?.changedPaths.length ? (
          <ul>{detail.changedPaths.map((path) => <li key={path} className="graph-file-row" title={path}><code>{path}</code></li>)}</ul>
        ) : null}
      </section>
      <div className="graph-commit-actions">
        <button className="btn sm" disabled title={t("graph.deferredTitle")}>{t("graph.cherryPick")} · {t("graph.later")}</button>
        <button className="btn sm" disabled title={t("graph.deferredTitle")}>{t("graph.revert")} · {t("graph.later")}</button>
        <button className="btn sm" disabled title={t("graph.deferredTitle")}>{t("graph.action.rebase")} · {t("graph.later")}</button>
      </div>
    </div>
  );
}
