import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach } from "vitest";
import { useRepos } from "./state/repos";
import { useGithubAccounts } from "./github/store";
import { useSessions } from "./agents/sessions";
import App from "./App";

beforeEach(() => {
  useRepos.setState({ status: "ready", projects: [], groups: [], activeProjectId: null, activeGroupId: null });
  useGithubAccounts.setState({ loaded: true, accounts: [], defaultAccount: null, ownerAccounts: {} });
  useSessions.setState({ loaded: true, sessions: [] });
});

it("navigates from Launchpad to Changes using the sidebar", async () => {
  render(<App />);
  expect(screen.getByRole("heading", { level: 1, name: /^Launchpad/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Changes/ }));
  expect(screen.getByRole("heading", { level: 2, name: "Changes" })).toBeInTheDocument();
});
