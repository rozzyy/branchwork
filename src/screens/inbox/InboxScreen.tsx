import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { ghRateLimitStatus, openGithubRepoPage, type RepoRateLimit } from "../../ipc/repo";
import {
  ghNotifications,
  markAllGithubNotificationsRead,
  markGithubNotificationRead,
  type GithubNotification,
  type NotificationFailure,
} from "../../ipc/inbox";
import { loadSetting, saveSetting } from "../../ipc/settings";
import { useGithubAccounts } from "../../github/store";
import { useSessions, type AgentSession } from "../../agents/sessions";
import { CLI_REGISTRY } from "../../agents/registry";
import { useStage } from "../../state/stage";
import { useWorktrees } from "../../state/worktrees";
import { useRepos } from "../../state/repos";
import { Button } from "../../ui/Button";
import { toast } from "../../ui/toast";
import { errorMessage } from "../../ipc/errors";
import {
  EMPTY_INBOX_STATE,
  normalizeInboxState,
  pruneDismissedAgents,
  type InboxState,
} from "./inboxState";
import "./inbox.css";
import { attentionItems, type InboxAttention } from "../home/attention";

type InboxFilter = "all" | "review" | "mention" | "ci" | "agents";
type AgentEvent = { kind: "agent"; key: string; session: AgentSession; event: "waiting" | "done"; updatedAt: number };
type GithubEvent = { kind: "github"; key: string; notification: GithubNotification; updatedAt: number };
type InboxItem = AgentEvent | GithubEvent;

function isLowQuota(state: RepoRateLimit | null): boolean {
  return !!state?.limit && state.remaining != null && state.remaining < Math.ceil(state.limit / 10);
}

function retryTime(state: RepoRateLimit): string {
  const reset = state.reset_at ?? (state.retry_after ? Math.floor(Date.now() / 1000) + state.retry_after : null);
  return reset == null ? "soon" : new Date(reset * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function keyForGithub(notification: GithubNotification): string {
  return `github:${notification.account}:${notification.id}`;
}

function updatedEpoch(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function relativeTime(value: string | null | undefined): string {
  const epoch = updatedEpoch(value);
  if (!epoch) return "";
  const minutes = Math.floor(Math.max(0, Date.now() - epoch) / 60_000);
  if (minutes < 1) return t("inbox.relativeNow");
  if (minutes < 60) return t("inbox.relativeMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("inbox.relativeHours", { count: hours });
  return t("inbox.relativeDays", { count: Math.floor(hours / 24) });
}

export function InboxToolbar() {
  return <h1 className="pane-title">{t("inbox.title")}<span className="inbox-toolbar-subtitle">GitHub + agents</span></h1>;
}

export function InboxView() {
  const accounts = useGithubAccounts((state) => state.accounts);
  const accountLoaded = useGithubAccounts((state) => state.loaded);
  const sessions = useSessions((state) => state.sessions);
  const go = useStage((state) => state.go);
  const [batch, setBatch] = useState<{ notifications: GithubNotification[]; failures: NotificationFailure[] }>({
    notifications: [], failures: [],
  });
  const [quota, setQuota] = useState<RepoRateLimit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [state, setState] = useState<InboxState>(EMPTY_INBOX_STATE);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailOnNarrow, setDetailOnNarrow] = useState(false);
  const [snoozeClock, setSnoozeClock] = useState(0);
  const refreshGeneration = useRef(0);

  useEffect(() => {
    let live = true;
    void loadSetting<unknown>("inboxState").then((saved) => {
      if (!live) return;
      setState(normalizeInboxState(saved));
      setStateLoaded(true);
    });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (stateLoaded) void saveSetting("inboxState", state).catch((failure: unknown) => {
      toast({ title: errorMessage(failure), icon: "⚠" });
    });
  }, [state, stateLoaded]);

  const nextSnooze = useMemo(
    () => Object.values(state.snoozedUntil).reduce<number | null>((soonest, until) =>
      until > Date.now() && (soonest == null || until < soonest) ? until : soonest, null),
    [state.snoozedUntil, snoozeClock],
  );
  useEffect(() => {
    if (nextSnooze == null) return;
    const timer = window.setTimeout(() => setSnoozeClock(Date.now()), Math.max(0, nextSnooze - Date.now() + 1));
    return () => window.clearTimeout(timer);
  }, [nextSnooze]);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setRefreshing(true);
    setError(null);
    try {
      const nextQuota = await ghRateLimitStatus().catch(() => null);
      if (generation !== refreshGeneration.current) return;
      setQuota(nextQuota);
      if (isLowQuota(nextQuota)) return;
      if (accounts.length === 0) {
        setBatch({ notifications: [], failures: [] });
        return;
      }
      const nextBatch = await ghNotifications(accounts.slice(0, 8));
      if (accounts.length > 8) {
        nextBatch.failures.push(...accounts.slice(8, 508).map((account) => ({
          account,
          message: t("inbox.accountLimit"),
        })));
      }
      if (generation === refreshGeneration.current) setBatch(nextBatch);
    } catch (failure) {
      if (generation === refreshGeneration.current) setError(errorMessage(failure));
    } finally {
      if (generation === refreshGeneration.current) setRefreshing(false);
    }
  }, [accounts, refreshGeneration]);

  useEffect(() => () => { refreshGeneration.current += 1; }, [refreshGeneration]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 300_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!accountLoaded) void useGithubAccounts.getState().load();
  }, [accountLoaded]);
  useEffect(() => {
    if (!useSessions.getState().loaded) void useSessions.getState().load();
  }, []);

  const agentEvents = useMemo<AgentEvent[]>(() => {
    const events: AgentEvent[] = [];
    for (let index = sessions.length - 1; index >= 0 && events.length < 500; index -= 1) {
      const session = sessions[index];
      if (session.status !== "waiting" && session.status !== "done") continue;
      events.push({
        kind: "agent",
        key: `agent:${session.id}:${session.status}`,
        session,
        event: session.status,
        updatedAt: 0,
      });
    }
    return events.reverse();
  }, [sessions]);

  useEffect(() => {
    setState((current) => pruneDismissedAgents(current, new Set(agentEvents.map((event) => event.key))));
  }, [agentEvents]);

  const dismissedKeys = useMemo(() => new Set(state.dismissed), [state.dismissed]);
  const allItems = useMemo<InboxItem[]>(() => [
    ...batch.notifications.map((notification) => ({
      kind: "github" as const,
      key: keyForGithub(notification),
      notification,
      updatedAt: updatedEpoch(notification.updatedAt),
    })),
    ...agentEvents,
  ].filter((item) => !dismissedKeys.has(item.key) && (state.snoozedUntil[item.key] ?? 0) <= Date.now())
    .sort((left, right) => right.updatedAt - left.updatedAt),
  [agentEvents, batch.notifications, dismissedKeys, snoozeClock, state.snoozedUntil]);
  const attentionOrder = useMemo(() => {
    const inbox: InboxAttention[] = allItems.map((item) => item.kind === "agent"
      ? { id:item.key, kind:"agent", title:t(item.event === "waiting" ? "inbox.agentWaiting" : "inbox.agentDone", {agent:CLI_REGISTRY[item.session.cliId].name}), meta:item.session.worktreePath, at:item.updatedAt }
      : { id:item.key, kind:item.notification.reason === "review_requested" ? "review" : item.notification.reason === "mention" || item.notification.reason === "team_mention" ? "mention" : item.notification.reason === "ci_activity" ? "ci" : "review", title:item.notification.title, meta:`${item.notification.owner}/${item.notification.repo}`, at:item.updatedAt });
    return new Map(attentionItems(inbox, []).map((item, index) => [item.id, index]));
  }, [allItems]);

  const visibleItems = useMemo(() => allItems.filter((item) => {
    if (filter === "agents") return item.kind === "agent";
    if (item.kind !== "github") return filter === "all";
    if (filter === "review") return item.notification.reason === "review_requested";
    if (filter === "mention") return item.notification.reason === "mention" || item.notification.reason === "team_mention";
    if (filter === "ci") return item.notification.reason === "ci_activity";
    return true;
  }).sort((a,b) => (attentionOrder.get(a.key) ?? 0) - (attentionOrder.get(b.key) ?? 0)), [allItems, filter, attentionOrder]);
  const selectedItem = useMemo(
    () => visibleItems.find((item) => item.key === selectedKey) ?? visibleItems[0] ?? null,
    [visibleItems, selectedKey],
  );
  useEffect(() => { if (selectedItem && selectedItem.key !== selectedKey) setSelectedKey(selectedItem.key); }, [selectedItem, selectedKey]);

  const markDone = async (item: InboxItem) => {
    if (item.kind === "agent") {
      setState((current) => ({ ...current, dismissed: [...current.dismissed.filter((key) => key !== item.key), item.key].slice(-500) }));
      return;
    }
    const previous = batch.notifications.find((row) => keyForGithub(row) === item.key)?.unread ?? false;
    setBatch((current) => ({
      ...current,
      notifications: current.notifications.map((row) => keyForGithub(row) === item.key ? { ...row, unread: false } : row),
    }));
    try {
      await markGithubNotificationRead(item.notification.account, item.notification.id);
    } catch (failure) {
      setBatch((current) => ({
        ...current,
        notifications: current.notifications.map((row) => keyForGithub(row) === item.key ? { ...row, unread: previous } : row),
      }));
      toast({ title: errorMessage(failure), icon: "⚠" });
    }
  };

  const markAllRead = async () => {
    const accountsToRead = [...new Set(batch.notifications.filter((row) => row.unread).map((row) => row.account))];
    const results = await Promise.allSettled(accountsToRead.map((account) => markAllGithubNotificationsRead(account)));
    const successful = new Set(accountsToRead.filter((_account, index) => results[index].status === "fulfilled"));
    setBatch((current) => ({
      ...current,
      notifications: current.notifications.map((row) => successful.has(row.account) ? { ...row, unread: false } : row),
    }));
    const agentKeys = agentEvents.map((event) => event.key);
    setState((current) => ({ ...current, dismissed: [...new Set([...current.dismissed, ...agentKeys])].slice(-500) }));
    if (results.some((result) => result.status === "rejected")) {
      toast({ title: t("inbox.partialReadError"), icon: "⚠" });
    }
  };

  const snooze = (item: InboxItem) => {
    setState((current) => ({
      ...current,
      snoozedUntil: { ...current.snoozedUntil, [item.key]: Date.now() + 24 * 60 * 60 * 1000 },
    }));
  };

  const openItem = (item: InboxItem) => {
    if (item.kind === "github") {
      void openGithubRepoPage(
        item.notification.owner,
        item.notification.repo,
        item.notification.page,
        item.notification.number ?? undefined,
      ).catch((failure: unknown) => toast({ title: errorMessage(failure), icon: "⚠" }));
      return;
    }
    if (item.event === "done") {
      void (async () => {
        const path = item.session.worktreePath;
        const repos = useRepos.getState();
        const project = [...repos.projects].filter((candidate) => path === candidate.localPath || path.startsWith(candidate.localPath.replace(/\/$/, "") + "/"))
          .sort((a,b) => b.localPath.length-a.localPath.length)[0];
        if (project && project.id !== repos.activeProjectId) {
          repos.selectProject(project.id);
          if (useRepos.getState().activeProjectId !== project.id) return;
          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(() => { stop(); resolve(); }, 5000);
            const stop = useWorktrees.subscribe((state) => {
              if (state.projectId !== project.id || state.loading) return;
              window.clearTimeout(timer);
              stop();
              resolve();
            });
          });
        }
        useWorktrees.getState().select(path);
        if (useWorktrees.getState().activePath !== path) return;
        useStage.getState().setLayout(["agents", "changes"]);
      })();
      return;
    }
    const session = useSessions.getState().sessions.find((candidate) => candidate.id === item.session.id);
    if (session && session.slot !== "full") useSessions.getState().toggleSlot(session.id, "full");
    go("agents");
  };

  const retryLabel = quota && isLowQuota(quota)
    ? t("inbox.rateLimit").replace("{time}", retryTime(quota))
    : null;

  return (
    <section className="inbox-screen" aria-label={t("inbox.title")}>
      <header className="inbox-header"><p className="inbox-summary">{t("inbox.summary", { count: visibleItems.length })}</p>
        <div className="inbox-actions">
          <Button size="sm" variant="ghost" onClick={() => void markAllRead()} disabled={refreshing || (!batch.notifications.some((row) => row.unread) && !agentEvents.length)}>{t("inbox.readAll")}</Button>
          <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? t("inbox.refreshing") : t("inbox.refresh")}</Button>
        </div>
      </header>
      <nav className="inbox-filters" aria-label={t("inbox.filters")}>
        {(["all", "review", "mention", "ci", "agents"] as const).map((value) => <button key={value} type="button" className={filter === value ? "inbox-filter on" : "inbox-filter"} aria-pressed={filter === value} onClick={() => { setFilter(value); setDetailOnNarrow(false); }}>{t(`inbox.filter.${value}`)}</button>)}
      </nav>
      <div className={`inbox-split${detailOnNarrow ? " detail-on-narrow" : ""}`}>
        <div className="inbox-list" aria-label={t("inbox.title")}>
          {retryLabel && <p className="inbox-status" role="status">{retryLabel}</p>}
          {error && <p className="inbox-error" role="alert">{error}</p>}
          {batch.failures.map((failure) => <p className="inbox-error" role="alert" key={failure.account}>{t("inbox.accountError", { account: failure.account, message: failure.message })}</p>)}
          {refreshing && allItems.length === 0 ? <p className="inbox-empty" role="status">{t("inbox.loading")}</p> : visibleItems.length === 0 ? <div className="inbox-empty"><span aria-hidden="true">◉</span><p>{t("inbox.empty")}</p></div> : visibleItems.map((item) => {
            const title = item.kind === "github" ? item.notification.title : t(item.event === "waiting" ? "inbox.agentWaiting" : "inbox.agentDone", { agent: CLI_REGISTRY[item.session.cliId].name });
            const subtitle = item.kind === "github" ? `${item.notification.owner}/${item.notification.repo} · ${item.notification.reason.replaceAll("_", " ")}` : `${item.session.profile.slug} · ${item.session.worktreePath.split("/").filter(Boolean).pop() ?? item.session.worktreePath}`;
            const unread = item.kind === "agent" ? item.event === "waiting" : item.notification.unread;
            const age = item.kind === "github" ? relativeTime(item.notification.updatedAt) : t("inbox.agentSource");
            return <article className={`inbox-item${unread ? " unread" : ""}${selectedItem?.key === item.key ? " selected" : ""}`} key={item.key}>
              <button type="button" className="inbox-item-select" aria-label={title} aria-current={selectedItem?.key === item.key ? "true" : undefined} onClick={() => { setSelectedKey(item.key); setDetailOnNarrow(true); }}>
                <span className={`inbox-item-icon ${item.kind}`} aria-hidden="true">{item.kind === "agent" ? "✦" : item.notification.page === "actions" ? "↻" : "◉"}</span><span className="inbox-item-copy"><strong>{title}</strong><span>{subtitle}</span><small>{age}</small></span>{unread && <i className="inbox-unread-dot" aria-label="Unread" />}
              </button>
              <div className="inbox-item-actions"><Button size="sm" variant="ghost" aria-label={t("inbox.markDone")} title={t("inbox.markDone")} onClick={() => void markDone(item)}>✓</Button><Button size="sm" variant="ghost" aria-label={t("inbox.snooze")} title={t("inbox.snooze")} onClick={() => snooze(item)}>◷</Button></div>
            </article>;
          })}
        </div>
        <article className="inbox-detail">
          {selectedItem ? <>
            <Button className="inbox-back" size="sm" variant="ghost" onClick={() => setDetailOnNarrow(false)}>← {t("inbox.backToList")}</Button>
            <span className={`inbox-detail-icon ${selectedItem.kind}`} aria-hidden="true">{selectedItem.kind === "agent" ? "✦" : selectedItem.notification.page === "actions" ? "↻" : "◉"}</span>
            <h2>{selectedItem.kind === "github" ? selectedItem.notification.title : t(selectedItem.event === "waiting" ? "inbox.agentWaiting" : "inbox.agentDone", { agent: CLI_REGISTRY[selectedItem.session.cliId].name })}</h2>
            <p>{selectedItem.kind === "github" ? `${selectedItem.notification.owner}/${selectedItem.notification.repo} · ${selectedItem.notification.reason.replaceAll("_", " ")}` : `${selectedItem.session.profile.slug} · ${selectedItem.session.worktreePath}`}</p>
            <small>{selectedItem.kind === "github" ? relativeTime(selectedItem.notification.updatedAt) : t("inbox.agentSource")}</small>
            <div className="inbox-detail-actions"><Button size="sm" onClick={() => openItem(selectedItem)}>{selectedItem.kind === "agent" ? selectedItem.event === "done" ? t("inbox.reviewChanges") : t("inbox.replyAgent") : selectedItem.notification.page === "pull" || selectedItem.notification.page === "pulls" ? t("inbox.reviewNow") : selectedItem.notification.page === "actions" ? t("inbox.viewWorkflow") : t("inbox.openThread")}</Button>{(selectedItem.kind === "agent" || selectedItem.notification.unread) && <Button size="sm" variant="ghost" onClick={() => void markDone(selectedItem)}>{t("inbox.markDone")}</Button>}</div>
          </> : <div className="inbox-empty"><span aria-hidden="true">◉</span><p>{t("inbox.empty")}</p></div>}
        </article>
      </div>
    </section>
  );
}
