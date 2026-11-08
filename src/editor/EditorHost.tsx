import React, { Suspense } from "react";
import { t } from "../i18n/t";
import "./editor.css";

const CodeMirrorEditor = React.lazy(() =>
  import("./CodeMirrorEditor").then((m) => ({ default: m.CodeMirrorEditor })),
);

export function EditorHost() {
  return (
    <Suspense fallback={<div className="editor-host-placeholder">{t("files.editorLoading")}</div>}>
      <CodeMirrorEditor />
    </Suspense>
  );
}
