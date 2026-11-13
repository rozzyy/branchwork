import { useEffect, useState } from "react";
import { create } from "zustand";
import { useGithubAccounts } from "../../github/store";
import { t } from "../../i18n/t";
import { errorMessage } from "../../ipc/errors";
import { ghPublishOwners, ghRepoPublish, gitHasOrigin, type PublishOwner } from "../../ipc/publish";
import { openGithubRepo } from "../../ipc/repo";
import { beginGitWrite, endGitWrite, reloadWorktreesFor, showGitError } from "../../state/gitActions";
import { useWorktrees } from "../../state/worktrees";
import { toast } from "../../ui/toast";
import { useDock } from "../../terminal/dock";

/** A valid GitHub repository name from a folder name (spaces → `-`, unsupported characters dropped). */
export function sanitizeRepoName(folder: string): string {
  let name = folder.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "");
  name = name.replace(/^\.+/, "").slice(0, 100);
  return name || "project";
}

interface PublishStore {
  /** Worktree the dialog is open for, or null when closed. */
  worktree: string | null;
  /** Bumped after a successful publish so screens re-read the remote. */
  revision: number;
  open(worktree: string): void;
  close(): void;
}

export const usePublish = create<PublishStore>((set) => ({
  worktree: null,
  revision: 0,
  open: (worktree) => set({ worktree }),
  close: () => set({ worktree: null }),
}));

/** `true` when the worktree has no `origin` remote (Publish is offered only then). */
export function useOriginMissing(worktree: string | null): boolean {
  const revision = usePublish((state) => state.revision);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!worktree) { setMissing(false); return; }
    let live = true;
    // Any origin (GitHub or not) hides Publish; errors hide it too.
    gitHasOrigin(worktree)
      .then((has) => { if (live) setMissing(!has); })
      .catch(() => { if (live) setMissing(false); });
    return () => { live = false; };
  }, [worktree, revision]);
  return missing;
}

function PublishForm({ worktree }: { worktree: string }) {
  const accounts = useGithubAccounts((state) => state.accounts);
  const accountsLoaded = useGithubAccounts((state) => state.loaded);
  const defaultAccount = useGithubAccounts((state) => state.defaultAccount);
  const hasCommit = useWorktrees((state) => (state.worktrees.find((item) => item.path === worktree)?.head ?? "") !== "");
  const close = usePublish((state) => state.close);
  const folder = worktree.split("/").filter(Boolean).pop() ?? "";
  const [account, setAccount] = useState(defaultAccount ?? accounts[0] ?? "");
  const [owners, setOwners] = useState<PublishOwner[]>([]);
  const [owner, setOwner] = useState("");
  const [name, setName] = useState(sanitizeRepoName(folder));
  const [isPrivate, setPrivate] = useState(true);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [ownersError, setOwnersError] = useState<string | null>(null);

  useEffect(() => { void useGithubAccounts.getState().load(); }, []);
  useEffect(() => {
    if (!account && (defaultAccount ?? accounts[0])) setAccount(defaultAccount ?? accounts[0]);
  }, [account, accounts, defaultAccount]);
  useEffect(() => {
    if (!account) return;
    let live = true;
    setOwners([]);
    setOwner("");
    setOwnersError(null);
    ghPublishOwners(account)
      .then((found) => { if (live) { setOwners(found); setOwner(found[0]?.login ?? ""); } })
      .catch((error: unknown) => { if (live) setOwnersError(errorMessage(error)); });
    return () => { live = false; };
  }, [account]);

  const publish = async () => {
    if (!beginGitWrite(worktree, "publish")) return;
    setBusy(true);
    try {
      const result = await ghRepoPublish(worktree, { account, owner, name, private: isPrivate, description });
      usePublish.setState((state) => ({ revision: state.revision + 1 }));
      close();
      if (result.pushed) {
        toast({
          title: t("publish.done", { owner, name }),
          icon: "↑",
          action: { label: t("graph.action.openOnGithub"), run: () => void openGithubRepo(owner, name) },
        });
      } else {
        toast({
          title: t("publish.pushFailed", { owner, name }),
          icon: "!",
          details: result.pushError?.detail ?? result.pushError?.message ?? undefined,
          action: result.pushError?.kind === "gitAuth"
            ? { label: t("sync.openTerminalAuth"), run: () => void useDock.getState().openHere(worktree) }
            : undefined,
        });
      }
    } catch (error) {
      showGitError(worktree, t("publish.title"), error);
    } finally {
      endGitWrite(worktree);
      reloadWorktreesFor(worktree);
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, close]);

  const canPublish = hasCommit && !!account && !!owner && !!name.trim() && !busy;
  return (
    <div className="dlg publish-dlg" role="dialog" aria-modal="true" aria-labelledby="publish-title">
      <div className="dlg-ic" aria-hidden>↑</div>
      <h3 id="publish-title">{t("publish.title")}</h3>
      {accountsLoaded && accounts.length === 0 ? (
        <p>{t("publish.noAccount")}</p>
      ) : (
        <div className="publish-fields">
          <label>
            {t("publish.account")}
            <select className="input" value={account} onChange={(event) => setAccount(event.target.value)}>
              {accounts.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label>
            {t("publish.owner")}
            <select className="input" value={owner} onChange={(event) => setOwner(event.target.value)} disabled={owners.length === 0}>
              {owners.map((item) => <option key={item.id} value={item.login}>{item.login}</option>)}
            </select>
          </label>
          {ownersError && <p className="publish-error" role="alert">{ownersError}</p>}
          <label>
            {t("publish.name")}
            <input className="input" value={name} autoFocus onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="publish-visibility" role="radiogroup" aria-label={t("publish.visibility")}>
            <label><input type="radio" checked={isPrivate} onChange={() => setPrivate(true)} />{t("publish.private")}</label>
            <label><input type="radio" checked={!isPrivate} onChange={() => setPrivate(false)} />{t("publish.public")}</label>
          </div>
          <label>
            {t("publish.description")}
            <input className="input" value={description} maxLength={350} onChange={(event) => setDescription(event.target.value)} />
          </label>
          {!hasCommit && <p className="publish-error" role="status">{t("publish.needsCommit")}</p>}
        </div>
      )}
      <div className="dlg-actions">
        <button className="btn" onClick={close}>{t("dialog.cancel")}</button>
        <button className="btn primary" disabled={!canPublish} onClick={() => void publish()}>
          {busy ? t("publish.publishing") : t("publish.submit")}
        </button>
      </div>
    </div>
  );
}

/** Mounted once by App; renders the Publish dialog when a screen opens it. */
export function PublishDialogHost() {
  const worktree = usePublish((state) => state.worktree);
  const close = usePublish((state) => state.close);
  if (!worktree) return null;
  return (
    <div className="dlg-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <PublishForm key={worktree} worktree={worktree} />
    </div>
  );
}
