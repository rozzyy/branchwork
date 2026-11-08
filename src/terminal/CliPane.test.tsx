import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  output: null as ((event: { sessionId: string; data: number[] }) => void) | null,
  exit: null as ((event: { sessionId: string; exitCode: number | null; signal: string | null }) => void) | null,
  error: null as ((event: { sessionId: string; message: string }) => void) | null,
  input: null as ((data: string) => void) | null,
  writes: [] as number[][],
  terminals: [] as Array<{ cols: number; rows: number }>,
  setupOrder: [] as string[],
  attachCalls: [] as string[],
  deferredAttach: false,
  attachResolvers: [] as Array<() => void>,
  detachCalls: [] as string[],
  resizeCalls: [] as Array<{ sessionId: string; columns: number; rows: number }>,
  unlisteners: 0,
  terminalDisposals: 0,
  inputDisposals: 0,
  fitDisposals: 0,
  webglDisposals: 0,
  observerDisconnections: 0,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: { disableStdin?: boolean };

    constructor(options: { disableStdin?: boolean }) {
      this.options = options;
      mocks.terminals.push(this);
    }

    loadAddon() {}
    open() {}
    write(data: Uint8Array) {
      mocks.writes.push(Array.from(data));
    }
    onData(callback: (data: string) => void) {
      mocks.input = callback;
      return { dispose: () => { mocks.inputDisposals += 1; } };
    }
    dispose() {
      mocks.terminalDisposals += 1;
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    dispose() {
      mocks.fitDisposals += 1;
    }
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    dispose() {
      mocks.webglDisposals += 1;
    }
  },
}));

vi.mock("../ipc/pty", () => ({
  closeTerminal: vi.fn(),
  attachTerminal: vi.fn((sessionId: string, _attachmentId: number) => {
    mocks.setupOrder.push("attach");
    mocks.attachCalls.push(sessionId);
    if (!mocks.deferredAttach) return Promise.resolve();
    return new Promise<void>((resolve) => mocks.attachResolvers.push(resolve));
  }),
  detachTerminal: vi.fn((sessionId: string) => {
    mocks.detachCalls.push(sessionId);
    return Promise.resolve();
  }),
  onTerminalOutput: vi.fn((callback: typeof mocks.output) => {
    mocks.setupOrder.push("output");
    mocks.output = callback;
    return Promise.resolve(() => { mocks.unlisteners += 1; });
  }),
  onTerminalExit: vi.fn((callback: typeof mocks.exit) => {
    mocks.setupOrder.push("exit");
    mocks.exit = callback;
    return Promise.resolve(() => { mocks.unlisteners += 1; });
  }),
  onTerminalError: vi.fn((callback: typeof mocks.error) => {
    mocks.setupOrder.push("error");
    mocks.error = callback;
    return Promise.resolve(() => { mocks.unlisteners += 1; });
  }),
  resizeTerminal: vi.fn((sessionId: string, columns: number, rows: number) => {
    mocks.resizeCalls.push({ sessionId, columns, rows });
    return Promise.resolve();
  }),
  writeTerminal: vi.fn((_sessionId: string, data: Uint8Array) => {
    mocks.writes.push(Array.from(data));
    return Promise.resolve();
  }),
}));

import {
  attachTerminal,
  closeTerminal,
  detachTerminal,
  onTerminalError,
  onTerminalExit,
  onTerminalOutput,
  resizeTerminal,
  writeTerminal,
} from "../ipc/pty";
import { CliPane, resolveThemeColor } from "./CliPane";

const resizeCallbacks: ResizeObserverCallback[] = [];

class ResizeObserverStub {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback);
  }
  observe() {}
  disconnect() {
    mocks.observerDisconnections += 1;
  }
}

beforeEach(() => {
  Object.assign(mocks, {
    output: null,
    exit: null,
    error: null,
    input: null,
    writes: [],
    terminals: [],
    setupOrder: [],
    attachCalls: [],
    deferredAttach: false,
    attachResolvers: [],
    detachCalls: [],
    resizeCalls: [],
    unlisteners: 0,
    terminalDisposals: 0,
    inputDisposals: 0,
    fitDisposals: 0,
    webglDisposals: 0,
    observerDisconnections: 0,
  });
  resizeCallbacks.length = 0;
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderAttached(sessionId = "pty-1") {
  const view = render(<CliPane sessionId={sessionId} />);
  await waitFor(() => expect(attachTerminal).toHaveBeenCalledWith(sessionId, expect.any(Number)));
  return view;
}

describe("CliPane", () => {
  it("subscribes before attaching and renders only its session's output as bytes", async () => {
    await renderAttached();

    expect(onTerminalOutput).toHaveBeenCalled();
    expect(onTerminalExit).toHaveBeenCalled();
    expect(onTerminalError).toHaveBeenCalled();
    expect(mocks.setupOrder).toEqual(["output", "exit", "error", "attach"]);
    act(() => {
      mocks.output?.({ sessionId: "pty-2", data: [0x6e, 0x6f] });
      mocks.output?.({ sessionId: "pty-1", data: [0xe2, 0x82] });
      mocks.output?.({ sessionId: "pty-1", data: [0xac] });
    });

    expect(mocks.writes).toEqual([[0xe2, 0x82], [0xac]]);
  });

  it("resolves theme colors through the browser engine", () => {
    expect(resolveThemeColor("rgb(10, 20, 30)")).toMatch(/10,\s*20,\s*30/);
  });

  it("falls back to the raw value when the engine cannot resolve it", () => {
    expect(resolveThemeColor("not-a-color")).toBe("not-a-color");
    expect(resolveThemeColor("")).toBe("");
  });

  it("passes a resolved font stack without CSS variables to xterm", async () => {
    await renderAttached();
    const options = (mocks.terminals[0] as unknown as { options: { fontFamily: string } }).options;
    expect(options.fontFamily).not.toContain("var(");
    expect(options.fontFamily).toContain("monospace");
  });

  it("forwards input and debounces validated terminal resizing", async () => {
    await renderAttached();

    act(() => {
      mocks.input?.("echo\n");
      resizeCallbacks[0]?.([], {} as ResizeObserver);
      resizeCallbacks[0]?.([], {} as ResizeObserver);
    });
    await new Promise((resolve) => window.setTimeout(resolve, 150));

    expect(writeTerminal).toHaveBeenCalledWith("pty-1", new TextEncoder().encode("echo\n"));
    expect(resizeTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.resizeCalls).toEqual([{ sessionId: "pty-1", columns: 80, rows: 24 }]);
  });

  it("does not send invalid terminal dimensions to the PTY", async () => {
    await renderAttached();
    mocks.terminals[0].cols = 501;

    act(() => {
      resizeCallbacks[0]?.([], {} as ResizeObserver);
    });
    await new Promise((resolve) => window.setTimeout(resolve, 150));

    expect(resizeTerminal).not.toHaveBeenCalled();
  });

  it("surfaces exit and PTY errors and stops input after process exit", async () => {
    await renderAttached();

    act(() => {
      mocks.exit?.({ sessionId: "pty-2", exitCode: 0, signal: null });
      mocks.exit?.({ sessionId: "pty-1", exitCode: 23, signal: null });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Process exited with code 23");

    act(() => {
      mocks.input?.("ignored");
      mocks.error?.({ sessionId: "pty-2", message: "other session" });
      mocks.error?.({ sessionId: "pty-1", message: "reader failed" });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Terminal error: reader failed");
    expect(writeTerminal).not.toHaveBeenCalled();
  });

  it("disposes UI subscriptions without closing the PTY session", async () => {
    const view = await renderAttached();
    const lateInput = mocks.input;
    view.unmount();
    await waitFor(() => expect(detachTerminal).toHaveBeenCalledWith("pty-1", expect.any(Number)));
    lateInput?.("ignored after unmount");
    await new Promise((resolve) => window.setTimeout(resolve, 150));

    expect(mocks.unlisteners).toBe(3);
    expect(mocks.inputDisposals).toBe(1);
    expect(mocks.terminalDisposals).toBe(1);
    expect(mocks.fitDisposals).toBe(1);
    expect(mocks.webglDisposals).toBe(1);
    expect(mocks.observerDisconnections).toBe(1);
    expect(writeTerminal).not.toHaveBeenCalled();
    expect(resizeTerminal).not.toHaveBeenCalled();
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  it("uses an attachment token so stale cleanup cannot detach a newer view", async () => {
    mocks.deferredAttach = true;
    const first = render(<CliPane sessionId="pty-1" />);
    await waitFor(() => expect(attachTerminal).toHaveBeenCalledTimes(1));
    const firstAttachment = vi.mocked(attachTerminal).mock.calls[0][1];
    first.unmount();

    const second = render(<CliPane sessionId="pty-1" />);
    await waitFor(() => expect(attachTerminal).toHaveBeenCalledTimes(2));
    const secondAttachment = vi.mocked(attachTerminal).mock.calls[1][1];
    expect(secondAttachment).toBeGreaterThan(firstAttachment);

    await act(async () => {
      mocks.attachResolvers[1]();
      await Promise.resolve();
    });
    await act(async () => {
      mocks.attachResolvers[0]();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(detachTerminal).toHaveBeenCalledWith("pty-1", firstAttachment);
    });
    expect(detachTerminal).not.toHaveBeenCalledWith("pty-1", secondAttachment);

    second.unmount();
    await waitFor(() => {
      expect(detachTerminal).toHaveBeenCalledWith("pty-1", secondAttachment);
    });
  });
});
