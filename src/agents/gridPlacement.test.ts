import { gridPlacement } from "./gridPlacement";

const pane = (id: string, slot: "left" | "right" | "auto" | "full") => ({ id, slot });

it("gives a lone left pane the full height beside two stacked right panes", () => {
  const { rows, places } = gridPlacement([pane("a", "left"), pane("b", "right"), pane("c", "right")]);
  expect(rows).toBe(2);
  expect(places.get("a")).toEqual({ column: "1", row: "1 / span 2" });
  expect(places.get("b")).toEqual({ column: "2", row: "1 / span 1" });
  expect(places.get("c")).toEqual({ column: "2", row: "2 / span 1" });
});

it("balances auto panes into the emptier column, left first", () => {
  const { places } = gridPlacement([pane("a", "auto"), pane("b", "auto"), pane("c", "auto")]);
  expect(places.get("a")?.column).toBe("1");
  expect(places.get("b")?.column).toBe("2");
  expect(places.get("c")?.column).toBe("1");
  // Left holds two, right one: the right pane spans both rows.
  expect(places.get("b")?.row).toBe("1 / span 2");
});

it("uses the least common row count for uneven columns", () => {
  const { rows, places } = gridPlacement([pane("a", "left"), pane("b", "left"), pane("c", "right"), pane("d", "right"), pane("e", "right")]);
  expect(rows).toBe(6);
  expect(places.get("a")?.row).toBe("1 / span 3");
  expect(places.get("b")?.row).toBe("4 / span 3");
  expect(places.get("e")?.row).toBe("5 / span 2");
});

it("puts full-width panes below the columns at one pane's height", () => {
  const { rows, places } = gridPlacement([pane("a", "left"), pane("b", "right"), pane("c", "right"), pane("f", "full")]);
  expect(rows).toBe(3);
  expect(places.get("f")).toEqual({ column: "1 / -1", row: "3 / span 1" });
});

it("handles only full-width panes", () => {
  const { rows, places } = gridPlacement([pane("f", "full"), pane("g", "full")]);
  expect(rows).toBe(2);
  expect(places.get("g")).toEqual({ column: "1 / -1", row: "2 / span 1" });
});
