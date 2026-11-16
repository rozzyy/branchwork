import { describe, expect, it } from "vitest";
import { getLoginAdapter, isAllowedLoginUrl } from "./login";

describe("provider login adapters", () => {
  it("uses fixed browser login argv for built-in providers", () => {
    expect(getLoginAdapter("claude")?.buildArgs()).toEqual(["auth", "login"]);
    expect(getLoginAdapter("codex")?.buildArgs()).toEqual(["login"]);
    expect(getLoginAdapter("gemini")?.buildArgs()).toEqual([]);
    expect(getLoginAdapter("copilot")?.buildArgs()).toEqual(["login", "--web-flow"]);
    expect(getLoginAdapter("muse")?.buildArgs()).toEqual(["login"]);
    expect(getLoginAdapter("custom")).toBeNull();
  });

  it("requires a catalogued OpenCode OAuth method", () => {
    const adapter = getLoginAdapter("opencode");
    expect(adapter?.buildArgs({ providerId: "openai", methodId: "device" })).toEqual([
      "auth", "login", "openai", "--method", "device",
    ]);
    expect(() => adapter?.buildArgs({ providerId: "openai; touch /tmp/pwned", methodId: "device" })).toThrow();
    expect(() => adapter?.buildArgs({ providerId: "anthropic", methodId: "key" })).toThrow();
    expect(() => adapter?.buildArgs()).toThrow();
  });

  it("keeps profile environment and device-wide credential scope explicit", () => {
    expect(getLoginAdapter("codex")?.envFor("/profiles/codex-work")).toEqual({
      CODEX_HOME: "/profiles/codex-work",
    });
    expect(getLoginAdapter("muse")?.credentialScope).toBe("device");
    expect(getLoginAdapter("copilot")?.credentialScope).toBe("device");
  });

  it("opens only HTTPS URLs on the selected provider's browser host allowlist", () => {
    const adapter = getLoginAdapter("codex")!;
    expect(isAllowedLoginUrl(adapter, "https://auth.openai.com/oauth/authorize?state=x"))
      .toBe("https://auth.openai.com/oauth/authorize?state=x");
    expect(isAllowedLoginUrl(adapter, "http://auth.openai.com/authorize")).toBeNull();
    expect(isAllowedLoginUrl(adapter, "https://auth.openai.com.attacker.test/authorize")).toBeNull();
    expect(isAllowedLoginUrl(adapter, "https://evil.test/authorize")).toBeNull();
  });
});
