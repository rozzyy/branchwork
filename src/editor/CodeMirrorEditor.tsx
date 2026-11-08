import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { basicSetup, EditorView } from "codemirror";
import { Annotation, EditorState, Compartment } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { t } from "../i18n/t";
import { useFiles, bufferKey } from "../state/files";
import { useWorktrees } from "../state/worktrees";
import { useStage } from "../state/stage";
import { fsRead, fsWrite, type FsEol } from "../ipc/fs";
import { readDiff } from "../ipc/diff";
import { readStatus } from "../ipc/status";
import { onGitChanged } from "../ipc/worktrees";
import { errorMessage } from "../ipc/errors";
import { toast } from "../ui/toast";
import { ask } from "../ui/dialog";
import { Button } from "../ui/Button";
import { FileIcon } from "../ui/fileIcon";
import { getFileExtension, getLanguageExtension, getLanguageName } from "./languages";
import { bwThemeExtension } from "./theme";
import { gitGutterExtension, computeGutterMarkers, setGitMarkersEffect } from "./gutter";
import { MarkdownPreview } from "./MarkdownPreview";
import "./editor.css";

interface ConflictState {
  path: string;
  diskMtime: number;
  diskContent: string;
}

/** R8: marks doc replacements made by the app itself (silent reload, Reload, split-pane sync) so
 * the update listener doesn't treat them as user edits and flag the file dirty. */
const appEdit = Annotation.define<true>();

/** AC4's status-bar indentation field: tabs win if any leading line uses one, otherwise the
 * smallest non-zero leading-space run in the buffer is taken as the indent width. Falls back to
 * the editor default (2 spaces) for a buffer with no indented lines. */
function detectIndentation(content: string): string {
  let spaceWidth: number | null = null;
  for (const line of content.split("\n")) {
    const leading = /^[ \t]+/.exec(line)?.[0];
    if (!leading) continue;
    if (leading.includes("\t")) return t("editor.tabs");
    if (spaceWidth === null || leading.length < spaceWidth) spaceWidth = leading.length;
  }
  return t("editor.spaces", { n: spaceWidth ?? 2 });
}

// I3: CodeMirror's Text always joins lines with "\n" via toString(); sliceString lets us rejoin
// with the eol fs_read actually reported, so a CRLF file round-trips instead of being silently
// normalised to LF on every save.
function serializeDoc(view: EditorView | null, eol: FsEol, fallback: string): string {
  if (!view) return fallback;
  return eol === "CRLF" ? view.state.doc.sliceString(0, undefined, "\r\n") : view.state.doc.toString();
}

export function CodeMirrorEditor() {
  const activePath = useWorktrees((s) => s.activePath);
  const branch = useWorktrees((s) => s.worktrees.find((w) => w.path === s.activePath)?.branch ?? null);
  const open = useFiles((s) => s.open);
  const current = useFiles((s) => s.current);
  const dirty = useFiles((s) => s.dirty);
  const openFile = useFiles((s) => s.openFile);
  const closeFile = useFiles((s) => s.closeFile);
  const markDirty = useFiles((s) => s.markDirty);
  const clearDirty = useFiles((s) => s.clearDirty);
  const setMode = useFiles((s) => s.setMode);
  const setBuffer = useFiles((s) => s.setBuffer);
  const updateBufferContent = useFiles((s) => s.updateBufferContent);
  const dropBuffer = useFiles((s) => s.dropBuffer);
  const go = useStage((s) => s.go);

  // R5/R6: buffers live in the files store (keyed by worktree+path), not in a component ref, so
  // they outlive this component's unmount and are shared by every editor instance on the file.
  const bufKey = activePath && current ? bufferKey(activePath, current) : null;
  const currentBuf = useFiles((s) => (bufKey ? s.buffers[bufKey] : undefined));

  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  // AC7: a dirty background tab whose file changed on disk doesn't get a banner right away (it
  // isn't on screen) — its conflict is parked here until the user switches to that tab.
  const pendingConflictsRef = useRef<Map<string, ConflictState>>(new Map());

  const [cursor, setCursor] = useState({ line: 1, col: 1, selectionLength: 0 });
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [fileStatus, setFileStatus] = useState<string | null>(null);
  const [mdPreview, setMdPreview] = useState(false);
  // null = buffer not yet loaded (show spinner); string = ready
  const [previewContent, setPreviewContent] = useState<string | null>(null);

  // Read latest git status (M, A, etc.) for the current file
  const updateFileStatus = useCallback(async (path: string) => {
    if (!activePath) return;
    try {
      const summary = await readStatus(activePath);
      const match =
        summary.unstaged.find((e) => e.path === path) ??
        summary.staged.find((e) => e.path === path);
      if (match) {
        setFileStatus(match.worktreeStatus || match.indexStatus || null);
      } else {
        setFileStatus(null);
      }
    } catch {
      setFileStatus(null);
    }
  }, [activePath]);

  // Read git diff and update gutter markers in EditorView. Unstaged hunks win; a fully-staged
  // file (no unstaged hunks) falls back to the staged diff so its gutter isn't left empty.
  const updateGutterDiff = useCallback(async (path: string, view: EditorView) => {
    if (!activePath) return;
    try {
      let diff = await readDiff(activePath, path, "unstaged");
      if (diff.hunks.length === 0) {
        try {
          const staged = await readDiff(activePath, path, "staged");
          if (staged.hunks.length > 0) diff = staged;
        } catch {
          // Keep the (empty) unstaged diff if the staged read fails.
        }
      }
      const markers = computeGutterMarkers(diff, view.state.doc);
      view.dispatch({ effects: setGitMarkersEffect.of(markers) });
    } catch {
      // If diff read fails or clean, clear markers
      view.dispatch({ effects: setGitMarkersEffect.of(computeGutterMarkers(null, view.state.doc)) });
    }
  }, [activePath]);

  // Core save routine
  const handleSave = useCallback(async () => {
    if (!activePath || !current) return;
    const key = bufferKey(activePath, current);
    const buf = useFiles.getState().buffers[key];
    // C1: a binary or non-UTF-8 buffer is never editable (see render), so never write it back —
    // doing so would re-encode the (possibly truncated/mojibake) decoded text as UTF-8 and
    // destroy the real file.
    if (buf && buf.encoding !== "utf-8") return;
    const content = serializeDoc(editorViewRef.current, buf?.eol ?? "LF", buf?.content ?? "");
    const expectedMtime = buf ? buf.mtime : 0;
    const bytes = Array.from(new TextEncoder().encode(content));

    try {
      const newMtime = await fsWrite(activePath, current, bytes, expectedMtime);
      // R6: write through the store so every pane on this file (shared mtime) sees the new one.
      setBuffer(key, { content, mtime: newMtime, encoding: buf?.encoding ?? "utf-8", eol: buf?.eol ?? "LF" });
      clearDirty(current);
      setConflict(null);
      pendingConflictsRef.current.delete(current);
      const filename = current.split("/").pop() ?? current;
      toast({ title: t("files.saved", { name: filename }), icon: "💾" });
      if (editorViewRef.current) {
        void updateGutterDiff(current, editorViewRef.current);
      }
      void updateFileStatus(current);
    } catch (err: unknown) {
      const isConflict =
        typeof err === "object" && err !== null && "kind" in err && (err as { kind: string }).kind === "conflict";
      if (isConflict) {
        try {
          const fresh = await fsRead(activePath, current);
          const diskContent = new TextDecoder().decode(new Uint8Array(fresh.bytes));
          setConflict({ path: current, diskMtime: fresh.mtime, diskContent });
        } catch {
          toast({ title: t("files.saveConflict"), icon: "!" });
        }
      } else {
        toast({ title: errorMessage(err), icon: "!" });
      }
    }
  }, [activePath, current, clearDirty, updateGutterDiff, updateFileStatus, setBuffer]);

  // Banner action: Reload from disk
  const handleReload = useCallback(() => {
    if (!activePath || !conflict || !current || conflict.path !== current) return;
    const { diskContent, diskMtime } = conflict;
    const key = bufferKey(activePath, current);
    const buf = useFiles.getState().buffers[key];
    setBuffer(key, { content: diskContent, mtime: diskMtime, encoding: buf?.encoding ?? "utf-8", eol: buf?.eol ?? "LF" });
    if (editorViewRef.current) {
      editorViewRef.current.dispatch({
        changes: { from: 0, to: editorViewRef.current.state.doc.length, insert: diskContent },
        annotations: appEdit.of(true),
      });
    }
    clearDirty(current);
    setConflict(null);
    pendingConflictsRef.current.delete(current);
  }, [activePath, conflict, current, clearDirty, setBuffer]);

  // Banner action: Overwrite disk with mine
  const handleKeepMine = useCallback(async () => {
    if (!activePath || !current || !conflict || conflict.path !== current) return;
    const key = bufferKey(activePath, current);
    const buf = useFiles.getState().buffers[key];
    const content = serializeDoc(editorViewRef.current, buf?.eol ?? "LF", buf?.content ?? "");
    const bytes = Array.from(new TextEncoder().encode(content));
    try {
      const newMtime = await fsWrite(activePath, current, bytes, conflict.diskMtime);
      setBuffer(key, { content, mtime: newMtime, encoding: buf?.encoding ?? "utf-8", eol: buf?.eol ?? "LF" });
      clearDirty(current);
      setConflict(null);
      pendingConflictsRef.current.delete(current);
      const filename = current.split("/").pop() ?? current;
      toast({ title: t("files.saved", { name: filename }), icon: "💾" });
    } catch (err: unknown) {
      toast({ title: errorMessage(err), icon: "!" });
    }
  }, [activePath, current, conflict, clearDirty, setBuffer]);

  // Banner action: Compare (switches to Diff vs HEAD)
  const handleCompare = useCallback(() => {
    setMode("diff");
  }, [setMode]);

  // R5c: a dirty tab's only way out used to be Save — this gives it a discard path, so a stuck
  // dirty flag never blocks a worktree switch with no escape.
  const handleDiscardTab = useCallback(async (path: string) => {
    const name = path.split("/").pop() ?? path;
    const confirmed = await ask({
      title: t("editor.discardTabTitle", { name }),
      ok: t("editor.discardTabOk"),
      danger: true,
      icon: "↶",
    });
    if (confirmed !== true) return;
    pendingConflictsRef.current.delete(path);
    if (activePath) dropBuffer(bufferKey(activePath, path));
    clearDirty(path);
    closeFile(path);
  }, [activePath, dropBuffer, clearDirty, closeFile]);

  // R5: buffers live in the store keyed by worktree+path (see bufferKey), so they don't need
  // clearing on a worktree change any more. Only the local-view-only state below (the parked
  // external-change conflicts and the visible banner) still needs resetting here — it isn't tied
  // to a buffer key and must not leak across a worktree switch.
  useEffect(() => {
    pendingConflictsRef.current.clear();
    setConflict(null);
  }, [activePath]);

  // R6: two editor instances on the same file share one buffer in the store. When the buffer's
  // content changes from elsewhere — another pane's edit, a reload, a save — bring this view's
  // doc in line. Comparing the live doc string (not an origin flag) means a view never re-applies
  // its own edit: by the time the store updates, its own doc already matches.
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view || currentBuf === undefined) return;
    if (view.state.doc.toString() === currentBuf.content) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: currentBuf.content },
      annotations: appEdit.of(true),
    });
  }, [currentBuf]);

  // ── Effect 1: load buffer from disk (runs whenever active file changes) ──
  // Runs regardless of whether the editor container is mounted (preview mode
  // hides the container div, so we must not gate on containerRef).
  useEffect(() => {
    if (!activePath || !current || !bufKey) return;
    let disposed = false;
    // Reset here, not in a later effect: a later effect would run after the
    // synchronous cache hit below and clobber it back to null.
    setPreviewContent(null);

    async function loadBuffer() {
      if (!activePath || !current || !bufKey) return;
      const existing = useFiles.getState().buffers[bufKey];
      if (existing) {
        // Already cached — just sync preview state
        setPreviewContent(existing.content);
        return;
      }
      try {
        const res = await fsRead(activePath, current);
        if (disposed) return;
        const content = new TextDecoder().decode(new Uint8Array(res.bytes));
        setBuffer(bufKey, { content, mtime: res.mtime, encoding: res.encoding, eol: res.eol });
        setPreviewContent(content);
      } catch (err) {
        if (disposed) return;
        toast({ title: errorMessage(err), icon: "!" });
      }
    }

    void loadBuffer();
    return () => { disposed = true; };
  }, [activePath, current, bufKey, setBuffer]);

  // ── Effect 2: mount / remount EditorView (runs when container is ready) ──
  // containerRef.current is only non-null when the ed-container div is rendered
  // (i.e. not in markdown-preview mode). I2: mdPreview is in the dep array below so toggling
  // Preview -> Source (which makes the container reappear) remounts the view into it instead
  // of leaving it empty. Deliberately not keyed on the buffer's content — only on which file is
  // open — so a keystroke updates the existing view instead of remounting it every time.
  useEffect(() => {
    if (!activePath || !current || !containerRef.current || !bufKey) return;
    let disposed = false;

    async function mountEditor() {
      if (!activePath || !current || !bufKey) return;
      // Wait for buffer — may already be present from Effect 1 (or another pane on this file)
      let buf = useFiles.getState().buffers[bufKey];
      if (!buf) {
        // Edge-case: container appeared before Effect 1 finished (unlikely but safe)
        try {
          const res = await fsRead(activePath, current);
          if (disposed) return;
          buf = {
            content: new TextDecoder().decode(new Uint8Array(res.bytes)),
            mtime: res.mtime,
            encoding: res.encoding,
            eol: res.eol,
          };
          setBuffer(bufKey, buf);
          setPreviewContent(buf.content);
        } catch (err) {
          if (disposed) return;
          toast({ title: errorMessage(err), icon: "!" });
          return;
        }
      }

      if (disposed || !containerRef.current) return;

      // Clean up previous view if exists
      if (editorViewRef.current) {
        editorViewRef.current.destroy();
        editorViewRef.current = null;
      }

      // C1: never mount an editable CodeMirror buffer over a binary or non-UTF-8 decode — the
      // render below shows a read-only notice instead of the `.ed-container` div for this case.
      if (buf.encoding !== "utf-8") return;

      const langExt = getLanguageExtension(current);
      const saveKeymap = keymap.of([
        {
          key: "Mod-s",
          run: () => {
            void handleSave();
            return true;
          },
        },
      ]);

      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newDoc = update.state.doc.toString();
          setPreviewContent(newDoc);
          // The store already holds app-made content (it was set before the dispatch).
          if (!update.transactions.some((tr) => tr.annotation(appEdit))) {
            updateBufferContent(bufKey, newDoc);
            markDirty(current);
          }
        }
        if (update.selectionSet || update.docChanged) {
          const pos = update.state.selection.main.head;
          const line = update.state.doc.lineAt(pos);
          const col = pos - line.from + 1;
          const selLen = Math.abs(update.state.selection.main.to - update.state.selection.main.from);
          setCursor({ line: line.number, col, selectionLength: selLen });
        }
      });

      const state = EditorState.create({
        doc: buf.content,
        extensions: [
          basicSetup,
          saveKeymap,
          bwThemeExtension,
          gitGutterExtension,
          languageCompartment.current.of(langExt ?? []),
          updateListener,
        ],
      });

      const view = new EditorView({
        state,
        parent: containerRef.current,
      });

      editorViewRef.current = view;

      // Initial cursor
      setCursor({ line: 1, col: 1, selectionLength: 0 });

      // Load gutter markers & git status
      void updateGutterDiff(current, view);
      void updateFileStatus(current);
    }

    void mountEditor();

    return () => {
      disposed = true;
      if (editorViewRef.current) {
        editorViewRef.current.destroy();
        editorViewRef.current = null;
      }
    };
  }, [activePath, current, mdPreview, bufKey, setBuffer, updateBufferContent, markDirty, handleSave, updateGutterDiff, updateFileStatus]);

  // Handle external change / focus re-read. Re-reads every open tab, not just the current one,
  // so a background tab's cached buffer never drifts silently out of sync with disk.
  const checkExternalChanges = useCallback(async () => {
    if (!activePath) return;
    await Promise.all(
      open.map(async (path) => {
        const key = bufferKey(activePath, path);
        const buf = useFiles.getState().buffers[key];
        if (!buf) return;
        try {
          const res = await fsRead(activePath, path);
          if (res.mtime === buf.mtime) return;
          const diskContent = new TextDecoder().decode(new Uint8Array(res.bytes));
          if (!dirty[path]) {
            // Silently replace the cached buffer, and the live view if it's the open tab.
            setBuffer(key, { ...buf, content: diskContent, mtime: res.mtime });
            if (path === current) {
              setPreviewContent(diskContent);
              if (editorViewRef.current) {
                editorViewRef.current.dispatch({
                  changes: { from: 0, to: editorViewRef.current.state.doc.length, insert: diskContent },
                  annotations: appEdit.of(true),
                });
              }
              setConflict(null);
            }
          } else if (path === current) {
            // Show the conflict banner for the file the user is looking at right now.
            setConflict({ path, diskMtime: res.mtime, diskContent });
          } else {
            // Background dirty tab: park the conflict until the user switches to it (the
            // current-tab effect below surfaces it then).
            pendingConflictsRef.current.set(path, { path, diskMtime: res.mtime, diskContent });
          }
        } catch {
          // Ignore background read errors
        }
      }),
    );
    if (current && editorViewRef.current) {
      void updateGutterDiff(current, editorViewRef.current);
    }
    if (current) void updateFileStatus(current);
  }, [activePath, open, current, dirty, updateGutterDiff, updateFileStatus, setBuffer]);

  // Window focus listener
  useEffect(() => {
    const onFocus = () => {
      void checkExternalChanges();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [checkExternalChanges]);

  // git:changed event listener
  useEffect(() => {
    if (!activePath || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    try {
      const sub = onGitChanged((event) => {
        if (event.worktree === activePath) {
          void checkExternalChanges();
        }
      });
      void sub.then((stop) => {
        if (disposed) void stop();
        else unlisten = stop;
      });
    } catch {
      return;
    }
    return () => {
      disposed = true;
      if (unlisten) void unlisten();
    };
  }, [activePath, checkExternalChanges]);

  // Auto-enable preview when switching to a markdown file, disable for others.
  // Must be before the early return to satisfy React's rules-of-hooks.
  useEffect(() => {
    if (!current) return;
    setMdPreview(getFileExtension(current) === "md");
  }, [current]);

  // AC7: a tab that picked up a pending external conflict while it was in the background
  // surfaces its banner now that it's the one on screen.
  useEffect(() => {
    if (!current) return;
    const pending = pendingConflictsRef.current.get(current);
    if (pending) {
      pendingConflictsRef.current.delete(current);
      setConflict(pending);
    }
  }, [current]);

  if (!current || open.length === 0) {
    return <div className="editor-host-empty">{t("files.noFileSelected")}</div>;
  }

  const parts = current.split("/");
  const langName = getLanguageName(current);
  const isMarkdown = getFileExtension(current) === "md";
  // C1: binary / non-UTF-8 buffers are read-only — no editable CodeMirror state is ever mounted
  // for them (see Effect 2), and Save must reflect that in the UI too.
  const isBinary = !!currentBuf && currentBuf.encoding !== "utf-8";

  return (
    <div className="editor-root">
      {/* Tabs */}
      <div className="etabs" role="tablist">
        {open.map((p) => {
          const name = p.split("/").pop() ?? p;
          const isSelected = p === current;
          const isDirty = !!dirty[p];
          return (
            <button
              aria-selected={isSelected}
              className={"etab" + (isSelected ? " on" : "")}
              key={p}
              onClick={() => openFile(p)}
              role="tab"
              type="button"
            >
              <FileIcon path={p} />
              <span className="etab-name">{name}</span>
              {isDirty ? (
                <span
                  aria-label={t("editor.unsavedDiscard", { name })}
                  className="dd"
                  onClick={(event: ReactMouseEvent) => {
                    event.stopPropagation();
                    void handleDiscardTab(p);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    void handleDiscardTab(p);
                  }}
                  role="button"
                  tabIndex={0}
                />
              ) : (
                <span
                  aria-label={t("editor.close", { name })}
                  className="x"
                  onClick={(event: ReactMouseEvent) => {
                    event.stopPropagation();
                    pendingConflictsRef.current.delete(p);
                    // Drop the cached buffer too, so reopening this tab re-reads disk instead of
                    // serving content that may be stale or gone.
                    if (activePath) dropBuffer(bufferKey(activePath, p));
                    closeFile(p);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  ×
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Breadcrumb & Header bar */}
      <div className="ebar">
        <span className="crumb">
          {parts.map((segment, idx) => (
            <span key={idx} className="crumb-segment">
              {idx > 0 && <span className="ebar-sep"> › </span>}
              {idx === parts.length - 1 ? <b>{segment}</b> : segment}
            </span>
          ))}
        </span>
        {fileStatus && (
          <span
            className="chip"
            style={{
              color: fileStatus === "A" ? "var(--grn)" : "var(--yel)",
              marginLeft: "6px",
            }}
          >
            {fileStatus === "A" ? t("files.statusNew") : t("files.statusModified")}
          </span>
        )}
        <div className="ebar-actions">
          {isMarkdown && (
            <Button
              onClick={() => setMdPreview((v) => !v)}
              size="sm"
              variant="ghost"
              aria-pressed={mdPreview}
            >
              {mdPreview ? t("files.mdSource") : t("files.mdPreview")}
            </Button>
          )}
          <Button onClick={() => go("blame")} size="sm" variant="ghost">
            ≡ {t("files.blame")}
          </Button>
          <Button disabled size="sm" title={t("ui.deferred_m3")} variant="ghost">
            ✦ {t("files.askAgent")}
          </Button>
          <Button
            disabled={isBinary || !dirty[current]}
            id="savb"
            onClick={() => void handleSave()}
            size="sm"
          >
            {t("files.save")}
          </Button>
        </div>
      </div>

      {/* External Change Conflict Banner */}
      {conflict && conflict.path === current && (
        <div className="editor-conflict-banner" role="alert">
          <span className="banner-text">{t("files.externalBanner")}</span>
          <div className="banner-actions">
            <Button onClick={handleReload} size="sm">
              {t("files.bannerReload")}
            </Button>
            <Button onClick={() => void handleKeepMine()} size="sm">
              {t("files.bannerKeepMine")}
            </Button>
            <Button onClick={handleCompare} size="sm">
              {t("files.bannerCompare")}
            </Button>
          </div>
        </div>
      )}

      {/* Editor Mount Container / Markdown Preview / Binary notice */}
      {isBinary ? (
        <div className="editor-host-empty">{t("files.binaryNotice")}</div>
      ) : isMarkdown && mdPreview ? (
        <MarkdownPreview content={previewContent} />
      ) : (
        <div className="ed-container" id="ed" ref={containerRef} />
      )}

      {/* Status Bar */}
      <div className="estat">
        <span id="ln">
          {t("editor.cursor", { line: cursor.line, col: cursor.col })}
          {cursor.selectionLength > 0 && ` ${t("editor.selected", { n: cursor.selectionLength })}`}
        </span>
        <span>{detectIndentation(currentBuf?.content ?? "")}</span>
        <span>{currentBuf?.encoding?.toUpperCase() ?? "UTF-8"}</span>
        <span>{currentBuf?.eol?.toUpperCase() ?? "LF"}</span>
        <span>{langName}</span>
        <span style={{ marginLeft: "auto" }}>⎇ {branch ?? "main"}</span>
        <span className="g">{t("files.prettier")}</span>
        <span className="g">{t("files.tsc")}</span>
      </div>
    </div>
  );
}
