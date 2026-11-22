import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach } from "vitest";
import { useRepos } from "./state/repos";
import { useGithubAccounts } from "./github/store";
import { useSessions } from "./agents/sessions";
import App from "./App";

beforeEach(() => {
  useRepos.setState({
    status: "ready",
    projects: [],
    groups: [],
    activeProjectId: null,
    activeGroupId: null,
  });
  useGithubAccounts.setState({ loaded: true, accounts: [], defaultAccount: null, ownerAccounts: {} });
  useSessions.setState({ loaded: true, sessions: [] });
});

it("renders the Branchwork shell", async () => {
  render(<App />);
  await waitFor(() => expect(document.querySelector(".splash")).toBeNull(), { timeout: 2_000 });
  expect(screen.getByRole("navigation", { name: "Workspace location" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New tab" })).toBeInTheDocument();
});
