// Browser screen (M11): React draws the chrome; each tab's page is a native
// child webview kept over the content box. Native views float above the DOM,
// so they hide while an app overlay (menu, dialog, palette…) is open.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useBrowser, type BrowserTab } from "./store";
import { toAddress } from "./address";
import {
  browserAvailable,
  browserClose,
  browserGo,
  browserNavigate,
  browserOpen,
  browserSetBounds,
  browserShow,
  onBrowserState,
  type Bounds,
} from "../ipc/browser";
import { toast } from "../ui/toast";
import { t } from "../i18n/t";
import "./browser.css";

/** Tabs whose native webview exists in this window. */
const opened = new Set<string>();
const OVERLAY = '[role="dialog"], [role="menu"], .dlg-backdrop';
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** True while any app overlay is in the DOM (observed only while mounted). */
function useOverlayOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      setOpen(document.querySelector(OVERLAY) !== null);
    };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(check); });
    observer.observe(document.body, { childList: true, subtree: true });
    check();
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, []);
  return open;
}

export function BrowserToolbar() {
  return <h1 className="pane-title">{t("nav.browser")}</h1>;
}

export function BrowserView() {
  const tabs = useBrowser((s) => s.tabs);
  const activeId = useBrowser((s) => s.activeId);
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const box = useRef<HTMLDivElement>(null);
  const overlay = useOverlayOpen();
  const native = browserAvailable();

  useEffect(() => {
    void useBrowser.getState().load().then(() => {
      if (useBrowser.getState().tabs.length === 0) useBrowser.getState().newTab();
    });
  }, []);

  useEffect(() => {
    if (!native) return;
    let stop: (() => void) | undefined;
    let disposed = false;
    void onBrowserState((event) => useBrowser.getState().applyState(event)).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => { disposed = true; stop?.(); };
  }, [native]);

  // Keep the active tab's webview over the content box: created lazily, moved
  // whenever the box moves (splits, dividers, sidebar), hidden otherwise.
  useEffect(() => {
    if (!native) return;
    const visibleId = active?.url && !overlay ? active.id : null;
    let last = "";
    let frame = 0;
    let cancelled = false;
    const rectOf = (): Bounds | null => {
      const r = box.current?.getBoundingClientRect();
      return r && r.width > 1 && r.height > 1 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
    };
    for (const id of opened) if (id !== visibleId) void browserShow(id, false).catch(() => undefined);
    if (visibleId && active) {
      const rect = rectOf();
      const show = async () => {
        if (!rect || cancelled) return;
        if (!opened.has(visibleId)) {
          await browserOpen(visibleId, active.url, rect);
          opened.add(visibleId);
        }
        if (!cancelled) await browserShow(visibleId, true);
      };
      void show().catch((error: unknown) => toast({ title: message(error), icon: "⚠" }));
      const follow = () => {
        const next = rectOf();
        const key = next ? `${next.x},${next.y},${next.width},${next.height}` : "";
        if (next && key !== last && opened.has(visibleId)) {
          last = key;
          void browserSetBounds(visibleId, next).catch(() => undefined);
        }
        frame = requestAnimationFrame(follow);
      };
      frame = requestAnimationFrame(follow);
    }
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [native, active?.id, active?.url, overlay]);

  // Leaving the screen hides every page (kept alive for when it returns).
  useEffect(() => () => { for (const id of opened) void browserShow(id, false).catch(() => undefined); }, []);

  const go = (tab: BrowserTab, input: string) => {
    const url = toAddress(input);
    if (!url) return;
    const store = useBrowser.getState();
    const first = !tab.url;
    store.setUrl(tab.id, url);
    if (!native || first || !opened.has(tab.id)) return;
    void browserNavigate(tab.id, url).catch((error: unknown) => toast({ title: message(error), icon: "⚠" }));
  };

  const close = (id: string) => {
    useBrowser.getState().closeTab(id);
    if (opened.delete(id)) void browserClose(id).catch(() => undefined);
  };

  return (
    <div className="browser">
      <div className="browser-tabs" role="tablist" aria-label={t("browser.tabs")}>
        {tabs.map((tab) => (
          <div key={tab.id} className={"browser-tab" + (tab.id === activeId ? " on" : "")} role="tab" aria-selected={tab.id === activeId}>
            <button type="button" className="browser-tab-title" onClick={() => useBrowser.getState().select(tab.id)} title={tab.url || t("browser.newTab")}>
              {tab.loading && <span className="browser-spin" aria-hidden />}
              {tab.title || hostOf(tab.url) || t("browser.newTab")}
            </button>
            <button type="button" className="browser-tab-close" aria-label={t("browser.closeTab")} onClick={() => close(tab.id)}>✕</button>
          </div>
        ))}
        <button type="button" className="icon-btn" aria-label={t("browser.newTab")} title={t("browser.newTab")} onClick={() => useBrowser.getState().newTab()}>＋</button>
      </div>
      {active && <AddressBar key={active.id} tab={active} onGo={(input) => go(active, input)} />}
      <div ref={box} className="browser-page">
        {(!active?.url || !native) && (
          <div className="browser-empty">
            <p>{native ? t("browser.empty") : t("browser.desktopOnly")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function AddressBar({ tab, onGo }: { tab: BrowserTab; onGo(input: string): void }) {
  const [text, setText] = useState(tab.url);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(tab.url); }, [tab.url, editing]);
  const can = browserAvailable() && !!tab.url && opened.has(tab.id);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setEditing(false);
    onGo(text);
  };
  return (
    <form className="browser-bar" onSubmit={submit}>
      <button type="button" className="icon-btn" aria-label={t("browser.back")} disabled={!can} onClick={() => void browserGo(tab.id, "back").catch(() => undefined)}>←</button>
      <button type="button" className="icon-btn" aria-label={t("browser.forward")} disabled={!can} onClick={() => void browserGo(tab.id, "forward").catch(() => undefined)}>→</button>
      <button type="button" className="icon-btn" aria-label={t("browser.reload")} disabled={!can} onClick={() => void browserGo(tab.id, "reload").catch(() => undefined)}>↻</button>
      <input
        className="input browser-address"
        aria-label={t("browser.address")}
        placeholder={t("browser.addressHint")}
        value={text}
        autoFocus={!tab.url}
        spellCheck={false}
        onFocus={(event) => { setEditing(true); event.currentTarget.select(); }}
        onBlur={() => setEditing(false)}
        onChange={(event) => setText(event.target.value)}
      />
    </form>
  );
}

function hostOf(url: string): string {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
}
