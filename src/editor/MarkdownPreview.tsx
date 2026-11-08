import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { t } from "../i18n/t";
import "./markdown.css";

interface MarkdownPreviewProps {
  /** null = buffer not yet loaded from disk (show spinner); string = ready */
  content: string | null;
  onScroll?: (scrollTop: number) => void;
}

// Configure marked once – GFM
marked.setOptions({ gfm: true, breaks: false });

// Reverse-tabnabbing hardening: any link in preview output gets rel="noopener noreferrer".
// Navigation itself is blocked separately in handleClick below — the preview is read-only
// local content and must not steer the Tauri webview to an external page.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// S3-M1: <area> inside an image map navigates on click just like <a> does.
function blockLinkNavigation(event: React.MouseEvent<HTMLDivElement>) {
  if ((event.target as HTMLElement).closest("a, area")) event.preventDefault();
}

// S3-M1: an untrusted README can otherwise ship a <form> that navigates the whole webview on
// submit, a <style> block that restyles/hides app chrome, or inline style="position:fixed" that
// overlays controls. None of these are needed to render Markdown.
const FORBID_TAGS = ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed"];
const FORBID_ATTR = ["style", "action", "formaction"];

/**
 * Renders markdown to sanitized HTML.
 *
 * State machine:
 *   content=null  → spinner (disk read in progress)
 *   content=str, html=null  → spinner (marked/DOMPurify in progress)
 *   content=str, html=str   → render
 */
export function MarkdownPreview({ content, onScroll }: MarkdownPreviewProps) {
  // html=null means "not yet parsed for current content"
  const [html, setHtml] = useState<string | null>(null);
  // Track which content string produced the current html to avoid stale renders
  const parsedForRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (content === null) {
      // Reset so next content triggers a fresh parse
      setHtml(null);
      parsedForRef.current = null;
      return;
    }

    // Already parsed this exact string (e.g. component remounted, same content)
    if (parsedForRef.current === content) return;

    let cancelled = false;
    // Clear stale html immediately so spinner shows during re-parse
    setHtml(null);

    void (async () => {
      const raw = await marked.parse(content);
      if (cancelled) return;
      const clean = DOMPurify.sanitize(raw, {
        USE_PROFILES: { html: true },
        FORCE_BODY: false,
        FORBID_TAGS,
        FORBID_ATTR,
      });
      parsedForRef.current = content;
      setHtml(clean);
    })();

    return () => { cancelled = true; };
  }, [content]);

  const handleScroll = useMemo(
    () =>
      onScroll
        ? (e: React.UIEvent<HTMLDivElement>) => onScroll((e.target as HTMLDivElement).scrollTop)
        : undefined,
    [onScroll],
  );

  if (content === null || html === null) {
    return (
      <div className="md-loading">
        <span className="md-spinner" />
        <span className="md-loading-text">{t("files.mdLoading")}</span>
      </div>
    );
  }

  return (
    <div
      className="md-preview"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={blockLinkNavigation}
      onScroll={handleScroll}
      onSubmit={(e) => e.preventDefault()}
    />
  );
}
