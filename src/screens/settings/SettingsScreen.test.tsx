import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsView } from "./SettingsScreen";
import { useSettings } from "../../state/settings";
import { DEFAULT_THEME } from "../../theme/theme";

beforeEach(() => useSettings.setState({ theme: DEFAULT_THEME }));

it("changes theme mode and density from the Appearance card", async () => {
  render(<SettingsView />);
  await userEvent.click(screen.getByRole("radio", { name: "Light" }));
  await userEvent.click(screen.getByRole("radio", { name: "Compact" }));
  expect(useSettings.getState().theme.mode).toBe("light");
  expect(useSettings.getState().theme.density).toBe("compact");
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("toggles reduce transparency", async () => {
  render(<SettingsView />);
  await userEvent.click(screen.getByRole("switch", { name: "Reduce transparency" }));
  expect(useSettings.getState().theme.reduceTransparency).toBe(true);
});
