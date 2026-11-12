import { t } from "./t";
import { en, type MsgKey } from "./en";

const checkedKeys = [
  "ui.deferred_m3",
  "ui.deferred_m4",
  "ui.deferred_m7",
  "palette.openChanges",
  "palette.openFiles",
  "palette.openBlame",
  "palette.toggleStaged",
  "palette.discardAll",
  "editor.encodingUtf8",
  "editor.language.typescript",
  "editor.language.typescriptJsx",
  "editor.language.javascript",
  "editor.language.javascriptJsx",
  "editor.language.json",
  "editor.language.markdown",
  "editor.language.css",
  "editor.language.html",
  "editor.language.rust",
  "editor.language.go",
  "editor.language.python",
  "editor.language.yaml",
  "editor.language.toml",
  "editor.language.plain",
  "graph.inspector",
  "graph.editorTabs",
  "graph.diffTab",
  "graph.closeDiffTab",
  "graph.openDiff",
  "graph.openCommitDiff",
  "graph.files.commit",
  "graph.stageFile",
  "graph.unstageFile",
  "graph.loadingDiff",
  "graph.diffError",
] satisfies readonly MsgKey[];

describe("t", () => {
  it("returns the English string for a key", () => {
    expect(t("nav.changes")).toBe("Changes");
  });
  it("interpolates {vars}", () => {
    expect(t("palette.goTo", { screen: "Graph" })).toBe("Go to Graph");
  });
  it("defines Task 15 messages and emits no missing-key warnings", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const key of checkedKeys) {
      expect(en[key].trim()).not.toBe("");
      expect(t(key)).toBe(en[key]);
    }
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});
