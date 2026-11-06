import type { ReactNode } from "react";

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange(v: T): void;
  label: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return <button role="switch" aria-checked={checked} aria-label={label} className={"switch" + (checked ? " on" : "")} onClick={() => onChange(!checked)} />;
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;
