import { handleGlobalKey } from "./globalKeys";
import { useStage } from "../state/stage";
import { usePalette } from "../palette/store";
import { useDialog } from "../ui/dialog";
import { initialStage } from "../stage/stageModel";
import { useSidebar } from "../state/sidebar";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

beforeEach(() => {
  useStage.setState({ ...initialStage });
  usePalette.setState({ open: false, query: "" });
  useDialog.setState({ current: null });
  useSidebar.setState({ collapsed: false });
  (document.activeElement as HTMLElement | null)?.blur();
});

it("number keys switch screens in the focused pane", () => {
  expect(handleGlobalKey(key({ key: "4" }))).toBe(true);
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
  expect(useStage.getState().panes).toEqual(["launchpad", "changes"]);
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
