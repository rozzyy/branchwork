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
