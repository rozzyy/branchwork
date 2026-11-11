import { describe, expect, it } from "vitest";
import { GITHUB_ACCOUNTS_KEY } from "./accounts";

describe("github accounts index", () => {
  it("exposes a stable settings key for the username index", () => {
    expect(GITHUB_ACCOUNTS_KEY).toBe("githubAccounts");
  });
});
