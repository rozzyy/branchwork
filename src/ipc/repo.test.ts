import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  ghRepoContributors,
  ghRateLimitStatus,
  invalidateRepoCache,
  ghRepoFork,
  ghRepoIssues,
  ghRepoAssignedIssues,
  ghRepoMeta,
  ghRepoPulls,
  ghRepoRemote,
  ghRepoRerun,
  ghRepoRuns,
  ghRepoSetStarred,
  ghRepoSetWatched,
  gitRepoBranches,
  gitRepoLatestCommit,
  gitRepoReadFile,
  gitRepoTree,
  openGithubRepo,
  openGithubRepoPage,
} from "./repo";

afterEach(() => clearMocks());

it("rejects repo commands outside Tauri", async () => {
  await expect(ghRepoRemote("/wt/a")).rejects.toThrow("desktop app");
  await expect(ghRepoMeta("o", "r", "octocat")).rejects.toThrow("desktop app");
  await expect(ghRepoContributors("o", "r", "octocat")).rejects.toThrow("desktop app");
  await expect(ghRepoSetStarred("o", "r", "octocat", true)).rejects.toThrow("desktop app");
  await expect(ghRepoSetWatched("o", "r", "octocat", true)).rejects.toThrow("desktop app");
  await expect(ghRepoFork("o", "r", "octocat")).rejects.toThrow("desktop app");
  await expect(ghRepoIssues("o", "r", "octocat", "open")).rejects.toThrow("desktop app");
  await expect(ghRepoAssignedIssues("o", "r", "octocat")).rejects.toThrow("desktop app");
  await expect(ghRepoPulls("o", "r", "octocat", "open")).rejects.toThrow("desktop app");
  await expect(openGithubRepo("o", "r")).rejects.toThrow("desktop app");
  await expect(openGithubRepoPage("o", "r", "projects")).rejects.toThrow("desktop app");
  await expect(ghRepoRuns("o", "r", "octocat")).rejects.toThrow("desktop app");
  await expect(ghRepoRerun("o", "r", "octocat", 99)).rejects.toThrow("desktop app");
  await expect(invalidateRepoCache("o", "r", "octocat")).rejects.toThrow("desktop app");
  await expect(ghRateLimitStatus()).rejects.toThrow("desktop app");
  await expect(gitRepoBranches("/wt/a")).rejects.toThrow("desktop app");
  await expect(gitRepoLatestCommit("/wt/a", "main")).rejects.toThrow("desktop app");
  await expect(gitRepoTree("/wt/a", "main", "")).rejects.toThrow("desktop app");
  await expect(gitRepoReadFile("/wt/a", "main", "README.md")).rejects.toThrow("desktop app");
});

it("routes repo commands through generated IPC bindings", async () => {
  mockWindows("main");
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "gh_repo_remote") {
      return { owner: "o", repo: "r", url: "git@github.com:o/r.git" };
    }
    if (command === "gh_repo_meta") {
      return {
        id: "R_1",
        is_private: false,
        description: "Demo",
        homepage_url: null,
        topics: ["rust"],
        license: "MIT",
        stars: 42,
        forks: 7,
        watchers: 5,
        viewer_starred: false,
        viewer_subscription: "UNSUBSCRIBED",
        default_branch: "main",
        releases: [
          {
            name: "v1.0",
            tag: "v1.0.0",
            published_at: "2026-01-01T00:00:00Z",
            draft: false,
            is_latest: true,
            url: "https://github.com/o/r/releases/v1.0.0",
          },
        ],
        languages: [{ name: "Rust", color: "#dea584", size: 900 }],
      };
    }
    if (command === "gh_repo_contributors") {
      return [{ login: "octocat", contributions: 120, avatar_url: "https://a/u/1" }];
    }
    if (command === "gh_repo_set_starred") return true;
    if (command === "gh_repo_set_watched") return "SUBSCRIBED";
    if (command === "gh_repo_fork") return "https://github.com/octocat/r";
    if (command === "git_repo_branches") {
      return { current: "main", branches: ["main"], tag_count: 2 };
    }
    if (command === "git_repo_latest_commit") {
      return { hash: "abc", message: "hi", author: "octocat", epoch: 42 };
    }
    if (command === "git_repo_tree") {
      return [{ name: "a.txt", kind: "file", message: "hi", epoch: 42 }];
    }
    if (command === "git_repo_read_file") return Array.from(new TextEncoder().encode("# main"));
    if (command === "gh_repo_runs") {
      return [
        {
          id: 99,
          name: "CI",
          branch: "main",
          sha: "abc123",
          message: "Fix it",
          actor: "octocat",
          actor_avatar: "https://a/u/1",
          status: "completed",
          conclusion: "failure",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          url: "https://github.com/o/r/actions/runs/99",
        },
      ];
    }
    if (command === "gh_repo_rerun") return undefined;
    if (command === "gh_repo_issues") {
      return {
        total: 1,
        issues: [
          {
            number: 12,
            title: "Fix it",
            author: "octocat",
            url: "https://github.com/o/r/issues/12",
            updated_at: "2026-01-02T00:00:00Z",
            comments: 3,
            labels: [{ name: "bug", color: "d73a4a" }],
          },
        ],
      };
    }
    if (command === "gh_repo_assigned_issues") return { total: 1, issues: [{
      number: 12, title: "Fix it", author: "octocat", url: "https://github.com/o/r/issues/12",
      updated_at: "2026-01-02T00:00:00Z", comments: 3, labels: [{ name: "bug", color: "d73a4a" }],
    }] };
    if (command === "gh_repo_pulls") {
      return {
        total: 1,
        pulls: [
          {
            number: 7,
            title: "Add auth",
            author: "octocat",
            url: "https://github.com/o/r/pull/7",
            updated_at: "2026-01-02T00:00:00Z",
            comments: 2,
            head_branch: "feat/auth",
            base_branch: "main",
            merged: false,
            state: "OPEN",
          },
        ],
      };
    }
    if (command === "gh_open_repo") return undefined;
    if (command === "gh_open_repo_page") return undefined;
    if (command === "gh_repo_cache_invalidate") return undefined;
    if (command === "gh_rate_limit_status") return { limit: 5000, remaining: 200, reset_at: 1_800_000_000, retry_after: null };
    throw new Error(`unexpected ${command}`);
  });

  await expect(ghRepoRemote("/wt/a")).resolves.toEqual({
    owner: "o",
    repo: "r",
    url: "git@github.com:o/r.git",
  });
  await expect(invalidateRepoCache("o", "r", "octocat")).resolves.toBeUndefined();
  await expect(ghRateLimitStatus()).resolves.toMatchObject({ limit: 5000, remaining: 200 });
  const meta = await ghRepoMeta("o", "r", "octocat");
  expect(meta.homepageUrl).toBeNull();
  expect(meta.viewerStarred).toBe(false);
  expect(meta.defaultBranch).toBe("main");
  expect(meta.isPrivate).toBe(false);
  expect(meta.releases[0]).toMatchObject({ tag: "v1.0.0", draft: false, isLatest: true });
  expect(meta.languages[0]).toMatchObject({ name: "Rust", size: 900 });
  await expect(ghRepoContributors("o", "r", "octocat")).resolves.toEqual([
    { login: "octocat", contributions: 120, avatarUrl: "https://a/u/1" },
  ]);
  await expect(ghRepoSetStarred("o", "r", "octocat", true)).resolves.toBe(true);
  await expect(ghRepoSetWatched("o", "r", "octocat", true)).resolves.toBe("SUBSCRIBED");
  await expect(ghRepoFork("o", "r", "octocat")).resolves.toBe("https://github.com/octocat/r");
  await expect(gitRepoBranches("/wt/a")).resolves.toEqual({
    current: "main",
    branches: ["main"],
    tagCount: 2,
  });
  await expect(gitRepoLatestCommit("/wt/a", "main")).resolves.toMatchObject({ hash: "abc" });
  await expect(gitRepoTree("/wt/a", "main", "")).resolves.toEqual([
    { name: "a.txt", kind: "file", message: "hi", epoch: 42 },
  ]);
  await expect(gitRepoReadFile("/wt/a", "main", "README.md")).resolves.toEqual(
    Array.from(new TextEncoder().encode("# main")),
  );
  await expect(ghRepoIssues("o", "r", "octocat", "open")).resolves.toEqual({
    total: 1,
    issues: [
      {
        number: 12,
        title: "Fix it",
        author: "octocat",
        url: "https://github.com/o/r/issues/12",
        updatedAt: "2026-01-02T00:00:00Z",
        comments: 3,
        labels: [{ name: "bug", color: "d73a4a" }],
      },
    ],
  });
  await expect(ghRepoAssignedIssues("o", "r", "octocat")).resolves.toMatchObject({ total: 1, issues: [{ number: 12 }] });
  await expect(ghRepoPulls("o", "r", "octocat", "open")).resolves.toEqual({
    total: 1,
    pulls: [
      {
        number: 7,
        title: "Add auth",
        author: "octocat",
        url: "https://github.com/o/r/pull/7",
        updatedAt: "2026-01-02T00:00:00Z",
        comments: 2,
        headBranch: "feat/auth",
        baseBranch: "main",
        merged: false,
        state: "OPEN",
      },
    ],
  });
  await expect(openGithubRepo("o", "r")).resolves.toBeUndefined();
  await expect(openGithubRepoPage("o", "r", "projects")).resolves.toBeUndefined();
  await expect(openGithubRepoPage("o", "r", "pull", 7)).resolves.toBeUndefined();
  await expect(ghRepoRuns("o", "r", "octocat")).resolves.toEqual([
    {
      id: 99,
      name: "CI",
      branch: "main",
      sha: "abc123",
      message: "Fix it",
      actor: "octocat",
      actorAvatar: "https://a/u/1",
      status: "completed",
      conclusion: "failure",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      url: "https://github.com/o/r/actions/runs/99",
    },
  ]);
  await expect(ghRepoRerun("o", "r", "octocat", 99)).resolves.toBeUndefined();
  expect(calls.map((call) => call.command)).toEqual([
    "gh_repo_remote",
    "gh_repo_cache_invalidate",
    "gh_rate_limit_status",
    "gh_repo_meta",
    "gh_repo_contributors",
    "gh_repo_set_starred",
    "gh_repo_set_watched",
    "gh_repo_fork",
    "git_repo_branches",
    "git_repo_latest_commit",
    "git_repo_tree",
    "git_repo_read_file",
    "gh_repo_issues",
    "gh_repo_assigned_issues",
    "gh_repo_pulls",
    "gh_open_repo",
    "gh_open_repo_page",
    "gh_open_repo_page",
    "gh_repo_runs",
    "gh_repo_rerun",
  ]);
});
