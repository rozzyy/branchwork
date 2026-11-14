import { render, screen } from "@testing-library/react";
import { CountBadge, StatusLabel } from "./StatusLabel";

it("status label shows icon and text", () => {
  render(<StatusLabel tone="bad" icon="⚠">2 conflicts</StatusLabel>);
  expect(screen.getByText("2 conflicts")).toBeInTheDocument();
  const icon = screen.getByText("⚠");
  expect(icon).toHaveAttribute("aria-hidden", "true");
});

it("count badge has an accessible label", () => {
  render(<CountBadge count={4} tone="warn" label="4 changes" />);
  const badge = screen.getByRole("status", { name: "4 changes" });
  expect(badge).toHaveTextContent("4");
});
