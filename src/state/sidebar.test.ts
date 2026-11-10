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

it("persists right project rail visibility without changing sidebar collapse", async () => {
  localStorage.clear();
  useSidebar.setState({ collapsed: false, projectRailOpen: true });
  useSidebar.getState().toggleProjectRail();
  expect(useSidebar.getState().projectRailOpen).toBe(false);
  expect(useSidebar.getState().collapsed).toBe(false);

  useSidebar.setState({ projectRailOpen: true });
  await useSidebar.getState().load();
  expect(useSidebar.getState().projectRailOpen).toBe(false);
  expect(useSidebar.getState().collapsed).toBe(false);
});
