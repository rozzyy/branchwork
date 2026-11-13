import { describe, expect, it } from "vitest";
import { CAVEMAN_PROMPT, cavemanResumeLine, saverSupport, withCaveman } from "./savers";

describe("savers", () => {
  it("withCaveman adds the flag only for claude", () => {
    expect(withCaveman("claude", ["claude"])).toEqual(["claude", "--append-system-prompt", CAVEMAN_PROMPT]);
    expect(withCaveman("codex", ["codex"])).toEqual(["codex"]);
  });

  it("cavemanResumeLine quotes the prompt on both sides", () => {
    const line = cavemanResumeLine("claude", "claude --continue || claude");
    const flag = `--append-system-prompt '${CAVEMAN_PROMPT.replace(/'/g, `'\\''`)}'`;
    expect(line).toBe(`claude --continue ${flag} || claude ${flag}`);
    expect(cavemanResumeLine("codex", "codex resume --last || codex")).toBe("codex resume --last || codex");
  });

  it("supports both savers on claude only", () => {
    expect(saverSupport("claude")).toEqual({ rtk: true, caveman: true });
    expect(saverSupport("codex")).toEqual({ rtk: false, caveman: false });
  });

  it("keeps the concise instruction limited to brevity", () => {
    expect(CAVEMAN_PROMPT).toMatch(/never overrides correctness, security, validation/);
  });
});
