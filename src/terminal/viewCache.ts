// Disposal registry for live xterm views, keyed by PTY session id.
//
// CliPane keeps its rendered terminal across unmounts (tab and page
// switches re-adopt the view instead of starting blank; the backend replays
// only output produced while detached). The cached view must be dropped when
// its session is explicitly closed or replaced, otherwise the xterm instance
// (and its WebGL context) leaks. Stores call disposeTerminalView() on those
// owner paths; this module stays free of xterm imports so stores can use it
// without pulling the terminal runtime into store unit tests.
const disposers = new Map<string, () => void>();

export function registerTerminalDisposer(sessionId: string, dispose: () => void): void {
  disposers.set(sessionId, dispose);
}

export function disposeTerminalView(sessionId: string): void {
  const dispose = disposers.get(sessionId);
  if (!dispose) return;
  disposers.delete(sessionId);
  try {
    dispose();
  } catch {
    // The view is already gone; the PTY close on the same path owns cleanup.
  }
}
