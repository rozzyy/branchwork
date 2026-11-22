import { act, render, screen, within } from "@testing-library/react";
import { PaneChromeProvider, PaneHeader, usePaneChrome } from "./PaneHeader";
import { Stage } from "./Stage";
import { useStage, stageSnapshot } from "../state/stage";
import { initialStage } from "./stageModel";
import { useRepos } from "../state/repos";
import { useGithubAccounts } from "../github/store";
import { useSessions } from "../agents/sessions";
import { useWorktrees } from "../state/worktrees";

describe("PaneHeader", () => {
  // The cluster's "never clips/wraps" and the C4 ruling's "in-flow on the
  // active pane, overlay on the inactive pane" layouts are both real-browser
  // (CSS/layout) behavior that jsdom cannot see — proven instead by
  // `e2e/m13-stage3-headers.spec.ts` (was a CSS-string regex here, which
  // passed with the C2/C3/C4 bugs still present; see m13-stage-3-code-review).

  it("renders a visually hidden level-1 heading from `heading`, independent of what `identity` shows (I3)", () => {
    render(
      <PaneChromeProvider value={{ index: 0, active: true, controls: <div data-testid="controls">controls</div> }}>
        <PaneHeader heading="Agents" identity={<span>✦ not the heading text</span>} actions={null} />
      </PaneChromeProvider>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Agents" })).toBeInTheDocument();
  });

  it("renders no heading when none is given", () => {
    render(
      <PaneChromeProvider value={{ index: 0, active: true, controls: <div data-testid="controls">controls</div> }}>
        <PaneHeader identity={<span>Agents</span>} actions={null} />
      </PaneChromeProvider>,
    );
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("throws when used outside a Pane's PaneChromeProvider", () => {
    const Bare = () => <PaneHeader identity={<span>Agents</span>} actions={null} />;
    expect(() => render(<Bare />)).toThrow(/usePaneChrome/);
  });

  it("lays out identity, status, then the action cluster (screen actions before the pane's controls)", () => {
    render(
      <PaneChromeProvider value={{ index: 0, active: true, controls: <div data-testid="controls">controls</div> }}>
        <PaneHeader
          identity={<span data-testid="identity">Agents</span>}
          status={<span data-testid="status">status</span>}
          actions={<span data-testid="actions">actions</span>}
        />
      </PaneChromeProvider>,
    );
    const header = document.querySelector(".pane-header")!;
    expect(header.querySelector(".pane-header-identity")?.contains(screen.getByTestId("identity"))).toBe(true);
    expect(header.querySelector(".pane-header-status")?.contains(screen.getByTestId("status"))).toBe(true);
    const cluster = header.querySelector(".pane-header-cluster")!;
    const order = [...cluster.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual(["actions", "controls"]);
  });

  it("renders without a status element when the screen has none, but always renders the cluster", () => {
    render(
      <PaneChromeProvider value={{ index: 0, active: true, controls: <div data-testid="controls">controls</div> }}>
        <PaneHeader identity={<span>Agents</span>} actions={null} />
      </PaneChromeProvider>,
    );
    expect(document.querySelector(".pane-header-status")).toBeNull();
    expect(screen.getByTestId("controls")).toBeInTheDocument();
  });

  it("marks the row active (always-visible cluster) only when usePaneChrome().active is true", () => {
    const { rerender } = render(
      <PaneChromeProvider value={{ index: 0, active: true, controls: <button>Open beside</button> }}>
        <PaneHeader identity={<span>Agents</span>} actions={null} />
      </PaneChromeProvider>,
    );
    expect(document.querySelector(".pane-header")).toHaveClass("pane-header-active");

    rerender(
      <PaneChromeProvider value={{ index: 0, active: false, controls: <button>Open beside</button> }}>
        <PaneHeader identity={<span>Agents</span>} actions={null} />
      </PaneChromeProvider>,
    );
    expect(document.querySelector(".pane-header")).not.toHaveClass("pane-header-active");
    // Hidden-at-rest still means present and reachable, not removed (G1).
    expect(screen.getByRole("button", { name: "Open beside" })).toBeInTheDocument();
  });

  it("exposes the pane's index, controls and active flag through usePaneChrome", () => {
    function Probe() {
      const { index, controls, active } = usePaneChrome();
      return (
        <div data-testid="probe" data-index={index} data-active={active}>
          {controls}
        </div>
      );
    }
    render(
      <PaneChromeProvider value={{ index: 2, active: false, controls: <span>ctl</span> }}>
        <Probe />
      </PaneChromeProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveAttribute("data-index", "2");
    expect(screen.getByTestId("probe")).toHaveAttribute("data-active", "false");
    expect(screen.getByText("ctl")).toBeInTheDocument();
  });
});

describe("Pane header ownership and visibility (AC1/AC3)", () => {
  beforeEach(() => {
    useStage.setState(stageSnapshot(initialStage));
    useRepos.setState({
      status: "ready",
      projects: [{ id: "p1", owner: null, name: "repo", localPath: "/repos/main", groupId: null }],
      groups: [],
      activeProjectId: "p1",
      activeGroupId: null,
    });
    useWorktrees.setState({
      projectId: "p1",
      worktrees: [{ path: "/repos/main", branch: "main", head: "a1", ahead: 0, behind: 0, dirtyCount: 0, state: "clean" }],
      pinnedPaths: [],
      activePath: "/repos/main",
      selections: {},
      byProject: {},
      loading: false,
      error: null,
    });
    useGithubAccounts.setState({ loaded: true, accounts: [], defaultAccount: null, ownerAccounts: {} });
    useSessions.setState({ loaded: true, sessions: [] });
  });

  it("renders no header.pane-tool for the Agents screen; it owns its own PaneHeader instead", () => {
    act(() => useStage.getState().setLayout(["agents"]));
    render(<Stage />);
    expect(document.querySelector(".pane-tool")).toBeNull();
    expect(document.querySelector(".pane-header")).not.toBeNull();
    // The split controls still reach the row through PaneChromeContext.
    expect(screen.getByRole("button", { name: /Open beside/ })).toBeInTheDocument();
    // The only stage pane is always "active": its cluster never hides.
    expect(document.querySelector(".pane-header")).toHaveClass("pane-header-active");
  });

  it("still renders header.pane-tool unchanged for Changes, a screen that does not own its header", () => {
    act(() => useStage.getState().setLayout(["changes"]));
    render(<Stage />);
    expect(document.querySelector(".pane-tool")).not.toBeNull();
    expect(document.querySelector(".pane-header")).toBeNull();
  });

  it("in a split, the Agents pane's header is active only while it's focused; unfocused, it still carries every control", () => {
    // The stage can't hold the same screen twice (setLayout dedupes by
    // screen id), so the split pairs Agents with a screen that doesn't own
    // its header — exactly what AC3 needs to exercise the active toggle.
    act(() => useStage.getState().setLayout(["agents", "changes"]));
    const agentsIndex = useStage.getState().panes.indexOf("agents");
    render(<Stage />);
    const header = document.querySelector(".pane-header") as HTMLElement;
    expect(header).not.toBeNull();

    act(() => useStage.getState().focusPane(agentsIndex));
    expect(header).toHaveClass("pane-header-active");
    expect(within(header).getByRole("button", { name: "Close pane" })).toBeInTheDocument();

    act(() => useStage.getState().focusPane(1 - agentsIndex));
    expect(header).not.toHaveClass("pane-header-active");
    // Hidden at rest (CSS opacity only) but still in the DOM, with the same
    // accessible name — AC3's "every control present either way".
    expect(within(header).getByRole("button", { name: "Close pane" })).toBeInTheDocument();
  });
});
