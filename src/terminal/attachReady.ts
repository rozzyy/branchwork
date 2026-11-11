const waiters = new Map<string, { promise: Promise<void>; resolve: () => void }>();

/** Register before rendering a PTY pane so its first command can wait for attach. */
export function waitForTerminalAttach(sessionId: string): Promise<void> {
  let waiter = waiters.get(sessionId);
  if (!waiter) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    waiter = { promise, resolve };
    waiters.set(sessionId, waiter);
  }
  return waiter.promise;
}

export function markTerminalAttached(sessionId: string): void {
  const waiter = waiters.get(sessionId);
  if (!waiter) return;
  waiters.delete(sessionId);
  waiter.resolve();
}
