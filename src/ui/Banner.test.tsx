import { render, screen } from "@testing-library/react";
import { Banner } from "./Banner";

it("banner announces itself", () => {
  render(
    <Banner tone="bad" icon="⚠" title="Rebase paused at 3/7" detail="2 files in conflict" actions={<button>Resolve</button>} />,
  );
  expect(screen.getByRole("status")).toBeInTheDocument();
  expect(screen.getByText("Rebase paused at 3/7")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Resolve" })).toBeInTheDocument();
});
