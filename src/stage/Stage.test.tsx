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

it("opens a split from the ⊞ menu and closes it from the pane", async () => {
  render(<Stage />);
  await userEvent.click(screen.getByRole("button", { name: /Split with/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Changes/ }));
  expect(screen.getByRole("heading", { level: 1, name: /^Launchpad/ })).toBeInTheDocument();
  expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([expect.stringMatching(/Good (morning|afternoon|evening)/), "Changes"]);
  expect(screen.getByRole("separator")).toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: "Close pane" })[1]);
  expect(screen.getByRole("heading", { level: 1, name: /^Launchpad/ })).toBeInTheDocument();
  expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([expect.stringMatching(/Good (morning|afternoon|evening)/)]);
});

it("opens a bottom split from the direction icon", async () => {
  render(<Stage />);
  await userEvent.click(screen.getByRole("button", { name: /Split with/ }));
  const item = screen.getByRole("menuitem", { name: /Graph/ });
  await userEvent.click(item.querySelector('[title="Split bottom"]')!);
  expect(useStage.getState().panes).toEqual(["launchpad", "graph"]);
  expect(useStage.getState().dir).toBe("v");
});
