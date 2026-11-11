import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GithubAccounts } from "./GithubAccounts";
import { useGithubAccounts } from "../../github/store";
import {
  githubAuthStatus,
  openGithubUrl,
  pollGithubDeviceFlow,
  signOutGithub,
  startGithubDeviceFlow,
  verifyGithubPat,
} from "../../ipc/github";
import { loadSetting, saveSetting } from "../../ipc/settings";
import { ask } from "../../ui/dialog";
import { toast } from "../../ui/toast";

vi.mock("../../ipc/github", () => ({
  githubAuthStatus: vi.fn(),
  openGithubUrl: vi.fn(),
  pollGithubDeviceFlow: vi.fn(),
  signOutGithub: vi.fn(),
  startGithubDeviceFlow: vi.fn(),
  verifyGithubPat: vi.fn(),
}));

vi.mock("../../ipc/settings", () => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../ui/dialog", () => ({
  ask: vi.fn(),
}));

vi.mock("../../ui/toast", () => ({
  toast: vi.fn(),
}));

function seed(accounts: string[], defaultAccount: string | null = null) {
  useGithubAccounts.setState({ accounts, defaultAccount, loaded: true });
}

beforeEach(() => {
  seed([]);
  vi.mocked(loadSetting).mockReset().mockResolvedValue(null);
  vi.mocked(saveSetting).mockReset().mockResolvedValue(undefined);
  vi.mocked(githubAuthStatus).mockReset().mockResolvedValue({ linked: true });
  vi.mocked(openGithubUrl).mockReset().mockResolvedValue(undefined);
  vi.mocked(pollGithubDeviceFlow).mockReset();
  vi.mocked(signOutGithub).mockReset().mockResolvedValue(true);
  vi.mocked(startGithubDeviceFlow).mockReset();
  vi.mocked(verifyGithubPat).mockReset();
  vi.mocked(ask).mockReset();
  vi.mocked(toast).mockReset();
});

describe("account rows", () => {
  it("lists accounts with live status and the default badge", async () => {
    seed(["octocat", "hubot"], "hubot");
    render(<GithubAccounts />);
    expect(await screen.findByText("octocat")).toBeInTheDocument();
    expect(screen.getAllByText(/Logged in/)).toHaveLength(2);
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(githubAuthStatus).toHaveBeenCalledWith("octocat");
    expect(githubAuthStatus).toHaveBeenCalledWith("hubot");
  });

  it("prunes stale index entries the backend no longer knows", async () => {
    vi.mocked(githubAuthStatus).mockResolvedValue({ linked: false });
    seed(["ghost"]);
    render(<GithubAccounts />);
    await waitFor(() => expect(useGithubAccounts.getState().accounts).toEqual([]));
  });

  it("shows unavailable status with a retry affordance", async () => {
    vi.mocked(githubAuthStatus).mockRejectedValueOnce(new Error("offline"));
    seed(["octocat"]);
    render(<GithubAccounts />);
    expect(await screen.findByText("Login status unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(githubAuthStatus).toHaveBeenCalledTimes(2));
  });

  it("signs out with confirmation and prunes the index", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    seed(["octocat"]);
    render(<GithubAccounts />);
    expect(await screen.findByText("octocat")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(signOutGithub).toHaveBeenCalledWith("octocat"));
    expect(useGithubAccounts.getState().accounts).toEqual([]);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
  });

  it("prunes the index even when the backend reports nothing stored", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(signOutGithub).mockResolvedValue(false);
    seed(["octocat"]);
    render(<GithubAccounts />);
    expect(await screen.findByText("octocat")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(useGithubAccounts.getState().accounts).toEqual([]));
  });

  it("keeps the row when sign-out throws so no orphan token hides", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(signOutGithub).mockRejectedValue(new Error("keychain locked"));
    seed(["octocat"]);
    render(<GithubAccounts />);
    expect(await screen.findByText("octocat")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(signOutGithub).toHaveBeenCalledWith("octocat"));
    expect(useGithubAccounts.getState().accounts).toEqual(["octocat"]);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "keychain locked" }),
    );
  });

  it("sets and clears the default account", async () => {
    seed(["a", "b"], "a");
    render(<GithubAccounts />);
    expect(await screen.findByText("b")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Set as default" })[0]);
    expect(useGithubAccounts.getState().defaultAccount).toBe("b");
    fireEvent.click(screen.getByTitle("Clear default"));
    expect(useGithubAccounts.getState().defaultAccount).toBeNull();
  });
});

describe("device flow", () => {
  it("shows the code, polls at the backend interval, and adds the account", async () => {
    vi.mocked(startGithubDeviceFlow).mockResolvedValue({
      requestId: "gh-1",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 1,
    });
    vi.mocked(pollGithubDeviceFlow).mockResolvedValue({
      state: "pending",
      username: null,
      interval: 1,
    });
    render(<GithubAccounts />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    expect(screen.getByText(/github\.com\/login\/device/)).toBeInTheDocument();
    expect(openGithubUrl).toHaveBeenCalledWith("https://github.com/login/device");

    vi.mocked(pollGithubDeviceFlow).mockResolvedValue({
      state: "authorized",
      username: "octocat",
      interval: 1,
    });
    await waitFor(() => expect(useGithubAccounts.getState().accounts).toEqual(["octocat"]), {
      timeout: 5000,
    });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("octocat") }),
    );
  });

  it("stops polling when the flow is cancelled", async () => {
    vi.mocked(startGithubDeviceFlow).mockResolvedValue({
      requestId: "gh-3",
      userCode: "QQQQ-1111",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 60,
    });
    render(<GithubAccounts />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
    expect(await screen.findByText("QQQQ-1111")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("QQQQ-1111")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pollGithubDeviceFlow).not.toHaveBeenCalled();
    expect(useGithubAccounts.getState().accounts).toEqual([]);
  });

  it("surfaces expired outcomes without adding accounts", async () => {
    vi.mocked(startGithubDeviceFlow).mockResolvedValue({
      requestId: "gh-4",
      userCode: "EEEE-2222",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 1,
    });
    vi.mocked(pollGithubDeviceFlow).mockResolvedValue({
      state: "expired",
      username: null,
      interval: 1,
    });
    render(<GithubAccounts />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
    expect(await screen.findByText("EEEE-2222")).toBeInTheDocument();
    expect(await screen.findByText("The device code expired. Start again.")).toBeInTheDocument();
    expect(useGithubAccounts.getState().accounts).toEqual([]);
  });

  it("surfaces denied outcomes without adding accounts", async () => {
    vi.mocked(startGithubDeviceFlow).mockResolvedValue({
      requestId: "gh-2",
      userCode: "WXYZ-9999",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 1,
    });
    vi.mocked(pollGithubDeviceFlow).mockResolvedValue({
      state: "denied",
      username: null,
      interval: 1,
    });
    render(<GithubAccounts />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
    expect(await screen.findByText("WXYZ-9999")).toBeInTheDocument();
    expect(await screen.findByText("Sign-in was denied. Start again to retry.")).toBeInTheDocument();
    expect(useGithubAccounts.getState().accounts).toEqual([]);
  });
});

describe("PAT entry", () => {
  it("shows inline errors and stores verified tokens", async () => {
    vi.mocked(verifyGithubPat).mockRejectedValueOnce(new Error("Bad credentials"));
    render(<GithubAccounts />);
    const input = screen.getByLabelText("Personal access token");
    fireEvent.change(input, { target: { value: "ghp_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));
    expect(await screen.findByText("Bad credentials")).toBeInTheDocument();
    expect(useGithubAccounts.getState().accounts).toEqual([]);

    vi.mocked(verifyGithubPat).mockResolvedValueOnce("octocat");
    fireEvent.change(input, { target: { value: "ghp_good" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));
    await waitFor(() => expect(useGithubAccounts.getState().accounts).toEqual(["octocat"]));
  });
});
