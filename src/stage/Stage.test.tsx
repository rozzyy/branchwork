import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Stage } from "./Stage";
import { useStage } from "../state/stage";
import { initialStage } from "./stageModel";
import { useRepos } from "../state/repos";
import { useGithubAccounts } from "../github/store";
import { useSessions } from "../agents/sessions";

beforeEach(() => {
  useStage.setState({ ...initialStage });
  useRepos.setState({ status: "ready", projects: [], groups: [], activeProjectId: null, activeGroupId: null });
  useGithubAccounts.setState({ loaded: true, accounts: [], defaultAccount: null, ownerAccounts: {} });
  useSessions.setState({ loaded: true, sessions: [] });
});

it("opens a split from Open beside and closes it from the pane", async () => {
  render(<Stage />);
  await userEvent.click(screen.getByRole("button", { name: /Open beside/ }));
  await userEvent.click(screen.getAllByRole("menuitem").find((item) => item.querySelector(".menu-label")?.textContent === "Changes")!);
  expect(screen.getByRole("heading", { level: 1, name: /^Home/ })).toBeInTheDocument();
  expect(screen.getByRole("separator")).toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: "Close pane" })[1]);
  expect(screen.getByRole("heading", { level: 1, name: /^Home/ })).toBeInTheDocument();
});

it("opens a bottom split from the direction icon", async () => {
  render(<Stage />);
  await userEvent.click(screen.getByRole("button", { name: /Open beside/ }));
  const item = screen.getAllByRole("menuitem").find((entry) => entry.querySelector(".menu-label")?.textContent === "History")!;
  await userEvent.click(item.querySelector('[title="Split bottom"]')!);
  expect(useStage.getState().panes).toEqual(["home", "history"]);
  expect(useStage.getState().dir).toBe("v");
});
