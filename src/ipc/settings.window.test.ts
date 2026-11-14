import { loadSetting, onGlobalSettingSaved, saveSetting, scopedKey, windowLabel } from "./settings";

beforeEach(() => localStorage.clear());
afterEach(() => onGlobalSettingSaved(null));

it("keeps main window keys plain and namespaces secondary windows' workspace keys", () => {
  expect(windowLabel()).toBe("main");
  expect(scopedKey("stage")).toBe("stage");
  expect(scopedKey("stage", "ws-2")).toBe("ws-2:stage");
  expect(scopedKey("agentSessions", "ws-2")).toBe("ws-2:agentSessions");
  // App-wide settings are shared by every window.
  expect(scopedKey("theme", "ws-2")).toBe("theme");
  expect(scopedKey("agentProfiles", "ws-2")).toBe("agentProfiles");
});

it("seeds another window's scoped keys without touching this window's", async () => {
  await saveSetting("stage", { a: 1 });
  await saveSetting("stage", { b: 2 }, "ws-3");
  expect(localStorage.getItem("bw:ws-3:stage")).toBe('{"b":2}');
  expect(await loadSetting("stage")).toEqual({ a: 1 });
});

it("announces app-wide saves only", async () => {
  const saved: string[] = [];
  onGlobalSettingSaved((key) => saved.push(key));
  await saveSetting("theme", { mode: "dark" });
  await saveSetting("stage", {});
  expect(saved).toEqual(["theme"]);
});
