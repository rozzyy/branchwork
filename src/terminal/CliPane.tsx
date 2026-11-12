import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { t } from "../i18n/t";
import {
  attachTerminal,
  detachTerminal,
  onTerminalError,
  onTerminalExit,
  onTerminalOutput,
  resizeTerminal,
  writeTerminal,
  type PtyErrorEvent,
  type PtyExit,
  type PtyOutput,
} from "../ipc/pty";
import { errorMessage } from "../ipc/errors";
import { markTerminalAttached } from "./attachReady";
import { dropPositionIsInside, formatDroppedPaths } from "./fileDrop";
import "./terminal.css";
import "@xterm/xterm/css/xterm.css";

const MIN_DIMENSION = 1;
const MAX_DIMENSION = 500;
const RESIZE_DEBOUNCE_MS = 120;
// xterm.js rasterizes and measures glyphs on canvas, where `var()` in a font
// string is rejected (proven in Chromium and WebKit: the previous font is kept,
// so the atlas and cell metrics silently use the wrong font). Resolve the token
// to a concrete stack. The fallback matches --font-mono in src/theme/tokens.css.
const FALLBACK_MONO_FONT = '"SF Mono", ui-monospace, Menlo, monospace';

function monoFontFamily(container: HTMLElement): string {
  return getComputedStyle(container).getPropertyValue("--font-mono").trim() || FALLBACK_MONO_FONT;
}
let lastAttachmentId = Date.now() * 1000 + 999;

function nextAttachmentId(): number {
  lastAttachmentId = Math.max(Date.now() * 1000, lastAttachmentId + 1);
  return lastAttachmentId;
}

function validDimension(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_DIMENSION && value <= MAX_DIMENSION;
}

import { resolveThemeColor } from "./colors";

export { resolveThemeColor };

function exitMessage(exit: PtyExit): string {
  if (exit.signal) return t("terminal.exitSignal", { signal: exit.signal });
  if (exit.exitCode != null) return t("terminal.exitCode", { code: exit.exitCode });
  return t("terminal.exited");
}

export interface CliPaneHooks {
  /**
   * Intercept typed input before it reaches the session. Return true when the
   * input was consumed elsewhere (e.g. broadcast to every pane of a tab).
   */
  interceptInput?: (data: string) => boolean;
  /** Report the fitted terminal size after each resize. */
  onResize?: (cols: number, rows: number) => void;
}

export function CliPane({ sessionId, interceptInput, onResize }: { sessionId: string } & CliPaneHooks) {
  const containerRef = useRef<HTMLDivElement>(null);
  const exitedRef = useRef(false);
  // The effect below is keyed on sessionId only, so route optional hooks
  // through a ref to always call the latest callbacks.
  const hooksRef = useRef({ interceptInput, onResize });
  hooksRef.current = { interceptInput, onResize };
  const [exit, setExit] = useState<PtyExit | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const attachmentId = nextAttachmentId();
    exitedRef.current = false;
    setExit(null);
    setError(null);
    let disposed = false;
    let attached = false;
    let attachPromise: Promise<void> | null = null;
    let resizeTimer = 0;
    const unlisteners: Array<() => void> = [];
    const style = getComputedStyle(container);
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: monoFontFamily(container),
      fontSize: 12,
      theme: {
        background: resolveThemeColor(style.getPropertyValue("--surf").trim()),
        foreground: resolveThemeColor(style.getPropertyValue("--fg").trim()),
        cursor: resolveThemeColor(style.getPropertyValue("--acc").trim()),
        selectionBackground: resolveThemeColor(style.getPropertyValue("--accs").trim()),
      },
    });
    const fitAddon = new FitAddon();
    const webglAddon = new WebglAddon();
    let resizeObserver: ResizeObserver | null = null;
    let inputSubscription: { dispose: () => void } | null = null;
    let dragDropUnlisten: (() => void) | null = null;

    const showError = (reason: unknown) => {
      if (!disposed) setError(errorMessage(reason));
    };

    const unsubscribe = () => {
      for (const unlisten of unlisteners.splice(0)) unlisten();
    };

    // Last dimensions sent to the PTY. Skipping duplicates keeps hide/show
    // cycles and subpixel layout settling from SIGWINCH-storming full-screen
    // CLI apps; a failed send clears it so the next pass retries.
    let lastSent: { cols: number; rows: number } | null = null;
    const syncSize = () => {
      if (disposed || !attached || exitedRef.current) return;
      try {
        fitAddon.fit();
        const { cols, rows } = terminal;
        if (!validDimension(cols) || !validDimension(rows)) return;
        if (lastSent && lastSent.cols === cols && lastSent.rows === rows) return;
        lastSent = { cols, rows };
        hooksRef.current.onResize?.(cols, rows);
        void resizeTerminal(sessionId, cols, rows).catch((reason) => {
          lastSent = null;
          showError(reason);
        });
      } catch (reason) {
        showError(reason);
      }
    };

    const scheduleResize = () => {
      if (disposed || exitedRef.current) return;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(syncSize, RESIZE_DEBOUNCE_MS);
    };

    const setupListeners = async () => {
      const outputUnlisten = await onTerminalOutput((event: PtyOutput) => {
        if (disposed || event.sessionId !== sessionId) return;
        terminal.write(Uint8Array.from(event.data));
      });
      if (disposed) {
        outputUnlisten();
        return;
      }
      unlisteners.push(outputUnlisten);

      const exitUnlisten = await onTerminalExit((event: PtyExit) => {
        if (disposed || event.sessionId !== sessionId) return;
        exitedRef.current = true;
        setExit(event);
        terminal.options.disableStdin = true;
        window.clearTimeout(resizeTimer);
      });
      if (disposed) {
        exitUnlisten();
        unsubscribe();
        return;
      }
      unlisteners.push(exitUnlisten);

      const errorUnlisten = await onTerminalError((event: PtyErrorEvent) => {
        if (disposed || event.sessionId !== sessionId) return;
        setError(event.message);
      });
      if (disposed) {
        errorUnlisten();
        unsubscribe();
        return;
      }
      unlisteners.push(errorUnlisten);

      attachPromise = attachTerminal(sessionId, attachmentId);
      await attachPromise;
      if (disposed) {
        unsubscribe();
        return;
      }
      attached = true;
      markTerminalAttached(sessionId);
      scheduleResize();
    };

    try {
      void getCurrentWebview().onDragDropEvent((event) => {
        if (disposed || exitedRef.current || event.payload.type !== "drop") return;
        const rect = container.getBoundingClientRect();
        if (!dropPositionIsInside(event.payload.position.x, event.payload.position.y, rect)) return;
        const text = formatDroppedPaths(event.payload.paths);
        if (!text) return;
        terminal.focus();
        void writeTerminal(sessionId, new TextEncoder().encode(text)).catch(showError);
      }).then((unlisten) => {
        if (disposed) unlisten();
        else dragDropUnlisten = unlisten;
      }).catch(showError);
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      fitAddon.fit();
      terminal.loadAddon(webglAddon);
      inputSubscription = terminal.onData((data) => {
        if (disposed || exitedRef.current) return;
        if (hooksRef.current.interceptInput?.(data)) return;
        void writeTerminal(sessionId, new TextEncoder().encode(data)).catch(showError);
      });
      resizeObserver = new ResizeObserver(scheduleResize);
      resizeObserver.observe(container);
      void setupListeners().catch((reason: unknown) => {
        unsubscribe();
        showError(reason);
      });
    } catch (reason) {
      showError(reason);
    }

    return () => {
      disposed = true;
      window.clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
      inputSubscription?.dispose();
      dragDropUnlisten?.();
      unsubscribe();
      webglAddon.dispose();
      fitAddon.dispose();
      terminal.dispose();
      if (attached) {
        void detachTerminal(sessionId, attachmentId).catch((reason) => {
          console.error("Could not detach terminal after pane unmount", reason);
        });
      } else if (attachPromise) {
        void attachPromise.then(() => detachTerminal(sessionId, attachmentId)).catch((reason) => {
          console.error("Could not detach terminal after pane unmount", reason);
        });
      }
    };
  }, [sessionId]);

  return (
    <section className="cli-pane" aria-label={t("terminal.label")}>
      <div className="cli-pane-screen" ref={containerRef} />
      {error && (
        <div className="cli-pane-message cli-pane-error" role="alert">
          {t("terminal.error", { message: error })}
        </div>
      )}
      {exit && (
        <div className="cli-pane-message cli-pane-exit" role="status">
          {exitMessage(exit)}
        </div>
      )}
    </section>
  );
}
