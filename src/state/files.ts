import { create } from "zustand";
import type { FsEncoding, FsEol } from "../ipc/fs";

export type FilesViewMode = "editor" | "diff";

export interface FileBuffer {
  content: string;
  mtime: number;
  encoding: FsEncoding;
  eol: FsEol;
}

/** Buffers are keyed by worktree *and* path, not path alone — a tab left open across a worktree
 * switch, or a remounted editor, must never serve one worktree's content under another's path. */
export function bufferKey(worktree: string, path: string): string {
  return `${worktree}\0${path}`;
}

interface FilesStore {
  open: string[];
  current: string | null;
  dirty: Record<string, true>;
  expanded: Record<string, true>;
  fuzzyQuery: string;
  showIgnored: boolean;
  /** Editor/Diff-vs-HEAD segmented toggle (AC2); not part of the AC5 shape, added because the
   * toolbar and the view are separate components that both need it. */
  mode: FilesViewMode;
  /** Editor buffer contents, keyed by bufferKey(worktree, path). Lives in the store — not in a
   * component ref — so unsaved edits survive the editor unmounting (screen navigation, tab
   * switches) and so two editor instances on the same file share one buffer (R5/R6). */
  buffers: Record<string, FileBuffer>;
  setMode(mode: FilesViewMode): void;
  /** Adds `path` to the open-tabs list (no-op if already open) and makes it current. */
  openFile(path: string): void;
  /** Removes `path` from the open-tabs list; if it was current, falls back to the last
   * remaining open tab (or null when none are left). */
  closeFile(path: string): void;
  markDirty(path: string): void;
  clearDirty(path: string): void;
  setCurrent(path: string | null): void;
  toggleExpanded(path: string): void;
  collapseAll(): void;
  setFuzzyQuery(query: string): void;
  setShowIgnored(value: boolean): void;
  /** Replaces the whole buffer at `key` (disk load, save, conflict resolution). */
  setBuffer(key: string, buffer: FileBuffer): void;
  /** Patches just the content of an existing buffer (editor keystrokes). No-op if the buffer
   * isn't loaded yet. */
  updateBufferContent(key: string, content: string): void;
  /** Drops a buffer, e.g. on tab close, so reopening it re-reads disk. */
  dropBuffer(key: string): void;
}

export const useFiles = create<FilesStore>((set, get) => ({
  open: [],
  current: null,
  dirty: {},
  expanded: {},
  fuzzyQuery: "",
  showIgnored: false,
  mode: "editor",
  buffers: {},
  setMode(mode) {
    set({ mode });
  },
  openFile(path) {
    const { open } = get();
    set({ open: open.includes(path) ? open : [...open, path], current: path });
  },
  closeFile(path) {
    const { current, open } = get();
    const next = open.filter((p) => p !== path);
    set({ open: next, current: current === path ? (next[next.length - 1] ?? null) : current });
  },
  markDirty(path) {
    if (get().dirty[path]) return;
    set({ dirty: { ...get().dirty, [path]: true } });
  },
  clearDirty(path) {
    if (!get().dirty[path]) return;
    const dirty = { ...get().dirty };
    delete dirty[path];
    set({ dirty });
  },
  setCurrent(path) {
    set({ current: path });
  },
  toggleExpanded(path) {
    const expanded = { ...get().expanded };
    if (expanded[path]) delete expanded[path];
    else expanded[path] = true;
    set({ expanded });
  },
  collapseAll() {
    set({ expanded: {} });
  },
  setFuzzyQuery(query) {
    set({ fuzzyQuery: query });
  },
  setShowIgnored(value) {
    set({ showIgnored: value });
  },
  setBuffer(key, buffer) {
    set({ buffers: { ...get().buffers, [key]: buffer } });
  },
  updateBufferContent(key, content) {
    const existing = get().buffers[key];
    if (!existing) return;
    set({ buffers: { ...get().buffers, [key]: { ...existing, content } } });
  },
  dropBuffer(key) {
    if (!(key in get().buffers)) return;
    const buffers = { ...get().buffers };
    delete buffers[key];
    set({ buffers });
  },
}));
