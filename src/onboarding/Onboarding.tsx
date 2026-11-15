import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/t";
import { errorMessage } from "../ipc/errors";
import { pickFolder, type Group, type Project } from "../ipc/catalog";
import { loadSetting, saveSetting } from "../ipc/settings";
import { useGithubAccounts } from "../github/store";
import { useRepos } from "../state/repos";
import { windowLabel } from "../ipc/settings";
import { DeviceFlowBox, PatBox } from "../screens/settings/GithubAccounts";
import "./onboarding.css";

const COMPLETED_KEY = "firstLaunchOnboardingCompleted";
const GROUP_COLOR = "oklch(.68 .19 250)";
const DEFAULT_CLONE_TEMPLATE = "~/clients/{repo}";

function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return (trimmed.split(/[/:]/).pop() ?? trimmed).replace(/\.git$/i, "");
}

export function Onboarding() {
  const status = useRepos((state) => state.status);
  const projects = useRepos((state) => state.projects);
  const groups = useRepos((state) => state.groups);
  const activeGroupId = useRepos((state) => state.activeGroupId);
  const accounts = useGithubAccounts((state) => state.accounts);
  const accountStoreLoaded = useGithubAccounts((state) => state.loaded);
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(activeGroupId);
  const [newGroupName, setNewGroupName] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneDestination, setCloneDestination] = useState("");
  const [cloneDestinationTouched, setCloneDestinationTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Project[]>([]);
  const addedIds = useRef(new Set<string>());
  const checkedFirstLaunch = useRef(false);

  useEffect(() => {
    if (!accountStoreLoaded) void useGithubAccounts.getState().load();
  }, [accountStoreLoaded]);

  useEffect(() => {
    if (status !== "ready" || checkedFirstLaunch.current || windowLabel() !== "main") return;
    checkedFirstLaunch.current = true;
    let live = true;
    void loadSetting<boolean>(COMPLETED_KEY).then(async (completed) => {
      if (!live) return;
      // Existing installations already past first launch should not be interrupted.
      if (completed === true || projects.length > 0) {
        if (completed !== true) await saveSetting(COMPLETED_KEY, true).catch(() => undefined);
        if (live) setVisible(false);
        return;
      }
      setSelectedGroupId(activeGroupId);
      setVisible(true);
    });
    return () => { live = false; };
  }, [status, projects.length, activeGroupId]);

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? null,
    [groups, selectedGroupId],
  );

  const finish = async () => {
    try {
      await saveSetting(COMPLETED_KEY, true);
      setVisible(false);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const createGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    const group: Group = {
      id: crypto.randomUUID(),
      name,
      color: GROUP_COLOR,
      clonePathTemplate: DEFAULT_CLONE_TEMPLATE,
    };
    setError(null);
    try {
      await useRepos.getState().saveGroup(group);
      setSelectedGroupId(group.id);
      setNewGroupName("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const addProject = async (project: Project) => {
    await useRepos.getState().moveProject(project.id, selectedGroupId);
    if (addedIds.current.has(project.id)) return;
    addedIds.current.add(project.id);
    setAdded((current) => [...current, project]);
  };

  const openLocalRepository = async () => {
    setError(null);
    setBusy(true);
    try {
      const path = await pickFolder(t("groups.openTitle"));
      if (!path) return;
      const project = await useRepos.getState().openRepo(path);
      if (project) await addProject(project);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const cloneRemoteRepository = async () => {
    const url = cloneUrl.trim();
    const destination = cloneDestination.trim();
    if (!url || !destination) return;
    setError(null);
    setBusy(true);
    try {
      const project = await useRepos.getState().cloneRepo(url, destination);
      if (!project) return;
      await addProject(project);
      setCloneUrl("");
      setCloneDestination("");
      setCloneDestinationTouched(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;

  return (
    <div className="onboarding-backdrop">
      <section className="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className="onboarding-progress" aria-label={t("onboarding.progress", { current: step + 1, total: 3 })}>
          {[0, 1, 2].map((index) => <span key={index} className={index <= step ? "active" : ""} />)}
        </div>
        {step === 0 && (
          <>
            <div className="onboarding-mark" aria-hidden>⌘</div>
            <h2 id="onboarding-title">{t("onboarding.welcomeTitle")}</h2>
            <p className="onboarding-lead">{t("onboarding.welcomeBody")}</p>
            <div className="onboarding-benefits">
              <article><span aria-hidden>⌂</span><b>{t("onboarding.worktreesTitle")}</b><p>{t("onboarding.worktreesBody")}</p></article>
              <article><span aria-hidden>✦</span><b>{t("onboarding.agentsTitle")}</b><p>{t("onboarding.agentsBody")}</p></article>
              <article><span aria-hidden>⇄</span><b>{t("onboarding.githubTitle")}</b><p>{t("onboarding.githubBody")}</p></article>
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <div className="onboarding-mark github" aria-hidden>⇄</div>
            <h2 id="onboarding-title">{t("onboarding.connectTitle")}</h2>
            <p className="onboarding-lead">{t("onboarding.connectBody")}</p>
            {accounts.length > 0 && <p className="onboarding-connected">{t("onboarding.accountsAvailable", { accounts: accounts.join(", ") })}</p>}
            <div className="onboarding-auth">
              <DeviceFlowBox />
              <PatBox />
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <div className="onboarding-mark" aria-hidden>⌂</div>
            <h2 id="onboarding-title">{t("onboarding.repositoriesTitle")}</h2>
            <p className="onboarding-lead">{t("onboarding.repositoriesBody")}</p>
            <label className="onboarding-field">
              <span>{t("onboarding.groupLabel")}</span>
              <select className="input" value={selectedGroupId ?? ""} onChange={(event) => {
                const groupId = event.target.value || null;
                setSelectedGroupId(groupId);
                if (!cloneDestinationTouched && cloneUrl.trim()) {
                  const template = groups.find((group) => group.id === groupId)?.clonePathTemplate ?? DEFAULT_CLONE_TEMPLATE;
                  setCloneDestination(template.replace("{repo}", () => repoNameFromUrl(cloneUrl)));
                }
              }}>
                <option value="">{t("groups.ungrouped")}</option>
                {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </label>
            <div className="onboarding-create-group">
              <input className="input" value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder={t("onboarding.newGroupPlaceholder")} aria-label={t("onboarding.newGroupLabel")} />
              <button className="btn" type="button" disabled={!newGroupName.trim()} onClick={() => void createGroup()}>{t("onboarding.createGroup")}</button>
            </div>
            <div className="onboarding-repo-actions">
              <button className="btn" type="button" disabled={busy} onClick={() => void openLocalRepository()}>{t("onboarding.openLocal")}</button>
            </div>
            <div className="onboarding-clone">
              <input className="input" value={cloneUrl} onChange={(event) => {
                const url = event.target.value;
                setCloneUrl(url);
                if (!cloneDestinationTouched) {
                  const template = selectedGroup?.clonePathTemplate ?? DEFAULT_CLONE_TEMPLATE;
                  setCloneDestination(url.trim() ? template.replace("{repo}", () => repoNameFromUrl(url)) : "");
                }
              }} placeholder={t("groups.cloneUrlPlaceholder")} aria-label={t("groups.cloneUrlTitle")} />
              <input className="input" value={cloneDestination} onChange={(event) => { setCloneDestination(event.target.value); setCloneDestinationTouched(true); }} placeholder={t("groups.cloneDestTitle")} aria-label={t("groups.cloneDestTitle")} />
              <button className="btn" type="button" disabled={busy || !cloneUrl.trim() || !cloneDestination.trim()} onClick={() => void cloneRemoteRepository()}>{t("onboarding.cloneRepository")}</button>
            </div>
            {busy && <p className="onboarding-status" role="status">{t("onboarding.repositoryWorking")}</p>}
            {added.length > 0 && <ul className="onboarding-added">{added.map((project) => <li key={project.id}>{project.owner ? `${project.owner}/` : ""}{project.name}</li>)}</ul>}
          </>
        )}
        {error && <p className="onboarding-error" role="alert">{error}</p>}
        <div className="onboarding-footer">
              <button className="btn ghost" type="button" disabled={busy} onClick={() => void finish()}>{t("onboarding.skip")}</button>
          <div className="onboarding-footer-right">
            {step > 0 && <button className="btn" type="button" onClick={() => { setError(null); setStep((current) => current - 1); }}>{t("onboarding.back")}</button>}
            {step < 2 ? <button className="btn primary" type="button" onClick={() => { setError(null); setStep((current) => current + 1); }}>{t("onboarding.continue")}</button> : <button className="btn primary" type="button" disabled={busy} onClick={() => void finish()}>{t("onboarding.finish")}</button>}
          </div>
        </div>
      </section>
    </div>
  );
}
