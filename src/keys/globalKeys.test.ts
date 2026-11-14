import { handleGlobalKey } from "./globalKeys";
import { useStage, stageSnapshot } from "../state/stage";
import { usePalette } from "../palette/store";
import { useDialog } from "../ui/dialog";
import { initialStage } from "../stage/stageModel";
import { useSidebar } from "../state/sidebar";
import { useDock } from "../terminal/dock";
import { useSettings } from "../state/settings";
import { useShortcutSheet } from "../shell/ShortcutSheet";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

beforeEach(() => {
  useStage.setState(stageSnapshot(initialStage));
  usePalette.setState({ open: false, query: "" });
  useDialog.setState({ current: null });
  useSidebar.setState({ collapsed: false });
  useDock.setState({ open: false });
  useSettings.setState({ singleKeyShortcuts: false });
  useShortcutSheet.setState({ open: false });
  (document.activeElement as HTMLElement | null)?.blur();
});

it("modifier digits navigate while bare digits need the setting", () => {
  expect(handleGlobalKey(key({ key: "3", metaKey: true }))).toBe(true);
  expect(useStage.getState().panes).toEqual(["history"]);
  expect(handleGlobalKey(key({ key: "2" }))).toBe(false);
  useSettings.setState({ singleKeyShortcuts: true });
  expect(handleGlobalKey(key({ key: "2" }))).toBe(true);
  expect(useStage.getState().panes).toEqual(["changes"]);
});

it("ignores number keys while typing", () => {
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  expect(handleGlobalKey(key({ key: "2" }))).toBe(false);
  input.remove();
});

it("⌘K toggles the palette", () => {
  handleGlobalKey(key({ key: "k", metaKey: true }));
  expect(usePalette.getState().open).toBe(true);
});

it("⌘\\ splits right, ⌘⇧\\ below, ⌘⌥\\ closes the focused pane", () => {
  handleGlobalKey(key({ key: "\\", code: "Backslash", metaKey: true }));
  expect(useStage.getState().panes).toEqual(["home", "changes"]);
  handleGlobalKey(key({ key: "|", code: "Backslash", metaKey: true, shiftKey: true }));
  expect(useStage.getState().panes).toEqual(["home", "changes", "agents"]);
  handleGlobalKey(key({ key: "\\", code: "Backslash", metaKey: true }));
  handleGlobalKey(key({ key: "\\", code: "Backslash", metaKey: true }));
  expect(useStage.getState().panes).toHaveLength(4);
  handleGlobalKey(key({ key: "«", code: "Backslash", metaKey: true, altKey: true }));
  expect(useStage.getState().panes).toHaveLength(3);
});

it("⌘⌥ arrows move pane focus but leave a focused Terminal screen alone", () => {
  handleGlobalKey(key({ key: "\\", code: "Backslash", metaKey: true }));
  expect(handleGlobalKey(key({ key: "ArrowLeft", metaKey: true, altKey: true }))).toBe(true);
  expect(useStage.getState().panes[useStage.getState().focus]).toBe("home");
  // Stage focus on the Terminal pane but the keyboard elsewhere: still moves.
  useStage.getState().go("terminal");
  expect(handleGlobalKey(key({ key: "ArrowRight", metaKey: true, altKey: true }))).toBe(true);
  expect(useStage.getState().panes[useStage.getState().focus]).toBe("changes");
  // Keyboard inside the Terminal screen: the terminal handles the chord.
  const term = document.createElement("div");
  term.className = "term-screen";
  const input = document.createElement("textarea");
  term.append(input);
  document.body.append(term);
  input.focus();
  expect(handleGlobalKey(key({ key: "ArrowLeft", metaKey: true, altKey: true }))).toBe(false);
  term.remove();
});

it("⌃⇧G goes to Changes", () => {
  handleGlobalKey(key({ key: "G", ctrlKey: true, shiftKey: true }));
  expect(useStage.getState().panes).toEqual(["changes"]);
});

it("⌘B toggles the sidebar", () => {
  handleGlobalKey(key({ key: "b", metaKey: true }));
  expect(useSidebar.getState().collapsed).toBe(true);
});

it("⌃` toggles the terminal dock", () => {
  expect(handleGlobalKey(key({ key: "`", code: "Backquote", ctrlKey: true }))).toBe(true);
  expect(useDock.getState().open).toBe(true);
  handleGlobalKey(key({ key: "`", code: "Backquote", ctrlKey: true }));
  expect(useDock.getState().open).toBe(false);
});

it("keeps Ctrl+` working from the terminal input", () => {
  const terminalInput = document.createElement("textarea");
  terminalInput.className = "xterm-helper-textarea";
  document.body.append(terminalInput);
  terminalInput.focus();
  expect(handleGlobalKey(key({ key: "`", code: "Backquote", ctrlKey: true }))).toBe(true);
  expect(useDock.getState().open).toBe(true);
  terminalInput.remove();
});

it("opens the shortcut sheet with ?", () => {
  expect(handleGlobalKey(key({ key: "?" }))).toBe(true);
  expect(useShortcutSheet.getState().open).toBe(true);
});
