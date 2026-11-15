import { useHistory } from "../../state/history";
import { t } from "../../i18n/t";
import { GraphToolbar, GraphView } from "../graph/GraphScreen";
import { BlameToolbar, BlameView } from "../blame/BlameScreen";
import { RebaseToolbar, RebaseView } from "../rebase/RebaseScreen";

const modes = [
  ["graph", "history.mode.graph", "history.mode.graphCompact"],
  ["file", "history.mode.file", "history.mode.fileCompact"],
  ["rewrite", "history.mode.rewrite", "history.mode.rewriteCompact"],
] as const;

export function HistoryToolbar() {
  const mode = useHistory((s) => s.mode);
  const setMode = useHistory((s) => s.setMode);
  const Toolbar = mode === "graph" ? GraphToolbar : mode === "file" ? BlameToolbar : RebaseToolbar;
  return <><div className="history-tabs" role="tablist" aria-label={t("nav.history")}>
    {modes.map(([value, label, compactLabel]) => <button key={value} role="tab" aria-label={t(label)} aria-selected={mode === value} className="history-tab" onClick={() => setMode(value)}><span className="history-tab-full">{t(label)}</span><span className="history-tab-compact">{t(compactLabel)}</span></button>)}
  </div><Toolbar /></>;
}

export function HistoryView() {
  const mode = useHistory((s) => s.mode);
  const View = mode === "graph" ? GraphView : mode === "file" ? BlameView : RebaseView;
  return <View />;
}
