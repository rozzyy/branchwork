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

type InboxFilter = "all" | "github" | "agents" | "unread";
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

export function InboxToolbar() {
  return <h1 className="pane-title">{t("inbox.title")}</h1>;
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
  const [snoozeHours, setSnoozeHours] = useState<Record<string, number>>({});
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

  const visibleItems = allItems.filter((item) => {
    if (filter === "github") return item.kind === "github";
    if (filter === "agents") return item.kind === "agent";
    if (filter === "unread") return item.kind === "agent" ? item.event === "waiting" : item.notification.unread;
    return true;
  });

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
    const agentKeys = visibleItems.filter((item): item is AgentEvent => item.kind === "agent").map((event) => event.key);
    setState((current) => ({ ...current, dismissed: [...new Set([...current.dismissed, ...agentKeys])].slice(-500) }));
    if (results.some((result) => result.status === "rejected")) {
      toast({ title: t("inbox.partialReadError"), icon: "⚠" });
    }
  };

  const snooze = (item: InboxItem) => {
    const hours = snoozeHours[item.key] ?? 1;
    setState((current) => ({
      ...current,
      snoozedUntil: { ...current.snoozedUntil, [item.key]: Date.now() + hours * 60 * 60 * 1000 },
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
    const session = useSessions.getState().sessions.find((candidate) => candidate.id === item.session.id);
    if (session && session.slot !== "full") useSessions.getState().toggleSlot(session.id, "full");
    go("agents");
  };

  const retryLabel = quota && isLowQuota(quota)
    ? t("inbox.rateLimit").replace("{time}", retryTime(quota))
    : null;

  return (
    <section className="inbox-screen" aria-label={t("inbox.title")}>
      <header className="inbox-header">
        <div>
          <p className="inbox-summary">{t("inbox.summary", { count: visibleItems.length })}</p>
        </div>
        <div className="inbox-actions">
          <Button size="sm" variant="ghost" onClick={() => void markAllRead()} disabled={refreshing || (!batch.notifications.some((row) => row.unread) && !visibleItems.some((item) => item.kind === "agent"))}>
            {t("inbox.readAll")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? t("inbox.refreshing") : t("inbox.refresh")}
          </Button>
        </div>
      </header>
      <nav className="inbox-filters" aria-label={t("inbox.filters")}>
        {(["all", "github", "agents", "unread"] as const).map((value) => (
          <button key={value} type="button" className={filter === value ? "inbox-filter on" : "inbox-filter"} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {t(`inbox.filter.${value}`)}
          </button>
        ))}
      </nav>
      {retryLabel && <p className="inbox-status" role="status">{retryLabel}</p>}
      {error && <p className="inbox-error" role="alert">{error}</p>}
      {batch.failures.map((failure) => <p className="inbox-error" role="alert" key={failure.account}>{t("inbox.accountError", { account: failure.account, message: failure.message })}</p>)}
      {refreshing && allItems.length === 0 ? (
        <p className="inbox-empty" role="status">{t("inbox.loading")}</p>
      ) : visibleItems.length === 0 ? (
        <div className="inbox-empty"><span aria-hidden="true">◉</span><p>{t("inbox.empty")}</p></div>
      ) : (
        <div className="inbox-list">
          {visibleItems.map((item) => {
            const title = item.kind === "github" ? item.notification.title : t(item.event === "waiting" ? "inbox.agentWaiting" : "inbox.agentDone", { agent: CLI_REGISTRY[item.session.cliId].name });
            const subtitle = item.kind === "github"
              ? `${item.notification.owner}/${item.notification.repo} · ${item.notification.reason.replaceAll("_", " ")}`
              : `${item.session.profile.slug} · ${item.session.worktreePath.split("/").filter(Boolean).pop() ?? item.session.worktreePath}`;
            const unread = item.kind === "agent" ? item.event === "waiting" : item.notification.unread;
            return (
              <article className={"inbox-item" + (unread ? " unread" : "")} key={item.key}>
                <span className={"inbox-item-icon " + (item.kind === "agent" ? "agent" : "github")} aria-hidden="true">{item.kind === "agent" ? "✦" : "◉"}</span>
                <div className="inbox-item-copy">
                  <strong>{title}</strong>
                  <span>{subtitle}</span>
                  <small>{item.kind === "github" ? (item.notification.updatedAt ?? "") : t("inbox.agentSource")}</small>
                </div>
                <div className="inbox-item-actions">
                  <Button size="sm" onClick={() => openItem(item)}>{item.kind === "github" ? t("inbox.openGithub") : t("inbox.openAgent")}</Button>
                  {(unread || item.kind === "agent") && <Button size="sm" variant="ghost" onClick={() => void markDone(item)}>{t("inbox.markDone")}</Button>}
                  <label className="inbox-snooze-select">
                    <span className="sr-only">{t("inbox.snoozeDuration")}</span>
                    <select aria-label={t("inbox.snoozeDuration")} value={snoozeHours[item.key] ?? 1} onChange={(event) => setSnoozeHours((current) => Object.fromEntries([...Object.entries(current).slice(-499), [item.key, Number(event.target.value)]]))}>
                      <option value={1}>{t("inbox.oneHour")}</option>
                      <option value={24}>{t("inbox.oneDay")}</option>
                      <option value={168}>{t("inbox.oneWeek")}</option>
                    </select>
                  </label>
                  <Button size="sm" variant="ghost" onClick={() => snooze(item)}>{t("inbox.snooze")}</Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
