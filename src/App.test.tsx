import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

it("navigates between placeholder screens from the sidebar", async () => {
  render(<App />);
  expect(screen.getByRole("heading", { level: 2, name: "Launchpad" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Changes/ }));
  expect(screen.getByRole("heading", { level: 2, name: "Changes" })).toBeInTheDocument();
});
