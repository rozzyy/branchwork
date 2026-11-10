import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Button } from "./Button";

type Variant = "default" | "primary" | "danger" | "ghost";

interface BusyButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  variant?: Variant;
  size?: "sm";
  /** Async work to run on click; the button shows a loader until it settles. */
  onExecute: () => Promise<unknown>;
  children: ReactNode;
}

/** Button with a built-in loader: disabled + spinner while `onExecute` runs. */
export function BusyButton({ onExecute, children, disabled, ...rest }: BusyButtonProps) {
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const click = () => {
    if (busy) return;
    setBusy(true);
    void Promise.resolve()
      .then(onExecute)
      .catch(() => {})
      .finally(() => {
        if (live.current) setBusy(false);
      });
  };
  return (
    <Button disabled={disabled || busy} aria-busy={busy} onClick={click} {...rest}>
      {busy && <span className="spin" aria-hidden="true" />}
      {children}
    </Button>
  );
}
