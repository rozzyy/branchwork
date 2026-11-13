import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { useGithubAccounts } from "../../github/store";
import { ghPublishOwners, ghRepoPublish, gitHasOrigin } from "../../ipc/publish";
import { openGithubRepo } from "../../ipc/repo";
import { useGitBusy } from "../../state/gitActions";
import { useWorktrees } from "../../state/worktrees";
import { toast } from "../../ui/toast";
import { PublishDialogHost, sanitizeRepoName, useOriginMissing, usePublish } from "./PublishDialog";

vi.mock("../../ipc/publish", () => ({ ghPublishOwners: vi.fn(), ghRepoPublish: vi.fn(), gitHasOrigin: vi.fn() }));
vi.mock("../../ipc/repo", () => ({ ghRepoRemote: vi.fn(), openGithubRepo: vi.fn() }));
vi.mock("../../ui/toast", () => ({ toast: vi.fn() }));

const WT = "/projects/My App";

function setup(head = "abc123") {
  act(() => {
    useGithubAccounts.setState({ accounts: ["rozzy", "work"], defaultAccount: "work", loaded: true, load: vi.fn(async () => {}) });
    useWorktrees.setState({ worktrees: [{ path: WT, branch: "main", head, ahead: 0, behind: 0, dirtyCount: 0, state: "clean" }] });
    usePublish.setState({ worktree: WT, revision: 0 });
  });
  render(<PublishDialogHost />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useGitBusy.setState({ running: {} });
  vi.mocked(ghPublishOwners).mockResolvedValue([
    { login: "work", id: "U_1", kind: "user" },
    { login: "acme", id: "O_1", kind: "organization" },
  ]);
});

it("defaults to private with the sanitized folder name and the default account", async () => {
  setup();

  expect(sanitizeRepoName("café")).toBe("caf");
  expect(sanitizeRepoName("..x")).toBe("x");
  expect(sanitizeRepoName("")).toBe("project");
  expect(screen.getByRole("textbox", { name: "Repository name" })).toHaveValue("My-App");
  expect(screen.getByRole("combobox", { name: "Account" })).toHaveValue("work");
  expect(screen.getByRole("radio", { name: "Private" })).toBeChecked();
  await waitFor(() => expect(ghPublishOwners).toHaveBeenCalledWith("work"));
  expect(await screen.findByRole("option", { name: "acme" })).toBeInTheDocument();
});

it("is disabled with an explanation when the branch has no commits", async () => {
  setup("");
  await waitFor(() => expect(ghPublishOwners).toHaveBeenCalled());

  expect(screen.getByText("Make a first commit before publishing.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
});

it("publishes and offers Open on GitHub", async () => {
  vi.mocked(ghRepoPublish).mockResolvedValue({ url: "https://github.com/work/My-App", pushed: true, pushError: null });
  setup();
  await screen.findByRole("option", { name: "acme" });

  await userEvent.click(screen.getByRole("button", { name: "Publish" }));

  await waitFor(() =>
    expect(ghRepoPublish).toHaveBeenCalledWith(WT, { account: "work", owner: "work", name: "My-App", private: true, description: "" }),
  );
  const shown = vi.mocked(toast).mock.calls[0][0];
  expect(shown.title).toBe("Published to work/My-App");
  shown.action?.run();
  expect(openGithubRepo).toHaveBeenCalledWith("work", "My-App");
  expect(usePublish.getState().worktree).toBeNull();
});

it("reports a kept repository when the first push fails", async () => {
  vi.mocked(ghRepoPublish).mockResolvedValue({
    url: "https://github.com/work/My-App",
    pushed: false,
    pushError: { kind: "network", message: "Git push failed: the remote could not be reached", detail: "Failed to connect", recoverable: true },
  });
  setup();
  await screen.findByRole("option", { name: "acme" });

  await userEvent.click(screen.getByRole("button", { name: "Publish" }));

  await waitFor(() => expect(toast).toHaveBeenCalled());
  const shown = vi.mocked(toast).mock.calls[0][0];
  expect(shown.title).toBe("Created work/My-App on GitHub, but the first push failed. Retry with Push.");
  expect(shown.details).toBe("Failed to connect");
});

// Regression: a GitLab/Bitbucket origin was treated as "no origin" and still offered Publish.
it("offers Publish only when the worktree has no origin of any host", async () => {
  function Probe({ path }: { path: string }) {
    return <span>{useOriginMissing(path) ? "missing" : "present"}</span>;
  }
  vi.mocked(gitHasOrigin).mockResolvedValueOnce(true);
  const { unmount } = render(<Probe path="/with-gitlab-origin" />);
  await waitFor(() => expect(gitHasOrigin).toHaveBeenCalledWith("/with-gitlab-origin"));
  expect(screen.getByText("present")).toBeInTheDocument();
  unmount();

  vi.mocked(gitHasOrigin).mockResolvedValueOnce(false);
  render(<Probe path="/fresh" />);
  expect(await screen.findByText("missing")).toBeInTheDocument();
});
