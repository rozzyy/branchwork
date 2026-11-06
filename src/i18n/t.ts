import { en, type MsgKey } from "./en";

export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  let s: string = en[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
