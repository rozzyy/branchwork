import { useSidebar } from "./sidebar";

it("toggles and restores the collapsed state", async () => {
  localStorage.clear();
  useSidebar.setState({ collapsed: false });
  useSidebar.getState().toggle();
  expect(useSidebar.getState().collapsed).toBe(true);
  useSidebar.setState({ collapsed: false });
  await useSidebar.getState().load();
  expect(useSidebar.getState().collapsed).toBe(true);
});

it("ignores legacy project rail visibility and keeps sidebar collapse", async () => {
  localStorage.clear();
  localStorage.setItem("bw:sidebar", JSON.stringify({ collapsed: false, projectRailOpen: false }));
  await useSidebar.getState().load();
  expect(useSidebar.getState().collapsed).toBe(false);
});
