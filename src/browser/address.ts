// Address bar input → URL (M11). Mirrors the Rust check: only http(s) loads.

const SEARCH = "https://www.google.com/search?q=";

/**
 * `http(s)://…` as is; `localhost[:port]` / `127.0.0.1[:port]` → http;
 * something that looks like a host (a dot, no spaces) → https; anything
 * else → a Google search. Returns null for empty input.
 */
export function toAddress(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return validUrl(text);
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(text) && !/^[^\s/]+\.[^\s/]+:\d+/.test(text)) {
    // Another scheme (javascript:, file:, data:, …) is never loaded.
    return searchUrl(text);
  }
  if (/^(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(text)) return validUrl(`http://${text}`);
  if (!/\s/.test(text) && /^[^/?#]+\.[^/?#]+/.test(text)) return validUrl(`https://${text}`) ?? searchUrl(text);
  return searchUrl(text);
}

function validUrl(text: string): string | null {
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

const searchUrl = (text: string) => SEARCH + encodeURIComponent(text);
