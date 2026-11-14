import { useState } from "react";
import { t } from "../i18n/t";
import { useWorktrees } from "../state/worktrees";
import { useConflicts } from "../screens/conflicts/conflictsState";
import { conflictAbort } from "../ipc/conflicts";
import { rebaseAbort, rebaseContinue } from "../ipc/rebase";
import { announce } from "../screens/rebase/RebaseScreen";
import { ask } from "../ui/dialog";
import { toast } from "../ui/toast";
import { errorMessage } from "../ipc/errors";
import { useStage } from "../state/stage";
import { Banner } from "../ui/Banner";

export function OperationBanner() {
  const active = useWorktrees((s) => s.activePath);
  const { worktree, list } = useConflicts();
  const [busy, setBusy] = useState(false);
  if (!active || worktree !== active || !list || list.operation === "none") return null;
  const count = list.files.length;
  const operation = list.operation === "cherryPick" ? t("operation.cherryPick") : list.operation === "rebase" ? t("operation.rebase") : list.operation === "merge" ? t("operation.merge") : t("operation.revert");
  const abort = async () => {
    const confirmed = await ask({ title:t("operation.abortTitle", {operation}), body:t("operation.abortBody"), ok:t("operation.abort"), danger:true });
    if (confirmed !== true) return;
    setBusy(true);
    try { if (list.operation === "rebase") await rebaseAbort(active); else await conflictAbort(active); await useConflicts.getState().load(active); }
    catch (error) { toast({title:errorMessage(error),icon:"⚠"}); }
    finally { setBusy(false); }
  };
  const continueRebase = async () => {
    setBusy(true);
    try { const result=await rebaseContinue(active); announce(active,result); await useConflicts.getState().load(active); }
    catch(error){toast({title:errorMessage(error),icon:"⚠"});}
    finally{setBusy(false);}
  };
  return <Banner tone={count ? "warn" : "info"} icon="⚠" title={`${operation} ${t("operation.inProgress")}`} detail={count ? t("operation.conflicts", {count}) : t("operation.resolved")} actions={<>
    {count > 0 && <button className="btn sm" onClick={() => useStage.getState().go("conflicts")}>{t("operation.resolve")}</button>}
    {list.operation === "rebase" && <button className="btn sm primary" disabled={busy || count > 0} onClick={() => void continueRebase()}>{t("operation.continue")}</button>}
    <button className="btn sm danger" disabled={busy} onClick={() => void abort()}>{t("operation.abort")}</button>
  </>} />;
}
