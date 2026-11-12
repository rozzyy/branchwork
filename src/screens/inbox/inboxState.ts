export interface InboxState {
  dismissed: string[];
  snoozedUntil: Record<string, number>;
}

export const EMPTY_INBOX_STATE: InboxState = { dismissed: [], snoozedUntil: {} };
const MAX_INBOX_STATE_ENTRIES = 500;
const MAX_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
const ITEM_KEY = /^(?:agent:[A-Za-z0-9._-]{1,140}:(?:waiting|done)|github:[A-Za-z0-9-]{1,64}:\d{1,64})$/;

export function normalizeInboxState(value: unknown, now = Date.now()): InboxState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return EMPTY_INBOX_STATE;
  const saved = value as Record<string, unknown>;
  const dismissed = Array.isArray(saved.dismissed)
    ? [...new Set(saved.dismissed.filter((key): key is string => typeof key === "string" && ITEM_KEY.test(key)))].slice(-MAX_INBOX_STATE_ENTRIES)
    : [];
  const snoozedUntil: Record<string, number> = {};
  if (typeof saved.snoozedUntil === "object" && saved.snoozedUntil !== null && !Array.isArray(saved.snoozedUntil)) {
    for (const [key, until] of Object.entries(saved.snoozedUntil).slice(-MAX_INBOX_STATE_ENTRIES)) {
      if (ITEM_KEY.test(key) && typeof until === "number" && Number.isSafeInteger(until) && until > now && until <= now + MAX_SNOOZE_MS) {
        snoozedUntil[key] = until;
      }
    }
  }
  return { dismissed, snoozedUntil };
}

export function isInboxItemHidden(key: string, state: InboxState, now = Date.now()): boolean {
  return state.dismissed.includes(key) || (state.snoozedUntil[key] ?? 0) > now;
}

export function pruneDismissedAgents(state: InboxState, visibleAgentKeys: Set<string>): InboxState {
  const dismissed = state.dismissed.filter((key) => !key.startsWith("agent:") || visibleAgentKeys.has(key));
  return dismissed.length === state.dismissed.length ? state : { ...state, dismissed };
}
