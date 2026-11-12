// Typed wrappers for the Repository screen backend (M4 Task 07).
// Overview, contributors, star/watch/fork, plus local-git reads for the
// Code tab. Tokens never appear here; the backend resolves them per account.
import { commands, type RateLimitState_Serialize } from "./bindings";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface RepoRemote {
  owner: string;
  repo: string;
  url: string;
}

export interface RepoRelease {
  name: string | null;
  tag: string;
  publishedAt: string | null;
  draft: boolean;
  isLatest: boolean;
  url: string;
}

export interface RepoLanguage {
  name: string;
  color: string | null;
  size: number;
}

export interface RepoMeta {
  id: string;
  isPrivate: boolean;
  description: string | null;
  homepageUrl: string | null;
  topics: string[];
  license: string | null;
  stars: number;
  forks: number;
  watchers: number;
  viewerStarred: boolean;
  viewerSubscription: string;
  defaultBranch: string;
  releases: RepoRelease[];
  languages: RepoLanguage[];
}

export interface RepoContributor {
  login: string;
  contributions: number;
  avatarUrl: string;
}

export interface RepoBranches {
  current: string | null;
  branches: string[];
  tagCount: number;
}

export interface RepoCommit {
  hash: string;
  message: string;
  author: string;
  epoch: number;
}

export interface RepoTreeEntry {
  name: string;
  kind: string;
  message: string;
  epoch: number;
}

export interface RepoIssueLabel {
  name: string;
  color: string;
}

export interface RepoIssue {
  number: number;
  title: string;
  author: string;
  url: string;
  updatedAt: string | null;
  comments: number;
  labels: RepoIssueLabel[];
}

export type IssueState = "open" | "closed";

export interface RepoRun {
  id: number;
  name: string;
  branch: string;
  sha: string;
  message: string;
  actor: string;
  actorAvatar: string | null;
  status: string;
  conclusion: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
}

export type RepoRateLimit = RateLimitState_Serialize;

/** Invalidate the selected repo's in-memory data before an explicit refresh. */
export function invalidateRepoCache(owner: string, repo: string, account: string): Promise<void> {
  if (!inTauri()) {
    return Promise.reject(new Error("Refreshing GitHub data requires the desktop app"));
  }
  return commands.ghRepoCacheInvalidate(owner, repo, account).then(() => undefined);
}

/** Latest low-quota response headers, if the poller should back off. */
export function ghRateLimitStatus(): Promise<RepoRateLimit | null> {
  if (!inTauri()) {
    return Promise.reject(new Error("Checking GitHub quota requires the desktop app"));
  }
  return commands.ghRateLimitStatus();
}

/** Resolve the active worktree's origin remote to owner/repo/URL. */
export function ghRepoRemote(worktreePath: string): Promise<RepoRemote> {
  if (!inTauri()) {
    return Promise.reject(new Error("Reading the git remote requires the desktop app"));
  }
  return commands.ghRepoRemote(worktreePath);
}

/** Repository overview for the repo screen as one stored account. */
export function ghRepoMeta(owner: string, repo: string, account: string): Promise<RepoMeta> {
  if (!inTauri()) {
    return Promise.reject(new Error("Loading the repository requires the desktop app"));
  }
  // The wire shape keeps Rust snake_case; the UI shape is camelCase.
  return commands.ghRepoMeta(owner, repo, account).then((meta) => ({
    id: meta.id,
    isPrivate: meta.is_private,
    description: meta.description,
    homepageUrl: meta.homepage_url,
    topics: meta.topics,
    license: meta.license,
    stars: meta.stars,
    forks: meta.forks,
    watchers: meta.watchers,
    viewerStarred: meta.viewer_starred,
    viewerSubscription: meta.viewer_subscription,
    defaultBranch: meta.default_branch,
    releases: meta.releases.map((release) => ({
      name: release.name,
      tag: release.tag,
      publishedAt: release.published_at,
      draft: release.draft,
      isLatest: release.is_latest,
      url: release.url,
    })),
    languages: meta.languages.map((language) => ({
      name: language.name,
      color: language.color,
      size: language.size,
    })),
  }));
}

/** Top contributors for the repo screen sidebar as one stored account. */
export function ghRepoContributors(
  owner: string,
  repo: string,
  account: string,
): Promise<RepoContributor[]> {
  if (!inTauri()) {
    return Promise.reject(new Error("Loading contributors requires the desktop app"));
  }
  return commands.ghRepoContributors(owner, repo, account).then((rows) =>
    rows.map((row) => ({
      login: row.login,
      contributions: row.contributions,
      avatarUrl: row.avatar_url,
    })),
  );
}

/** Star or unstar a repo. Returns the new starred state. */
export function ghRepoSetStarred(
  owner: string,
  repo: string,
  account: string,
  starred: boolean,
): Promise<boolean> {
  if (!inTauri()) {
    return Promise.reject(new Error("Starring requires the desktop app"));
  }
  return commands.ghRepoSetStarred(owner, repo, account, starred);
}

/** Subscribe or unsubscribe a repo. Returns the new subscription state. */
export function ghRepoSetWatched(
  owner: string,
  repo: string,
  account: string,
  watch: boolean,
): Promise<string> {
  if (!inTauri()) {
    return Promise.reject(new Error("Watching requires the desktop app"));
  }
  return commands.ghRepoSetWatched(owner, repo, account, watch);
}

/** Issue list with its total count for the repo screen Issues tab. */
export interface RepoIssueList {
  total: number;
  issues: RepoIssue[];
}

/** Issue list for the repo screen Issues tab as one stored account. */
export function ghRepoIssues(
  owner: string,
  repo: string,
  account: string,
  state: IssueState,
): Promise<RepoIssueList> {
  if (!inTauri()) {
    return Promise.reject(new Error("Loading issues requires the desktop app"));
  }
  return commands.ghRepoIssues(owner, repo, account, state).then((list) => ({
    total: list.total,
    issues: list.issues.map((row) => ({
      number: row.number,
      title: row.title,
      author: row.author,
      url: row.url,
      updatedAt: row.updated_at,
      comments: row.comments,
      labels: row.labels.map((label) => ({ name: label.name, color: label.color })),
    })),
  }));
}

/** Open issues assigned to the authenticated viewer. */
export function ghRepoAssignedIssues(owner: string, repo: string, account: string): Promise<RepoIssueList> {
  if (!inTauri()) {
    return Promise.reject(new Error("Loading assigned issues requires the desktop app"));
  }
  return commands.ghRepoAssignedIssues(owner, repo, account).then((list) => ({
    total: list.total,
    issues: list.issues.map((row) => ({
      number: row.number,
      title: row.title,
      author: row.author,
      url: row.url,
      updatedAt: row.updated_at,
      comments: row.comments,
      labels: row.labels.map((label) => ({ name: label.name, color: label.color })),
    })),
  }));
}

/** Pull request list with its total count for the repo screen Pulls tab. */
export interface RepoPullList {
  total: number;
  pulls: RepoPull[];
}

export interface RepoPull {
  number: number;
  title: string;
  author: string;
  url: string;
  updatedAt: string | null;
  comments: number;
  headBranch: string;
  baseBranch: string;
  merged: boolean;
  state: string;
}

export type RepoPage = "pulls" | "projects" | "wiki" | "security" | "insights" | "settings" | "issues" | "actions" | "issue" | "pull";

/** Pull request list for the repo screen Pulls tab as one stored account. */
export function ghRepoPulls(
  owner: string,
  repo: string,
  account: string,
  state: IssueState,
): Promise<RepoPullList> {
  if (!inTauri()) {
    return Promise.reject(new Error("Loading pull requests requires the desktop app"));
  }
  return commands.ghRepoPulls(owner, repo, account, state).then((list) => ({
    total: list.total,
    pulls: list.pulls.map((row) => ({
      number: row.number,
      title: row.title,
      author: row.author,
      url: row.url,
      updatedAt: row.updated_at,
      comments: row.comments,
      headBranch: row.head_branch,
      baseBranch: row.base_branch,
      merged: row.merged,
      state: row.state,
    })),
  }));
}

/** Open a GitHub repository page in the system browser as owner/repo. */
export function openGithubRepo(owner: string, repo: string): Promise<void> {
  if (!inTauri()) {
    return Promise.reject(new Error("Opening the repository requires the desktop app"));
  }
  return commands.ghOpenRepo(owner, repo).then(() => undefined);
}

/** Open a fixed repository page or pull request in the system browser. */
export function openGithubRepoPage(
  owner: string,
  repo: string,
  page: RepoPage,
  pullNumber?: number,
): Promise<void> {
  if (!inTauri()) {
    return Promise.reject(new Error("Opening a GitHub page requires the desktop app"));
  }
  return commands.ghOpenRepoPage(owner, repo, page, pullNumber ?? null).then(() => undefined);
}

/** Latest Actions runs for the repo screen Actions tab as one stored account. */
export function ghRepoRuns(owner: string, repo: string, account: string): Promise<RepoRun[]> {
  if (!inTauri()) {
    return Promise.reject(new Error("Loading workflow runs requires the desktop app"));
  }
  return commands.ghRepoRuns(owner, repo, account).then((rows) =>
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      branch: row.branch,
      sha: row.sha,
      message: row.message,
      actor: row.actor,
      actorAvatar: row.actor_avatar,
      status: row.status,
      conclusion: row.conclusion,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      url: row.url,
    })),
  );
}

/** Re-run the failed jobs of one Actions run as one stored account. */
export function ghRepoRerun(owner: string, repo: string, account: string, runId: number): Promise<void> {
  if (!inTauri()) {
    return Promise.reject(new Error("Re-running workflows requires the desktop app"));
  }
  return commands.ghRepoRerun(owner, repo, account, runId).then(() => undefined);
}

/** Fork a repo into the viewer's account. Returns the fork URL. */
export function ghRepoFork(owner: string, repo: string, account: string): Promise<string> {
  if (!inTauri()) {
    return Promise.reject(new Error("Forking requires the desktop app"));
  }
  return commands.ghRepoFork(owner, repo, account);
}

/** Branch selector data for the repo screen Code tab. */
export function gitRepoBranches(worktreePath: string): Promise<RepoBranches> {
  if (!inTauri()) {
    return Promise.reject(new Error("Listing branches requires the desktop app"));
  }
  return commands.gitRepoBranches(worktreePath).then((info) => ({
    current: info.current,
    branches: info.branches,
    tagCount: info.tag_count,
  }));
}

/** Latest commit on a ref for the repo screen latest-commit bar. */
export function gitRepoLatestCommit(worktreePath: string, gitref: string): Promise<RepoCommit> {
  if (!inTauri()) {
    return Promise.reject(new Error("Reading commits requires the desktop app"));
  }
  return commands.gitRepoLatestCommit(worktreePath, gitref);
}

/** File table of a ref and subdir with per-file history. */
export function gitRepoTree(
  worktreePath: string,
  gitref: string,
  subdir: string,
): Promise<RepoTreeEntry[]> {
  if (!inTauri()) {
    return Promise.reject(new Error("Reading the file table requires the desktop app"));
  }
  return commands.gitRepoTree(worktreePath, gitref, subdir);
}

/** Read a committed file from a ref for the Repository screen preview. */
export function gitRepoReadFile(
  worktreePath: string,
  gitref: string,
  path: string,
): Promise<number[]> {
  if (!inTauri()) {
    return Promise.reject(new Error("Reading repository files requires the desktop app"));
  }
  return commands.gitRepoReadFile(worktreePath, gitref, path);
}
