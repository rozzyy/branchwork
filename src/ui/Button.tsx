import type { ButtonHTMLAttributes } from "react";

type Variant = "default" | "primary" | "danger" | "ghost";

export function Button({
  variant = "default",
  size,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" }) {
  const cls = ["btn", variant !== "default" && variant, size, className].filter(Boolean).join(" ");
  return <button className={cls} {...rest} />;
}
