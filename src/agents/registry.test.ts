import { describe, expect, it } from "vitest";
import { CLI_IDS, CLI_REGISTRY, profileDirName, resolveCli, slugify } from "./registry";

describe("CLI registry", () => {
  it("declares every supported CLI with launch and resume argv", () => {
    expect(CLI_IDS).toEqual(["claude", "codex", "opencode", "gemini", "copilot", "muse", "custom"]);
    expect(CLI_REGISTRY.claude.resume).toEqual(["claude", "--continue"]);
    expect(CLI_REGISTRY.codex.resume).toEqual(["codex", "resume", "--last"]);
    expect(CLI_REGISTRY.opencode.resume).toEqual(["opencode", "--continue"]);
    expect(CLI_REGISTRY.gemini.resume).toEqual(["gemini"]);
    expect(CLI_REGISTRY.copilot.resume).toEqual(["copilot", "--continue"]);
    expect(CLI_REGISTRY.copilot.loginCmd).toBe("copilot login");
    expect(CLI_REGISTRY.muse.resume).toEqual(["muse", "resume", "--last"]);
    expect(CLI_REGISTRY.muse.loginCmd).toBe("muse login");
    for (const id of ["claude", "codex", "opencode", "gemini", "copilot", "muse"] as const) {
      expect(CLI_REGISTRY[id].launch.length).toBeGreaterThan(0);
      expect(CLI_REGISTRY[id].verifiedAgainst ?? "unverified").toBeTruthy();
    }
  });

  it("falls back to a fresh launch when resume fails on a profile without history", () => {
    expect(CLI_REGISTRY.claude.resumeLine).toBe("claude --continue || claude");
    expect(CLI_REGISTRY.codex.resumeLine).toBe("codex resume --last || codex");
    expect(CLI_REGISTRY.opencode.resumeLine).toBe("opencode --continue || opencode");
    expect(CLI_REGISTRY.copilot.resumeLine).toBe("copilot --continue || copilot");
    expect(CLI_REGISTRY.muse.resumeLine).toBe("muse resume --last || muse");
    expect(CLI_REGISTRY.gemini.resumeLine).toBeNull();
    expect(CLI_REGISTRY.custom.resumeLine).toBeNull();
  });

  it("marks unverifiable CLIs instead of fabricating verification", () => {
    expect(CLI_REGISTRY.gemini.verifiedAgainst).toBeNull();
    expect(CLI_REGISTRY.custom.verifiedAgainst).toBeNull();
  });

  it("gives each CLI lowercase waiting patterns and only configured limit patterns", () => {
    for (const id of CLI_IDS) {
      expect(CLI_REGISTRY[id].waitingPatterns.length).toBeGreaterThan(0);
      for (const pattern of [...CLI_REGISTRY[id].waitingPatterns, ...CLI_REGISTRY[id].limitPatterns]) {
        expect(pattern).toBe(pattern.toLowerCase());
        expect(pattern.length).toBeLessThanOrEqual(32);
      }
    }
    expect(CLI_REGISTRY.codex.limitPatterns).toEqual([]);
  });

  it("builds isolated profile environments per CLI", () => {
    expect(CLI_REGISTRY.claude.profileEnv("/p")).toEqual({ CLAUDE_CONFIG_DIR: "/p" });
    expect(CLI_REGISTRY.codex.profileEnv("/p")).toEqual({ CODEX_HOME: "/p" });
    expect(CLI_REGISTRY.opencode.profileEnv("/p")).toEqual({ HOME: "/p/home" });
    expect(CLI_REGISTRY.gemini.profileEnv("/p")).toEqual({ HOME: "/p/home" });
    expect(CLI_REGISTRY.copilot.profileEnv("/p")).toEqual({ HOME: "/p/home" });
    expect(CLI_REGISTRY.muse.profileEnv("/p")).toEqual({});
  });

  it("merges overrides without mutating the defaults", () => {
    const def = CLI_REGISTRY.claude;
    const resolved = resolveCli(def, {
      binary: "/opt/claude",
      launch: ["wrapped-claude", "--safe"],
      extraEnv: { EXTRA: "1" },
    });
    expect(resolved.binary).toBe("/opt/claude");
    expect(resolved.launch).toEqual(["wrapped-claude", "--safe"]);
    expect(resolved.resume).toEqual(["claude", "--continue"]);
    // Without a resume override the raw line survives untouched.
    expect(resolved.resumeLine).toBe("claude --continue || claude");
    // A resume override loses the raw line: callers quote the argv instead.
    const overridden = resolveCli(def, { resume: ["wrapped-claude", "--continue"] });
    expect(overridden.resumeLine).toBeNull();
    expect(resolved.envFor("/p")).toEqual({ CLAUDE_CONFIG_DIR: "/p", EXTRA: "1" });
    expect(def.binary).toBe("claude");
    expect(def.launch).toEqual(["claude"]);
  });

  it("requires a launch command for Custom", () => {
    expect(() => resolveCli(CLI_REGISTRY.custom)).toThrow();
    const resolved = resolveCli(CLI_REGISTRY.custom, { launch: ["my-agent", "--tui"] });
    expect(resolved.launch).toEqual(["my-agent", "--tui"]);
    expect(resolved.envFor("/p")).toEqual({});
  });

  it("slugifies profile names for directory use", () => {
    expect(slugify("Personal Work")).toBe("personal-work");
    expect(slugify("  ACME_corp!! ")).toBe("acme-corp");
    expect(slugify("")).toBe("profile");
    expect(slugify("---")).toBe("profile");
    expect(profileDirName("codex", "Personal")).toBe("codex-personal");
  });
});
