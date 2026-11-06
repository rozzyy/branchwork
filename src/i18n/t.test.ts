import { t } from "./t";

describe("t", () => {
  it("returns the English string for a key", () => {
    expect(t("nav.changes")).toBe("Changes");
  });
  it("interpolates {vars}", () => {
    expect(t("palette.goTo", { screen: "Graph" })).toBe("Go to Graph");
  });
});
