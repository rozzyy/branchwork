import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

export const bwEditorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "transparent !important",
      color: "var(--fg)",
      fontFamily: 'var(--font-mono, "SF Mono", "JetBrains Mono", monospace)',
      fontSize: "12.5px",
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: 'var(--font-mono, "SF Mono", "JetBrains Mono", monospace)',
      lineHeight: "1.75",
    },
    ".cm-content": {
      fontFamily: 'var(--font-mono, "SF Mono", "JetBrains Mono", monospace)',
      lineHeight: "1.75",
      padding: "8px 0 120px 0",
      caretColor: "var(--acc)",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      borderRight: "1px solid var(--line)",
      color: "var(--fg3)",
      userSelect: "none",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      color: "var(--fg3)",
      opacity: "0.6",
      padding: "0 12px 0 4px",
      minWidth: "28px",
      textAlign: "right",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeft: "2px solid var(--acc)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--accs) !important",
    },
    "&.cm-focused .cm-matchingBracket, .cm-matchingBracket": {
      color: "var(--fg) !important",
      backgroundColor: "var(--accs)",
    },
    ".cm-activeLine": {
      backgroundColor: "transparent",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--fg)",
      opacity: "1",
    },
    ".cm-gutter-git": {
      width: "8px",
    },
  },
  { dark: true },
);

export const bwHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--pur)" },
  { tag: [t.function(t.definition(t.variableName)), t.definition(t.name), t.function(t.variableName)], color: "var(--blu)" },
  { tag: [t.variableName, t.self], color: "var(--fg)" },
  { tag: [t.typeName, t.className, t.standard(t.typeName), t.namespace], color: "var(--yel)" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "oklch(0.78 0.1 210)" },
  { tag: [t.string, t.special(t.string)], color: "var(--grn)" },
  { tag: [t.number, t.atom, t.bool], color: "var(--org)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--fg3)", fontStyle: "italic" },
  { tag: [t.operator, t.punctuation], color: "var(--fg2)" },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: "var(--fg)", fontWeight: "700" },
  { tag: [t.tagName, t.angleBracket], color: "var(--pnk)" },
  { tag: [t.attributeName], color: "var(--yel)" },
  { tag: [t.link, t.url], color: "var(--acc)" },
]);

export const bwThemeExtension: Extension = [
  bwEditorTheme,
  syntaxHighlighting(bwHighlightStyle),
];
