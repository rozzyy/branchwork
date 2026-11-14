export type AttentionKind = "review" | "mention" | "ci" | "agent" | "conflict";
export interface AttentionItem { id: string; kind: AttentionKind; title: string; meta: string; at: number }
export interface InboxAttention { id: string; kind: Exclude<AttentionKind,"conflict">; title: string; meta: string; at: number }
export interface ConflictAttention { worktree: string; count: number; title?: string; meta?: string }

/** Sort newest first while keeping conflict worktrees pinned above inbox events. */
export function attentionItems(inbox: InboxAttention[], conflicts: ConflictAttention[]): AttentionItem[] {
  const pinned = conflicts.filter((item) => item.count > 0).map((item): AttentionItem => ({
    id: `conflict:${item.worktree}`, kind:"conflict", title:item.title ?? item.worktree,
    meta:item.meta ?? `${item.count} conflicts`, at:Number.MAX_SAFE_INTEGER,
  }));
  const events = inbox.map((item) => ({...item})).sort((a,b) => b.at-a.at);
  return [...pinned, ...events];
}
