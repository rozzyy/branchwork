import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands, type OpDone } from "./bindings";
import { errorMessage } from "./errors";
import { toast, useToasts } from "../ui/toast";

export function undoLast(worktreePath: string): void {
  void commands.undoLast(worktreePath).catch((error: unknown) => {
    toast({ title: errorMessage(error), icon: "⚠" });
  });
}

export function onOpDone(callback: (event: OpDone) => void): Promise<UnlistenFn> {
  return listen<OpDone>("op:done", (event) => callback(event.payload));
}

export function subscribeUndoState(): Promise<UnlistenFn> {
  return onOpDone(({ undoable }) => useToasts.getState().setUndoable(undoable));
}
