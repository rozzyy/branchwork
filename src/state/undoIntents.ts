export type UndoLastIntent = { type: "undo.last"; worktree: string };

/** Task 14 replaces this intent bridge with the persisted `undo_last` IPC call. */
export function undoLast(worktree: string): void {
  window.dispatchEvent(
    new CustomEvent("branchwork:undo-last", {
      detail: { type: "undo.last", worktree } satisfies UndoLastIntent,
    }),
  );
}
