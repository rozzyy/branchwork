import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSetting, saveSetting } from "../ipc/settings";
import { GITHUB_ACCOUNTS_KEY } from "./accounts";
import { useGithubAccounts } from "./store";

vi.mock("../ipc/settings", () => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(),
}));

function reset() {
  useGithubAccounts.setState({
    accounts: [],
    defaultAccount: null,
    ownerAccounts: {},
    loaded: false,
  });
}

beforeEach(() => {
  reset();
  vi.mocked(loadSetting).mockReset().mockResolvedValue(null);
  vi.mocked(saveSetting).mockReset().mockResolvedValue(undefined);
});

describe("load", () => {
  it("restores accounts and the default", async () => {
    vi.mocked(loadSetting).mockResolvedValueOnce({
      accounts: ["octocat", "hubot"],
      defaultAccount: "hubot",
    });
    await useGithubAccounts.getState().load();
    expect(useGithubAccounts.getState()).toMatchObject({
      accounts: ["octocat", "hubot"],
      defaultAccount: "hubot",
      loaded: true,
    });
  });

  it("falls back to the first account and to empty on bad data", async () => {
    vi.mocked(loadSetting).mockResolvedValueOnce({
      accounts: ["octocat"],
      defaultAccount: "ghost",
    });
    await useGithubAccounts.getState().load();
    expect(useGithubAccounts.getState().defaultAccount).toBe("octocat");

    reset();
    vi.mocked(loadSetting).mockResolvedValueOnce({ accounts: "nope" });
    await useGithubAccounts.getState().load();
    expect(useGithubAccounts.getState()).toMatchObject({ accounts: [], defaultAccount: null });
  });
});

describe("mutations", () => {
  it("adds accounts once and persists the index, never secrets", async () => {
    useGithubAccounts.getState().addAccount("octocat");
    useGithubAccounts.getState().addAccount("octocat");
    expect(useGithubAccounts.getState()).toMatchObject({
      accounts: ["octocat"],
      defaultAccount: "octocat",
    });
    await vi.waitFor(() =>
      expect(saveSetting).toHaveBeenCalledWith(GITHUB_ACCOUNTS_KEY, {
        accounts: ["octocat"],
        defaultAccount: "octocat",
        ownerAccounts: {},
      }),
    );
    const saved = vi.mocked(saveSetting).mock.calls[0][1] as unknown;
    expect(JSON.stringify(saved)).not.toContain("token");
  });

  it("removes accounts and moves the default", async () => {
    useGithubAccounts.setState({ accounts: ["a", "b"], defaultAccount: "a", loaded: true });
    useGithubAccounts.getState().removeAccount("a");
    expect(useGithubAccounts.getState()).toMatchObject({ accounts: ["b"], defaultAccount: "b" });
    await vi.waitFor(() =>
      expect(saveSetting).toHaveBeenCalledWith(GITHUB_ACCOUNTS_KEY, {
        accounts: ["b"],
        defaultAccount: "b",
        ownerAccounts: {},
      }),
    );
  });

  it("only defaults to a known account", () => {
    useGithubAccounts.setState({ accounts: ["a"], defaultAccount: "a", loaded: true });
    useGithubAccounts.getState().setDefault("ghost");
    expect(useGithubAccounts.getState().defaultAccount).toBe("a");
    useGithubAccounts.getState().setDefault(null);
    expect(useGithubAccounts.getState().defaultAccount).toBeNull();
  });
});

describe("per-owner account memory", () => {
  it("remembers the chosen account per repo owner and persists it", async () => {
    useGithubAccounts.setState({
      accounts: ["rozzyy", "rozzyrahmanda"],
      defaultAccount: "rozzyy",
      loaded: true,
    });
    useGithubAccounts.getState().setAccountForOwner("Shopfoodie", "rozzyrahmanda");
    expect(useGithubAccounts.getState().ownerAccounts).toEqual({
      shopfoodie: "rozzyrahmanda",
    });
    await vi.waitFor(() =>
      expect(saveSetting).toHaveBeenCalledWith(GITHUB_ACCOUNTS_KEY, {
        accounts: ["rozzyy", "rozzyrahmanda"],
        defaultAccount: "rozzyy",
        ownerAccounts: { shopfoodie: "rozzyrahmanda" },
      }),
    );
  });

  it("ignores unknown accounts and restores the memory on load", async () => {
    useGithubAccounts.setState({ accounts: ["a"], defaultAccount: "a", loaded: true });
    useGithubAccounts.getState().setAccountForOwner("org", "ghost");
    expect(useGithubAccounts.getState().ownerAccounts).toEqual({});
    vi.mocked(loadSetting).mockResolvedValueOnce({
      accounts: ["a", "b"],
      defaultAccount: "a",
      ownerAccounts: { org: "b", stale: "ghost", bad: 42 },
    });
    await useGithubAccounts.getState().load();
    expect(useGithubAccounts.getState().ownerAccounts).toEqual({ org: "b" });
  });
});
