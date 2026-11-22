import type { SVGProps } from "react";

export type IconName =
  | "branch"
  | "chevronDown"
  | "chevronRight"
  | "folder"
  | "grid"
  | "more"
  | "move"
  | "plus"
  | "settings"
  | "terminal"
  | "close";

export function Icon({ name, size = 16, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    ...props,
  } as SVGProps<SVGSVGElement>;

  return (
    <svg {...common}>
      {name === "chevronDown" && <path d="m6 9 6 6 6-6" />}
      {name === "chevronRight" && <path d="m9 6 6 6-6 6" />}
      {name === "folder" && (
        <>
          <path d="M3.5 6.5h6l2 2H20.5v9.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2Z" />
          <path d="M3.5 8.5V5.5a2 2 0 0 1 2-2h3l2 2" />
        </>
      )}
      {name === "grid" && (
        <>
          <rect x="4" y="4" width="6" height="6" rx="1" />
          <rect x="14" y="4" width="6" height="6" rx="1" />
          <rect x="4" y="14" width="6" height="6" rx="1" />
          <rect x="14" y="14" width="6" height="6" rx="1" />
        </>
      )}
      {name === "branch" && (
        <>
          <circle cx="6" cy="5" r="2" />
          <circle cx="18" cy="7" r="2" />
          <circle cx="6" cy="19" r="2" />
          <path d="M6 7v10M8 5h4a6 6 0 0 1 6 6v-2M8 14h4a4 4 0 0 0 4-4" />
        </>
      )}
      {name === "move" && (
        <>
          <path d="M7 7h10l-3-3M17 7l-3 3M17 17H7l3 3M7 17l3-3" />
        </>
      )}
      {name === "more" && (
        <>
          <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
        </>
      )}
      {name === "plus" && <path d="M12 5v14M5 12h14" />}
      {name === "settings" && (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.42 1.42-.06-.06A1.7 1.7 0 0 0 16.44 18a1.7 1.7 0 0 0-1.02 1.55V19.7h-2v-.15A1.7 1.7 0 0 0 12.4 18a1.7 1.7 0 0 0-1.88.34l-.06.06-1.42-1.42.06-.06A1.7 1.7 0 0 0 9.44 15a1.7 1.7 0 0 0-1.55-1.02H7.7v-2h.19A1.7 1.7 0 0 0 9.44 10a1.7 1.7 0 0 0-.34-1.88l-.06-.06 1.42-1.42.06.06A1.7 1.7 0 0 0 12.4 6a1.7 1.7 0 0 0 1.02-1.55V4.3h2v.15A1.7 1.7 0 0 0 16.44 6a1.7 1.7 0 0 0 1.88-.34l.06-.06 1.42 1.42-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1.02h.15v2h-.15A1.7 1.7 0 0 0 19.4 15Z" />
        </>
      )}
      {name === "terminal" && (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m7 9 3 3-3 3M12.5 15H17" />
        </>
      )}
      {name === "close" && <path d="m6 6 12 12M18 6 6 18" />}
    </svg>
  );
}
