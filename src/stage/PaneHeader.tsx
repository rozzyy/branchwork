import { createContext, useContext, type ReactNode } from "react";

/** A stage pane's index, its `PaneControls` element, and whether its chrome
 * should always show (single pane, or the focused pane in a split — the
 * same pane that shows the accent line). Handed to a screen that owns its
 * own header (`ScreenView.ownsHeader`) via `Pane`, so it can place the same
 * split controls at the end of its own `PaneHeader` action cluster instead
 * of `Pane` rendering `header.pane-tool`. */
export interface PaneChromeValue {
  index: number;
  controls: ReactNode;
  active: boolean;
}

const PaneChromeContext = createContext<PaneChromeValue | null>(null);

export function PaneChromeProvider({ value, children }: { value: PaneChromeValue; children: ReactNode }) {
  return <PaneChromeContext.Provider value={value}>{children}</PaneChromeContext.Provider>;
}

/** Only valid under a `Pane` (which always provides it). */
export function usePaneChrome(): PaneChromeValue {
  const value = useContext(PaneChromeContext);
  if (!value) throw new Error("usePaneChrome must be used within a Pane");
  return value;
}

/**
 * One calm 34px header row for a screen that owns its pane header (spec G1,
 * mockup `tidy-agent-header-v3.html` option H). Layout: identity (left,
 * shrinks with ellipsis) -> flexible space -> one status element (right) ->
 * an action cluster (the screen's own actions + the pane's split controls)
 * absolutely positioned at the row's right end, over the status element,
 * on a solid background so it never shifts anything. Never wraps.
 *
 * The cluster is always visible when this pane is the only stage pane or is
 * the focused pane in a split (`usePaneChrome().active`); otherwise it is
 * revealed on pointer hover over the row and on keyboard `:focus-within`
 * (`.pane-header-active`, `:hover`, `:focus-within` in stage.css) — hidden
 * at rest via opacity only, so it stays in the DOM and in the tab order.
 */
export function PaneHeader({
  identity,
  heading,
  status,
  actions,
}: {
  identity: ReactNode;
  /** Visually hidden `<h1>` text (I3): gives the pane an accessible,
   * level-1 page heading the way every other screen's `.pane-title` does,
   * independent of what `identity` renders visually. */
  heading?: string;
  status?: ReactNode;
  actions: ReactNode;
}) {
  const { controls, active } = usePaneChrome();
  return (
    <header className={"pane-header" + (active ? " pane-header-active" : "")}>
      {heading != null && <h1 className="sr-only">{heading}</h1>}
      <div className="pane-header-identity">{identity}</div>
      {status != null && <div className="pane-header-status">{status}</div>}
      <div className="pane-header-cluster">
        {actions}
        {controls}
      </div>
    </header>
  );
}
