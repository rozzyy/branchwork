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
import { t } from "../i18n/t";

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
      return t("editor.language.typescript");
    case "tsx":
      return t("editor.language.typescriptJsx");
    case "js":
      return t("editor.language.javascript");
    case "jsx":
      return t("editor.language.javascriptJsx");
    case "json":
      return t("editor.language.json");
    case "md":
      return t("editor.language.markdown");
    case "css":
      return t("editor.language.css");
    case "html":
      return t("editor.language.html");
    case "rs":
      return t("editor.language.rust");
    case "go":
      return t("editor.language.go");
    case "py":
      return t("editor.language.python");
    case "yaml":
    case "yml":
      return t("editor.language.yaml");
    case "toml":
      return t("editor.language.toml");
    default:
      return t("editor.language.plain");
  }
}
