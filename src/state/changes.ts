import { create } from "zustand";
import { readStatus, type StatusEntry } from "../ipc/status";
import { readDiff, type DiffArea, type DiffModel } from "../ipc/diff";
import { errorMessage } from "../ipc/errors";
import { loadSetting, saveSetting } from "../ipc/settings";
import { useWorktrees } from "./worktrees";

/** Widened by Tasks 06-08 (stage/unstage/discard/commit/stash); this task adds no variants. */
export type ChangesCommand = never;

export type DiffMode = "split" | "inline";

export interface ChangesSelection {
  path: string;
  area: DiffArea;
}

interface ChangesStore {
  worktree: string | null;
  entries: { staged: StatusEntry[]; unstaged: StatusEntry[] };
  loading: boolean;
  error: string | null;
  selection: ChangesSelection | null;
  diff: DiffModel | null;
  dmode: DiffMode;
  /** Fetches status (and the diff for the current selection, if any) for `worktreePath`.
   * Clears entries/selection/diff first when `worktreePath` differs from the tracked worktree. */
  refresh(worktreePath: string): Promise<void>;
  /** Debounced reaction to the M1 `git:changed{worktree}` event (250ms per worktree), ignored
   * for any worktree other than the one this store is currently tracking. */
  handleGitChanged(worktreePath: string): void;
  select(selection: ChangesSelection | null): void;
  setDiffMode(mode: DiffMode): void;
  dispatch(command: ChangesCommand): void;
  /** Restores the persisted `dmode`, mirroring `useStage`'s load(). */
  load(): Promise<void>;
}

const DEBOUNCE_MS = 250;
const pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>();

// ponytail: two independent counters (not one shared `revision`) so that select()'s diff fetch
// can't make an in-flight refresh() discard the status entries it already fetched. statusRevision
// guards refresh()'s own status fetch against a newer refresh/worktree-switch; diffRevision guards
// whichever diff fetch (from select() or refresh()) is the most recent for the current selection.
let statusRevision = 0;
let diffRevision = 0;

function entryExists(entries: StatusEntry[], path: string): boolean {
  return entries.some((entry) => entry.path === path);
}

export const useChanges = create<ChangesStore>((set, get) => ({
  worktree: null,
  entries: { staged: [], unstaged: [] },
  loading: false,
  error: null,
  selection: null,
  diff: null,
  dmode: "split",
  async refresh(worktreePath) {
    statusRevision++;
    const requestId = statusRevision;
    if (get().worktree !== worktreePath) {
      set({ worktree: worktreePath, entries: { staged: [], unstaged: [] }, selection: null, diff: null });
    }
    set({ loading: true, error: null });
    try {
      const status = await readStatus(worktreePath);
      if (statusRevision !== requestId) return; // a newer refresh/worktree-switch wins instead
      const selection = get().selection; // re-read: select() may have run while status was in flight
      const stillSelected =
        selection !== null &&
        entryExists(selection.area === "staged" ? status.staged : status.unstaged, selection.path);
      const nextSelection = stillSelected ? selection : null;
      set({
        entries: { staged: status.staged, unstaged: status.unstaged },
        selection: nextSelection,
        diff: nextSelection ? get().diff : null,
        loading: false,
        error: null,
      });
      if (!nextSelection) return;
      diffRevision++;
      const diffRequestId = diffRevision;
      try {
        const diff = await readDiff(worktreePath, nextSelection.path, nextSelection.area);
        if (diffRevision === diffRequestId) set({ diff });
      } catch {
        if (diffRevision === diffRequestId) set({ diff: null });
      }
    } catch (error) {
      if (statusRevision !== requestId) return;
      set({ loading: false, error: errorMessage(error) });
    }
  },
  handleGitChanged(worktreePath) {
    if (get().worktree !== worktreePath) return; // scope reactions to the active worktree
    const existing = pendingRefresh.get(worktreePath);
    if (existing) clearTimeout(existing);
    pendingRefresh.set(
      worktreePath,
      setTimeout(() => {
        pendingRefresh.delete(worktreePath);
        if (get().worktree !== worktreePath) return; // worktree switched while this timer waited
        void get().refresh(worktreePath);
      }, DEBOUNCE_MS),
    );
  },
  select(selection) {
    set({ selection, diff: null });
    const worktree = get().worktree;
    if (!selection || !worktree) return;
    diffRevision++;
    const diffRequestId = diffRevision;
    void readDiff(worktree, selection.path, selection.area)
      .then((diff) => {
        if (diffRevision === diffRequestId) set({ diff });
      })
      .catch(() => {
        if (diffRevision === diffRequestId) set({ diff: null });
      });
  },
  setDiffMode(mode) {
    set({ dmode: mode });
    void saveSetting("changesDmode", mode);
  },
  dispatch() {
    // ponytail: ChangesCommand is `never` -- no variants to handle until Tasks 06-08 widen it.
  },
  async load() {
    const saved = await loadSetting<DiffMode>("changesDmode");
    if (saved === "split" || saved === "inline") set({ dmode: saved });
  },
}));

// AC-4: `src/state/worktrees.ts` is the real equivalent of the task's `src/state/repo.ts` --
// it's the store that owns `activePath`, the active worktree. Registered once here (module
// scope = once per app session, same lifetime as the `useChanges` singleton itself) so this
// store reacts to a worktree switch on its own, regardless of which screen is mounted.
useWorktrees.subscribe((state, previousState) => {
  if (state.activePath === previousState.activePath) return;
  for (const timer of pendingRefresh.values()) clearTimeout(timer);
  pendingRefresh.clear();
  statusRevision++;
  diffRevision++;
  useChanges.setState({
    worktree: state.activePath,
    entries: { staged: [], unstaged: [] },
    selection: null,
    diff: null,
  });
});
