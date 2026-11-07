import { create } from "zustand";
import { readStatus, type StatusEntry } from "../ipc/status";
import { readDiff, type DiffArea, type DiffModel } from "../ipc/diff";
import {
  commit,
  commitAndPush,
  commitAndSync,
  discardPaths,
  revertHunk,
  stageHunks,
  stageLines,
  stagePaths,
  unstageHunks,
  unstagePaths,
  type CommitOptions,
} from "../ipc/changes";
import {
  stashApply,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
  type StashEntry,
  type StashPushOptions,
} from "../ipc/stash";
import { errorMessage } from "../ipc/errors";
import { loadSetting, saveSetting } from "../ipc/settings";
import { useWorktrees } from "./worktrees";
import { undoLast } from "./undoIntents";
import { toast } from "../ui/toast";
import { t } from "../i18n/t";

export type ChangesCommand =
  | { type: "stage-paths"; paths: string[] }
  | { type: "unstage-paths"; paths: string[] }
  | { type: "discard-paths"; paths: string[]; discardUntracked: boolean }
  | { type: "stage-hunks"; path: string; hunkIndices: number[]; area: DiffArea }
  | { type: "unstage-hunks"; path: string; hunkIndices: number[] }
  | { type: "stage-lines"; path: string; lineIds: string[]; area: DiffArea }
  | { type: "revert-hunk"; path: string; hunkIndex: number }
  | { type: "commit"; options: CommitOptions }
  | { type: "commit-and-push"; options: CommitOptions }
  | { type: "commit-and-sync"; options: CommitOptions }
  | { type: "stash-push"; options: StashPushOptions }
  | { type: "stash-apply"; index: number }
  | { type: "stash-pop"; index: number }
  | { type: "stash-drop"; index: number };

export type DiffMode = "split" | "inline";

export interface ChangesSelection {
  path: string;
  area: DiffArea;
}

interface ChangesStore {
  worktree: string | null;
  entries: { staged: StatusEntry[]; unstaged: StatusEntry[] };
  stashes: StashEntry[];
  loading: boolean;
  error: string | null;
  selection: ChangesSelection | null;
  diff: DiffModel | null;
  selectedLineIds: string[];
  dmode: DiffMode;
  /** Fetches status (and the diff for the current selection, if any) for `worktreePath`.
   * Clears entries/selection/diff first when `worktreePath` differs from the tracked worktree. */
  refresh(worktreePath: string): Promise<void>;
  /** Debounced reaction to the M1 `git:changed{worktree}` event (250ms per worktree), ignored
   * for any worktree other than the one this store is currently tracking. */
  handleGitChanged(worktreePath: string): void;
  select(selection: ChangesSelection | null): void;
  setDiffMode(mode: DiffMode): void;
  /** Runs a write command, toasts success/failure, refreshes status, and reports success. */
  dispatch(command: ChangesCommand): Promise<boolean>;
  toggleLine(lineId: string): void;
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
let stashRevision = 0;

function entryExists(entries: StatusEntry[], path: string): boolean {
  return entries.some((entry) => entry.path === path);
}

export const useChanges = create<ChangesStore>((set, get) => ({
  worktree: null,
  entries: { staged: [], unstaged: [] },
  stashes: [],
  loading: false,
  error: null,
  selection: null,
  diff: null,
  selectedLineIds: [],
  dmode: "split",
  async refresh(worktreePath) {
    statusRevision++;
    const requestId = statusRevision;
    if (get().worktree !== worktreePath) {
      set({
        worktree: worktreePath,
        entries: { staged: [], unstaged: [] },
        stashes: [],
        selection: null,
        diff: null,
        selectedLineIds: [],
      });
    }
    set({ loading: true, error: null });
    stashRevision++;
    const stashRequestId = stashRevision;
    void stashList(worktreePath)
      .then((stashes) => {
        if (stashRevision === stashRequestId && get().worktree === worktreePath) {
          set({ stashes });
        }
      })
      .catch(() => {
        if (stashRevision === stashRequestId && get().worktree === worktreePath) {
          set({ stashes: [] });
        }
      });
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
        selectedLineIds: [],
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
    set({ selection, diff: null, selectedLineIds: [] });
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
  async dispatch(command) {
    const worktree = get().worktree;
    if (!worktree) {
      toast({ title: t("changes.worktreeRequired"), icon: "!" });
      return false;
    }

    const action = commandAction(command);
    try {
      switch (command.type) {
        case "commit":
          await commit(worktree, command.options);
          break;
        case "commit-and-push":
          await commitAndPush(worktree, command.options);
          break;
        case "commit-and-sync":
          await commitAndSync(worktree, command.options);
          break;
        case "stash-push":
          await stashPush(worktree, command.options);
          break;
        case "stash-apply":
          await stashApply(worktree, command.index);
          break;
        case "stash-pop":
          await stashPop(worktree, command.index);
          break;
        case "stash-drop":
          await stashDrop(worktree, command.index);
          break;
        case "stage-paths":
          await stagePaths(worktree, command.paths);
          break;
        case "unstage-paths":
          await unstagePaths(worktree, command.paths);
          break;
        case "discard-paths":
          await discardPaths(worktree, command.paths, command.discardUntracked);
          break;
        case "stage-hunks":
          await stageHunks(worktree, command.path, command.hunkIndices, command.area);
          break;
        case "unstage-hunks":
          await unstageHunks(worktree, command.path, command.hunkIndices);
          break;
        case "stage-lines":
          await stageLines(worktree, command.path, command.lineIds, command.area);
          break;
        case "revert-hunk":
          await revertHunk(worktree, command.path, command.hunkIndex);
          break;
      }
      if (command.type === "stash-drop") {
        toast({
          title: t("changes.stashDropped"),
          detail: `stash@{${command.index}}`,
          icon: "🗑",
          action: { label: t("toast.undo"), run: () => undoLast(worktree) },
        });
      } else {
        toast({ title: t("changes.actionDone", { action }), icon: "✓" });
      }
      if (get().worktree === worktree) set({ selectedLineIds: [] });
      return true;
    } catch (error) {
      toast({
        title: t("changes.actionFailed", { action: action.toLowerCase(), message: errorMessage(error) }),
        icon: "!",
      });
      return false;
    } finally {
      if (get().worktree === worktree) await get().refresh(worktree);
    }
  },
  toggleLine(lineId) {
    set((state) => ({
      selectedLineIds: state.selectedLineIds.includes(lineId)
        ? state.selectedLineIds.filter((selected) => selected !== lineId)
        : [...state.selectedLineIds, lineId],
    }));
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
  stashRevision++;
  useChanges.setState({
    worktree: state.activePath,
    entries: { staged: [], unstaged: [] },
    stashes: [],
    selection: null,
    diff: null,
    selectedLineIds: [],
  });
});

function commandAction(command: ChangesCommand): string {
  switch (command.type) {
    case "commit":
      return t("changes.commit");
    case "commit-and-push":
      return t("changes.commitPush");
    case "commit-and-sync":
      return command.options.message.trim() || command.options.amend
        ? t("changes.commitSync")
        : t("changes.sync");
    case "stash-push":
      return t("changes.stash");
    case "stash-apply":
      return t("changes.stashApply");
    case "stash-pop":
      return t("changes.stashPop");
    case "stash-drop":
      return t("changes.stashDrop");
    case "stage-paths":
    case "stage-hunks":
    case "stage-lines":
      return t("changes.stage");
    case "unstage-paths":
    case "unstage-hunks":
      return t("changes.unstage");
    case "discard-paths":
      return t("changes.discard");
    case "revert-hunk":
      return t("diff.action.revert");
  }
}
