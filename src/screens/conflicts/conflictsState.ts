import { create } from "zustand";
import {
  conflictList,
  conflictRead,
  type ConflictFile,
  type ConflictList,
  type RegionChoice,
} from "../../ipc/conflicts";
import { errorMessage } from "../../ipc/errors";
import { useEffect } from "react";
import { onGitChanged } from "../../ipc/worktrees";
import { useWorktrees } from "../../state/worktrees";

interface ConflictsStore {
  worktree: string | null;
  list: ConflictList | null;
  selected: string | null;
  file: ConflictFile | null;
  /** Choice per conflict region index for the selected file. */
  choices: Record<number, RegionChoice>;
  /** Choices in the order they were made, with what each replaced; Undo pops the last one. */
  history: { index: number; previous: RegionChoice | undefined }[];
  error: string | null;
  load(worktree: string | null): Promise<void>;
  select(path: string): Promise<void>;
  choose(index: number, choice: RegionChoice): void;
  undo(): void;
}

let revision = 0;

export const useConflicts = create<ConflictsStore>((set, get) => ({
  worktree: null,
  list: null,
  selected: null,
  file: null,
  choices: {},
  history: [],
  error: null,
  async load(worktree) {
    const request = ++revision;
    if (!worktree) {
      set({ worktree: null, list: null, selected: null, file: null, choices: {}, history: [], error: null });
      return;
    }
    if (get().worktree !== worktree) set({ worktree, list: null, selected: null, file: null, choices: {}, history: [] });
    try {
      const list = await conflictList(worktree);
      if (request !== revision) return;
      const selected = list.files.some((entry) => entry.path === get().selected) ? get().selected : list.files[0]?.path ?? null;
      set({ list, error: null });
      if (selected !== get().selected || (selected && !get().file)) await get().select(selected ?? "");
      if (!selected) set({ selected: null, file: null, choices: {}, history: [] });
    } catch (error) {
      if (request === revision) set({ error: errorMessage(error) });
    }
  },
  async select(path) {
    const worktree = get().worktree;
    if (!worktree || !path) return;
    set({ selected: path, file: null, choices: {}, history: [] });
    try {
      const file = await conflictRead(worktree, path);
      if (get().selected === path && get().worktree === worktree) set({ file, error: null });
    } catch (error) {
      if (get().selected === path && get().worktree === worktree) set({ error: errorMessage(error) });
    }
  },
  choose(index, choice) {
    // Re-choosing the same option is a no-op (no extra undo entry).
    if (JSON.stringify(get().choices[index]) === JSON.stringify(choice)) return;
    set((state) => ({
      choices: { ...state.choices, [index]: choice },
      history: [...state.history, { index, previous: state.choices[index] }],
    }));
  },
  undo() {
    const { history, choices } = get();
    const last = history[history.length - 1];
    if (!last) return;
    const next = { ...choices };
    if (last.previous) next[last.index] = last.previous;
    else delete next[last.index];
    set({ choices: next, history: history.slice(0, -1) });
  },
}));

/** Conflicted-file count of the active worktree (sidebar badge). */
export function useConflictCount(): number {
  const active = useWorktrees((state) => state.activePath);
  return useConflicts((state) => (state.worktree === active ? state.list?.files.length ?? 0 : 0));
}

/** Keeps the conflict list of the active worktree fresh (worktree switch + debounced git:changed). */
export function useConflictWatch(): void {
  const active = useWorktrees((state) => state.activePath);
  useEffect(() => {
    void useConflicts.getState().load(active);
    if (!active) return;
    let timer: number | undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onGitChanged((event) => {
      if (event.worktree !== active) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void useConflicts.getState().load(active), 250);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [active]);
}
