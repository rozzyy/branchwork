import { handleGlobalKey } from "./globalKeys";
import { useStage } from "../state/stage";
import { usePalette } from "../palette/store";
import { useDialog } from "../ui/dialog";
import { initialStage } from "../stage/stageModel";
import { useSidebar } from "../state/sidebar";
import { useDock } from "../terminal/dock";
import { useSettings } from "../state/settings";
import { useShortcutSheet } from "../shell/ShortcutSheet";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

beforeEach(() => {
  useStage.setState({ ...initialStage });
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

it("⌘\\ toggles a right split and ⌘⇧\\ a bottom split", () => {
  handleGlobalKey(key({ key: "\\", code: "Backslash", metaKey: true }));
  expect(useStage.getState().panes).toEqual(["home", "changes"]);
  handleGlobalKey(key({ key: "\\", code: "Backslash", metaKey: true }));
  expect(useStage.getState().panes).toHaveLength(1);
  handleGlobalKey(key({ key: "|", code: "Backslash", metaKey: true, shiftKey: true }));
  expect(useStage.getState().dir).toBe("v");
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
