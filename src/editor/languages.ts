import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";

export function getFileExtension(path: string): string {
  const parts = path.split("/").pop()?.split(".") ?? [];
  if (parts.length <= 1) return "";
  return parts.pop()?.toLowerCase() ?? "";
}

export function getLanguageExtension(path: string): Extension | null {
  const ext = getFileExtension(path);
  switch (ext) {
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "json":
      return json();
    case "md":
      return markdown();
    case "css":
      return css();
    case "html":
      return html();
    case "rs":
      return rust();
    case "go":
      return go();
    case "py":
      return python();
    case "yaml":
    case "yml":
      return yaml();
    case "toml":
      return StreamLanguage.define(toml);
    default:
      return null;
  }
}

export function getLanguageName(path: string): string {
  const ext = getFileExtension(path);
  switch (ext) {
    case "ts":
      return "TypeScript";
    case "tsx":
      return "TypeScript JSX";
    case "js":
      return "JavaScript";
    case "jsx":
      return "JavaScript JSX";
    case "json":
      return "JSON";
    case "md":
      return "Markdown";
    case "css":
      return "CSS";
    case "html":
      return "HTML";
    case "rs":
      return "Rust";
    case "go":
      return "Go";
    case "py":
      return "Python";
    case "yaml":
    case "yml":
      return "YAML";
    case "toml":
      return "TOML";
    default:
      return "Plain";
  }
}
