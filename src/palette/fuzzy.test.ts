import { fuzzyScore, rank } from "./fuzzy";

describe("fuzzyScore", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyScore("gch", "Go to Changes")).not.toBeNull();
    expect(fuzzyScore("xyz", "Go to Changes")).toBeNull();
  });
  it("scores contiguous and word-start matches higher", () => {
    expect(fuzzyScore("chan", "Go to Changes")!).toBeGreaterThan(fuzzyScore("chan", "Check a new screen")!);
  });
  it("returns 0 for an empty query", () => {
    expect(fuzzyScore("  ", "anything")).toBe(0);
  });
});

describe("rank", () => {
  it("filters and orders by score, keeping input order for empty queries", () => {
    const items = ["Go to Graph", "Go to Changes", "Split right with Changes"];
    expect(rank(items, "", (x) => x)).toEqual(items);
    expect(rank(items, "changes", (x) => x)).toEqual(["Go to Changes", "Split right with Changes"]);
  });
});
