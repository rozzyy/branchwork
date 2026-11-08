import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useDock } from "./dock";
import { closeTerminal, spawnTerminal } from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { TerminalDock } from "./TerminalDock";

vi.mock("../ipc/pty", () => ({
  spawnTerminal: vi.fn(),
  closeTerminal: vi.fn(),
}));

vi.mock("../ipc/settings", () => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(),
}));

vi.mock("./CliPane", () => ({
  CliPane: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`pane-${sessionId}`}>
      {sessionId}
      <div className="cli-pane-screen" data-testid={`screen-${sessionId}`} />
    </div>
  ),
}));

function seed() {
  useDock.setState({
    open: true,
    mode: "bottom",
    bottomHeight: 260,
    rightWidth: 400,
    floating: { x: 80, y: 80, width: 720, height: 420 },
    tabs: [
      { id: "t1", worktreePath: "/wt/a", sessionId: "pty-a", error: null },
      { id: "t2", worktreePath: "/wt/b", sessionId: "pty-b", error: null },
    ],
    selectedId: "t1",
    splitIds: null,
    loaded: true,
  });
}

beforeEach(() => {
  vi.mocked(spawnTerminal).mockReset().mockImplementation(async (worktreePath: string) => ({ sessionId: `pty:${worktreePath}` }));
  vi.mocked(closeTerminal).mockReset().mockResolvedValue(undefined);
  vi.mocked(loadSetting).mockReset().mockResolvedValue(null);
  vi.mocked(saveSetting).mockReset().mockResolvedValue(undefined);
  seed();
});

it("renders the selected tab and switches panes on tab click", async () => {
  render(<TerminalDock />);
  expect(screen.getByTestId("pane-pty-a")).toBeInTheDocument();
  expect(screen.queryByTestId("pane-pty-b")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "Terminal in b" }));
  expect(screen.queryByTestId("pane-pty-a")).not.toBeInTheDocument();
  expect(screen.getByTestId("pane-pty-b")).toBeInTheDocument();
});

it("splits two sessions and swaps their order", async () => {
  render(<TerminalDock />);
  await userEvent.click(screen.getByRole("button", { name: "Split terminal" }));
  expect(screen.getByTestId("pane-pty-a")).toBeInTheDocument();
  expect(screen.getByTestId("pane-pty-b")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Swap terminal panes" }));
  const panes = screen.getAllByTestId(/pane-pty-/);
  expect(panes.map((pane) => pane.textContent)).toEqual(["pty-b", "pty-a"]);
});

it("closes tabs through the PTY owner and never on hide", async () => {
  render(<TerminalDock />);
  await userEvent.click(screen.getByRole("button", { name: "Close terminal tab b" }));
  expect(closeTerminal).toHaveBeenCalledWith("pty-b");
  expect(screen.queryByRole("tab", { name: "Terminal in b" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /Hide terminal dock/ }));
  expect(useDock.getState().open).toBe(false);
  expect(closeTerminal).toHaveBeenCalledTimes(1);
});

it("shows a worktree color dot on each tab", () => {
  const { container } = render(<TerminalDock />);
  const dots = container.querySelectorAll(".term-dock-dot");
  expect(dots).toHaveLength(2);
  dots.forEach((dot) => {
    expect((dot as HTMLElement).style.background).toBeTruthy();
  });
});

it("ignores Escape from inside terminal input", () => {
  const { container } = render(<TerminalDock />);
  const inner = container.querySelector(".cli-pane-screen") as HTMLElement;
  fireEvent.keyDown(inner, { key: "Escape" });
  expect(useDock.getState().open).toBe(true);
  fireEvent.keyDown(screen.getByLabelText("Terminal"), { key: "Escape" });
  expect(useDock.getState().open).toBe(false);
});

it("switches modes and persists the selection", async () => {
  render(<TerminalDock />);
  await userEvent.click(screen.getByRole("button", { name: "Dock right" }));
  expect(useDock.getState().mode).toBe("right");
  await userEvent.click(screen.getByRole("button", { name: "Maximize" }));
  expect(useDock.getState().mode).toBe("maximized");
  expect(within(screen.getByLabelText("Terminal")).getByRole("button", { name: "Dock bottom" })).toBeInTheDocument();
});
