/** Keep native file drops small and safe to insert into an interactive prompt. */
export function formatDroppedPaths(paths: readonly string[]): string | null {
  if (paths.length > 8) return null;
  const accepted = paths;
  if (accepted.length === 0 || accepted.some((path) =>
    path.length === 0 || path.length > 2048 || /[\u0000-\u001f\u007f]/.test(path)
  )) return null;

  // POSIX single quoting prevents shell expansion if the recipient is a shell.
  // This is prompt text only; no newline is sent and nothing is auto-executed.
  return accepted.map((path) => `'${path.replaceAll("'", `'\\''`)}'`).join(" ");
}

export function dropPositionIsInside(
  x: number,
  y: number,
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
  scale = window.devicePixelRatio || 1,
): boolean {
  const logicalX = x / scale;
  const logicalY = y / scale;
  return logicalX >= rect.left && logicalX <= rect.right && logicalY >= rect.top && logicalY <= rect.bottom;
}
