import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { CliPane } from "../../terminal/CliPane";
import { CLI_IDS, CLI_REGISTRY, resolveCli, type CliId } from "../../agents/registry";
import { useProfiles } from "../../agents/profiles";
import { useSessions, type AgentSession, type AgentStatus, type RaceEntry } from "../../agents/sessions";
import { useStage } from "../../state/stage";
import { useRepos } from "../../state/repos";
import { useWorktrees } from "../../state/worktrees";
import { CliIcon } from "../../agents/cliIcons";
import { Menu, type MenuItem } from "../../ui/Menu";
import { ask } from "../../ui/dialog";
import { toast } from "../../ui/toast";
import { readStatus } from "../../ipc/status";
import { createUnpinnedWorktree, removeWorktree } from "../../ipc/worktrees";
import { readHandoverDiff, writeHandoverNote } from "../../ipc/handover";
import { writeTerminal } from "../../ipc/pty";
import { t } from "../../i18n/t";
import "./agents.css";

function tail(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

type PaneStatus = AgentStatus;

function paneStatus(session: AgentSession, isExited: (id: string | null) => boolean): PaneStatus {
  if (!session.sessionId) return "idle";
  if (isExited(session.sessionId)) return "done";
  return session.status === "idle" ? "running" : session.status;
}

export function AgentsToolbar() {
  const sessions = useSessions((s) => s.sessions);
  const count = sessions.length;
  const layoutMode = useSessions((s) => s.layoutMode);
  const setLayoutMode = useSessions((s) => s.setLayoutMode);
  const setNewAgentOpen = useSessions((s) => s.setNewAgentOpen);
  const setRaceOpen = useSessions((s) => s.setRaceOpen);
  return (
    <>
      <h1 className="pane-title">
        {t("agents.title")}{" "}
        <span className="sub" aria-hidden="true">
          {t("agents.subtitle", { count })}
        </span>
      </h1>
      <div className="pane-ctl">
        <div className="agent-grp" title={t("agents.layoutAll")}>
          <button
            type="button"
            className={layoutMode === "grid" ? "on" : ""}
            aria-pressed={layoutMode === "grid" ? "true" : "false"}
            onClick={() => setLayoutMode("grid")}
          >
            ▦ {t("agents.layoutGrid")}
          </button>
          <button
            type="button"
            className={layoutMode === "full" ? "on" : ""}
            aria-pressed={layoutMode === "full" ? "true" : "false"}
            onClick={() => setLayoutMode("full")}
          >
            ▭ {t("agents.layoutFull")}
          </button>
        </div>
        <button type="button" className="btn" onClick={() => setRaceOpen(true)}>
          ⚑ {t("agents.race")}
        </button>
        <button type="button" className="btn p" onClick={() => setNewAgentOpen(true)}>
          ＋ {t("agents.newAgent")}
        </button>
      </div>
    </>
  );
}

function AgentPaneBody({ session }: { session: AgentSession }) {
  const store = useSessions.getState();
  // Buffer typed input lines so a lone "/account" line switches profiles
  // instead of reaching the agent. Anything else passes through untouched.
  const lineRef = useRef("");
  const interceptInput = useCallback(
    (data: string) => {
      lineRef.current += data;
      const parts = lineRef.current.split(/[\r\n]/);
      if (parts.length > 1) {
        const done = parts.slice(0, -1);
        lineRef.current = parts[parts.length - 1];
        if (done.some((line) => line.trim() === "/account")) {
          void store.switchToNextProfile(session.id, true);
          return true;
        }
      }
      if (lineRef.current.length > 500) lineRef.current = lineRef.current.slice(-500);
      return false;
    },
    [session.id, store],
  );
  if (!session.sessionId) {
    return (
      <div className="agent-pane-error" role="status">
        <span>{session.error ?? "…"}</span>
        <button type="button" className="btn sm" onClick={() => void store.closeSession(session.id)}>
          ×
        </button>
      </div>
    );
  }
  return (
    <>
      {session.limitHit && (
        <div className="agent-limit" role="status">
          <span>{t("agents.limitTitle")}</span>
          <span className="sp" />
          <button
            type="button"
            className="btn sm p"
            onClick={() => void store.switchToNextProfile(session.id, true)}
          >
            {t("agents.limitSwitch")}
          </button>
          <button type="button" className="btn sm" onClick={() => store.dismissLimit(session.id)}>
            {t("agents.limitDismiss")}
          </button>
        </div>
      )}
      <CliPane key={session.sessionId} sessionId={session.sessionId} interceptInput={interceptInput} />
    </>
  );
}

function ProfileChip({ session }: { session: AgentSession }) {
  const def = CLI_REGISTRY[session.cliId];
  // Subscribe to the raw array (stable identity); filtering here keeps the
  // selector snapshot cached and avoids a render loop.
  const allProfiles = useProfiles((s) => s.profiles);
  const profiles = allProfiles.filter((p) => p.cliId === session.cliId);
  const profileName =
    profiles.find((p) => p.slug === session.profile.slug)?.name ?? session.profile.slug;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const open = (e: ReactMouseEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setMenu({ x: box.left, y: box.bottom + 6 });
  };
  const items: MenuItem[] = [
    { kind: "header", label: t("agents.profilesMenu", { name: def.name }) },
    ...profiles.map(
      (p): MenuItem => ({
        kind: "item",
        label: p.name,
        icon: p.slug === session.profile.slug ? "✓" : undefined,
        onSelect: () => {
          setMenu(null);
          void useSessions.getState().switchProfile(session.id, { cliId: p.cliId, slug: p.slug });
        },
      }),
    ),
    { kind: "separator" },
    {
      kind: "item",
      label: t("agents.addAccount"),
      icon: "＋",
      onSelect: () => {
        setMenu(null);
        void useProfiles.getState().addProfile(session.cliId);
      },
    },
    {
      kind: "item",
      label: t("agents.manageAccounts"),
      icon: "⚙",
      onSelect: () => {
        setMenu(null);
        useStage.getState().go("settings");
      },
    },
  ];
  return (
    <>
      <button
        type="button"
        className="chip agent-profile"
        title={t("agents.profileChip", { name: profileName })}
        aria-label={t("agents.profileChip", { name: profileName })}
        aria-haspopup="menu"
        onClick={open}
      >
        ◔ {profileName}
      </button>
      {menu && <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={items} />}
    </>
  );
}

function StatusDot({ status }: { status: PaneStatus }) {
  return (
    <span
      className={"agent-dot" + (status === "running" ? " pulse" : "")}
      style={
        {
          "--c":
            status === "running"
              ? "var(--acc)"
              : status === "done"
                ? "var(--grn)"
                : status === "waiting"
                  ? "var(--yel)"
                  : "var(--fg3)",
        } as CSSProperties
      }
      aria-hidden
    />
  );
}

function StatusChip({ status }: { status: PaneStatus }) {
  if (status === "done") return <span className="chip cg">{t("agents.statusDone")}</span>;
  if (status === "running") return <span className="chip agent-chip-run">{t("agents.statusRunning")}</span>;
  if (status === "waiting") return <span className="chip agent-chip-wait">{t("agents.statusWaiting")}</span>;
  return <span className="chip">{t("agents.statusIdle")}</span>;
}

function AgentPane({ session, off }: { session: AgentSession; off?: boolean }) {
  const store = useSessions.getState();
  const isExited = useSessions((s) => s.isExited);
  const handoverFor = useSessions((s) => s.handoverFor);
  const status = paneStatus(session, isExited);
  const def = CLI_REGISTRY[session.cliId];
  const switchAgent = (next: string) => {
    if (next === session.cliId) return;
    store.setHandoverTarget(next as CliId);
    store.setHandoverFor(session.id);
  };
  return (
    <div
      className={`agent-pane st-${status}` + (off ? " agent-off" : "")}
      data-slot={session.slot}
      aria-label={t("agents.paneLabel", { cli: def.name, name: tail(session.worktreePath) })}
    >
      <div className="agent-phd">
        <StatusDot status={status} />
        <span className="mono agent-wt" title={session.worktreePath}>
          {tail(session.worktreePath)}
        </span>
        {session.cliId === "custom" ? (
          <span className="agent-cli" title={def.name}>
            <CliIcon id={session.cliId} /> {def.name}
          </span>
        ) : (
          <select
            className="agent-cli-switch"
            aria-label={t("agents.switchAgent")}
            title={t("agents.switchAgent")}
            value={session.cliId}
            disabled={handoverFor === session.id}
            onChange={(e) => switchAgent(e.target.value)}
          >
            {RACEABLE_IDS.map((id) => (
              <option key={id} value={id}>
                {CLI_REGISTRY[id].name}
              </option>
            ))}
          </select>
        )}
        <ProfileChip session={session} />
        <StatusChip status={status} />
        <span className="sp" />
        <span className="agent-lay">
          {(["left", "right", "full"] as const).map((side) => (
            <button
              key={side}
              type="button"
              className={session.slot === side ? "on" : ""}
              aria-label={t(side === "left" ? "agents.slotLeft" : side === "right" ? "agents.slotRight" : "agents.slotFull")}
              aria-pressed={session.slot === side ? "true" : "false"}
              title={t(side === "left" ? "agents.slotLeft" : side === "right" ? "agents.slotRight" : "agents.slotFull")}
              onClick={() => store.toggleSlot(session.id, side)}
            >
              {side === "left" ? "◧" : side === "right" ? "◨" : "▭"}
            </button>
          ))}
        </span>
        <button
          type="button"
          className="agent-phb"
          title={t("agents.moveToDock")}
          aria-label={t("agents.moveToDock")}
          onClick={() => store.moveToDock(session.id)}
        >
          ⤴
        </button>
        <button
          type="button"
          className="agent-phb"
          title={t("agents.handover")}
          aria-label={t("agents.handover")}
          onClick={() => store.setHandoverFor(session.id)}
        >
          ↗
        </button>
        <button
          type="button"
          className="agent-phb x"
          title={t("agents.closeSession")}
          aria-label={t("agents.closeSession")}
          onClick={() => void store.closeSession(session.id)}
        >
          ✕
        </button>
      </div>
      <div className="agent-pane-body">
        <AgentPaneBody session={session} />
      </div>
    </div>
  );
}

const NEW_PROFILE = "__new";

function previewCommand(cliId: CliId, slug: string): string {
  const def = CLI_REGISTRY[cliId];
  let launch: string[];
  try {
    launch = resolveCli(def).launch;
  } catch {
    launch = [];
  }
  const dir = `~/.branchwork/profiles/${cliId}-${slugify(slug) || "…"}`;
  const env = Object.entries(def.profileEnv(dir)).map(([k, v]) => `${k}=${v}`);
  return [...env, ...launch.map((a) => (a.includes(" ") ? `'${a}'` : a))].join(" ") || def.name;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function NewAgentDialog() {
  const open = useSessions((s) => s.newAgentOpen);
  const setOpen = useSessions((s) => s.setNewAgentOpen);
  const profiles = useProfiles((s) => s.profiles);
  const worktrees = useWorktrees((s) => s.worktrees);
  const activePath = useWorktrees((s) => s.activePath);
  const [cliId, setCliId] = useState<CliId>("claude");
  const [profileSlug, setProfileSlug] = useState<string>(NEW_PROFILE);
  const [profileName, setProfileName] = useState("");
  const [worktreePath, setWorktreePath] = useState<string>("");
  const [binaries, setBinaries] = useState<Record<CliId, string | null> | null>(null);

  useEffect(() => {
    if (!open) return;
    setBinaries(null);
    setProfileSlug(NEW_PROFILE);
    setProfileName("");
    setWorktreePath(activePath ?? "");
    void useSessions.getState().checkBinaries().then(setBinaries);
  }, [open, activePath]);

  if (!open) return null;
  const def = CLI_REGISTRY[cliId];
  const cliProfiles = profiles.filter((p) => p.cliId === cliId);
  const resolved = binaries?.[cliId];
  const binaryMissing = !!binaries && !!def.binary && !resolved;
  const customNeedsSettings = cliId === "custom";
  const slug = profileSlug === NEW_PROFILE ? slugify(profileName) : profileSlug;
  const canStart =
    !!binaries && !binaryMissing && !customNeedsSettings && !!worktreePath && !!slug;
  const start = () => {
    if (!canStart) return;
    void (async () => {
      let ref = profileSlug === NEW_PROFILE ? "" : profileSlug;
      if (profileSlug === NEW_PROFILE) {
        const created = await useProfiles.getState().createProfile(cliId, profileName);
        if (!created) return;
        ref = created.slug;
      }
      const started = await useSessions.getState().startSession({
        cliId,
        profile: { cliId, slug: ref },
        worktreePath,
      });
      if (started) setOpen(false);
    })();
  };

  return (
    <div className="dlg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="dlg dlg-wide" role="dialog" aria-modal="true" aria-labelledby="agent-dialog-title">
        <div className="dlg-ic">✦</div>
        <h3 id="agent-dialog-title">{t("agents.dialogTitle")}</h3>
        <p>{t("agents.dialogBody")}</p>
        <div className="agent-h4">{t("agents.dialogCli")}</div>
        <div className="agent-apick" role="radiogroup" aria-label={t("agents.dialogCli")}>
          {CLI_IDS.map((id) => {
            const entry = CLI_REGISTRY[id];
            const missing = !!binaries && !!entry.binary && !binaries[id];
            return (
              <label key={id} className={missing ? "missing" : ""} title={missing ? t("agents.installMissing", { name: entry.name, guidance: t(entry.installGuidance) }) : entry.name}>
                <input
                  type="radio"
                  name="agent-cli"
                  value={id}
                  checked={cliId === id}
                  disabled={missing}
                  onChange={() => { setCliId(id); setProfileSlug(NEW_PROFILE); }}
                />
                <span className="agent-apick-icon" aria-hidden>
                  <CliIcon id={id} size={16} />
                </span>
                <span className="agent-apick-name">{entry.name}</span>
                <small>{id}</small>
              </label>
            );
          })}
        </div>
        {!binaries && <p className="agent-hint">{t("agents.dialogChecking")}</p>}
        {binaryMissing && (
          <p className="agent-hint">{t("agents.installMissing", { name: def.name, guidance: t(def.installGuidance) })}</p>
        )}
        {customNeedsSettings && <p className="agent-hint">{t("agents.customNeedsSettings")}</p>}
        <div className="agent-h4">{t("agents.dialogProfile")}</div>
        <select
          className="input"
          aria-label={t("agents.dialogProfile")}
          value={profileSlug}
          onChange={(e) => setProfileSlug(e.target.value)}
        >
          {cliProfiles.map((p) => (
            <option key={p.slug} value={p.slug}>{p.name}</option>
          ))}
          <option value={NEW_PROFILE}>{t("agents.dialogNewProfile")}</option>
        </select>
        {profileSlug === NEW_PROFILE && (
          <input
            className="input"
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            placeholder={t("agents.dialogProfileName")}
            aria-label={t("agents.dialogProfileName")}
            onKeyDown={(e) => { if (e.key === "Enter") start(); }}
          />
        )}
        <div className="agent-h4">{t("agents.dialogWorktree")}</div>
        <select
          className="input"
          aria-label={t("agents.dialogWorktree")}
          value={worktreePath}
          onChange={(e) => setWorktreePath(e.target.value)}
        >
          {!worktrees.some((w) => w.path === worktreePath) && worktreePath && (
            <option value={worktreePath}>{tail(worktreePath)}</option>
          )}
          {worktrees.map((w) => (
            <option key={w.path} value={w.path}>{tail(w.path)}</option>
          ))}
        </select>
        <div className="dlg-meta">{previewCommand(cliId, slug)}</div>
        <div className="dlg-actions">
          <button type="button" className="btn" onClick={() => setOpen(false)}>{t("agents.dialogCancel")}</button>
          <button type="button" className="btn p" disabled={!canStart} onClick={start}>{t("agents.dialogStart")}</button>
        </div>
      </div>
    </div>
  );
}

/** Parent dir of a worktree path without producing a double slash at the root. */
function worktreeParentDir(path: string): string {
  const parent = path.split("/").slice(0, -1).join("/");
  return parent === "" ? "/" : parent;
}

function defaultHandoverBranch(worktreeBranch: string | null, cliId: CliId): string {
  const base =
    (worktreeBranch ?? "work")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "work";
  return `handover/${base}-${cliId}`;
}

function HandoverDialog() {
  const sourceId = useSessions((s) => s.handoverFor);
  const setSourceId = useSessions((s) => s.setHandoverFor);
  const clearPreset = useSessions((s) => s.setHandoverTarget);
  const close = () => {
    setSourceId(null);
    clearPreset(null);
  };
  const sessions = useSessions((s) => s.sessions);
  const profiles = useProfiles((s) => s.profiles);
  const worktrees = useWorktrees((s) => s.worktrees);
  const source = sessions.find((s) => s.id === sourceId) ?? null;

  const [targetCli, setTargetCli] = useState<CliId>("codex");
  const [profileSlug, setProfileSlug] = useState<string>(NEW_PROFILE);
  const [profileName, setProfileName] = useState("");
  const [where, setWhere] = useState<"same" | "new">("same");
  const [branch, setBranch] = useState("");
  const [branchEdited, setBranchEdited] = useState(false);
  const [note, setNote] = useState("");
  const [includeTail, setIncludeTail] = useState(true);
  const [includeDiff, setIncludeDiff] = useState(false);
  const [stopSource, setStopSource] = useState(false);
  const [binaries, setBinaries] = useState<Record<CliId, string | null> | null>(null);

  const srcBranch = worktrees.find((w) => w.path === source?.worktreePath)?.branch ?? null;

  useEffect(() => {
    if (!source) return;
    const preset = useSessions.getState().handoverTarget;
    const first = CLI_IDS.find((id) => id !== source.cliId) ?? source.cliId;
    setTargetCli(preset && preset !== source.cliId ? preset : first);
    setProfileSlug(NEW_PROFILE);
    setProfileName("");
    setWhere("same");
    setBranchEdited(false);
    setBranch(defaultHandoverBranch(srcBranch, first));
    setIncludeTail(true);
    setIncludeDiff(false);
    setStopSource(false);
    setBinaries(null);
    void useSessions.getState().checkBinaries().then(setBinaries);
    const srcDef = CLI_REGISTRY[source.cliId];
    const base =
      `# Handover from ${srcDef.name} (${source.profile.slug}) in ${source.worktreePath}\n` +
      `Status: ${source.status}\n\n## Task\n\n## Done\n\n## Remaining\n`;
    void readStatus(source.worktreePath)
      .then((summary) => {
        const files = [...summary.staged, ...summary.unstaged].map(
          (entry) => `- ${entry.path} (${entry.indexStatus}${entry.worktreeStatus})`,
        );
        setNote(files.length > 0 ? `${base}\n## Changed files\n${files.join("\n")}\n` : base);
      })
      .catch(() => setNote(base));
  }, [sourceId]);

  useEffect(() => {
    if (source && !branchEdited) setBranch(defaultHandoverBranch(srcBranch, targetCli));
  }, [targetCli]);

  if (!sourceId || !source) return null;
  const srcDef = CLI_REGISTRY[source.cliId];
  const def = CLI_REGISTRY[targetCli];
  const cliProfiles = profiles.filter((p) => p.cliId === targetCli);
  const resolved = binaries?.[targetCli];
  const binaryMissing = !!binaries && !!def.binary && !resolved;
  const customNeedsSettings = targetCli === "custom";
  const slug = profileSlug === NEW_PROFILE ? slugify(profileName) : profileSlug;
  const canStart =
    !!binaries &&
    !binaryMissing &&
    !customNeedsSettings &&
    targetCli !== source.cliId &&
    !!slug &&
    (where === "same" || !!branch.trim());

  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    toast({ title: message, icon: "⚠" });
  };

  const start = () => {
    if (!canStart) return;
    void (async () => {
      const store = useSessions.getState();
      let ref = profileSlug === NEW_PROFILE ? "" : profileSlug;
      if (profileSlug === NEW_PROFILE) {
        const created = await useProfiles.getState().createProfile(targetCli, profileName);
        if (!created) return;
        ref = created.slug;
      }
      let targetWt = source.worktreePath;
      if (where === "new") {
        const wtState = useWorktrees.getState();
        const projectId = wtState.projectId;
        if (!projectId) {
          toast({ title: t("agents.handoverNoProject"), icon: "⚠" });
          return;
        }
        const cleanBranch = branch.trim();
        const parent = worktreeParentDir(source.worktreePath);
        const dirName = cleanBranch.split("/").pop() || "handover";
        const destination = parent === "/" ? `/${dirName}` : `${parent}/${dirName}`;
        try {
          const created = await createUnpinnedWorktree(projectId, destination, cleanBranch);
          targetWt = created.path;
          // Like Graph's worktree creation: refresh the list and follow the
          // new worktree so the handover target session stays visible.
          const project =
            useRepos.getState().projects.find((p) => p.id === projectId) ?? null;
          if (project) await wtState.load(project);
          wtState.select(targetWt);
        } catch (error) {
          fail(error);
          return;
        }
      }
      let body = note;
      if (includeTail) {
        const tailLines = store.getOutputTail(source.id, 50);
        if (tailLines.length > 0) body += `\n## Recent output\n${tailLines.join("\n")}\n`;
      }
      if (includeDiff) {
        try {
          const diff = await readHandoverDiff(source.worktreePath);
          if (diff.trim()) body += `\n## Diff\n${diff}`;
        } catch (error) {
          fail(error);
          return;
        }
      }
      try {
        await writeHandoverNote(targetWt, body);
      } catch (error) {
        fail(error);
        return;
      }
      if (stopSource) await store.closeSession(source.id, { confirm: false });
      const newId = await store.startSession({
        cliId: targetCli,
        profile: { cliId: targetCli, slug: ref },
        worktreePath: targetWt,
      });
      if (!newId) return;
      const rec = useSessions.getState().sessions.find((s) => s.id === newId);
      if (rec?.sessionId) {
        const line = t("agents.handoverLine", {
          from: `${srcDef.name} (${source.profile.slug})`,
        });
        await writeTerminal(rec.sessionId, new TextEncoder().encode(`\x1b[2m${line}\x1b[0m\n`)).catch(
          () => undefined,
        );
      }
      close();
    })();
  };

  return (
    <div className="dlg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dlg dlg-wide" role="dialog" aria-modal="true" aria-labelledby="handover-dialog-title">
        <div className="dlg-ic">↗</div>
        <h3 id="handover-dialog-title">{t("agents.handoverTitle")}</h3>
        <p>
          {t("agents.handoverFrom")}: {srcDef.name} · {tail(source.worktreePath)} · {source.status}
        </p>
        <div className="agent-h4">{t("agents.handoverTo")}</div>
        <div className="agent-apick" role="radiogroup" aria-label={t("agents.handoverTo")}>
          {CLI_IDS.map((id) => {
            const entry = CLI_REGISTRY[id];
            const missing = !!binaries && !!entry.binary && !binaries[id];
            const disabled = missing || id === source.cliId;
            return (
              <label
                key={id}
                className={missing ? "missing" : ""}
                title={id === source.cliId ? srcDef.name : entry.name}
              >
                <input
                  type="radio"
                  name="handover-cli"
                  value={id}
                  checked={targetCli === id}
                  disabled={disabled}
                  onChange={() => { setTargetCli(id); setProfileSlug(NEW_PROFILE); }}
                />
                <span className="agent-apick-icon" aria-hidden>
                  <CliIcon id={id} size={16} />
                </span>
                <span className="agent-apick-name">{entry.name}</span>
                <small>{id}</small>
              </label>
            );
          })}
        </div>
        {!binaries && <p className="agent-hint">{t("agents.dialogChecking")}</p>}
        <div className="agent-h4">{t("agents.dialogProfile")}</div>
        <select
          className="input"
          aria-label={t("agents.dialogProfile")}
          value={profileSlug}
          onChange={(e) => setProfileSlug(e.target.value)}
        >
          {cliProfiles.map((p) => (
            <option key={p.slug} value={p.slug}>{p.name}</option>
          ))}
          <option value={NEW_PROFILE}>{t("agents.dialogNewProfile")}</option>
        </select>
        {profileSlug === NEW_PROFILE && (
          <input
            className="input"
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            placeholder={t("agents.dialogProfileName")}
            aria-label={t("agents.dialogProfileName")}
          />
        )}
        <div className="agent-h4">{t("agents.handoverWhere")}</div>
        <div role="radiogroup" aria-label={t("agents.handoverWhere")}>
          <label className="agent-check">
            <input type="radio" name="handover-where" checked={where === "same"} onChange={() => setWhere("same")} />
            {t("agents.handoverSame")}
          </label>
          <label className="agent-check">
            <input type="radio" name="handover-where" checked={where === "new"} onChange={() => setWhere("new")} />
            {t("agents.handoverNew")}
          </label>
        </div>
        {where === "new" && (
          <input
            className="input"
            value={branch}
            onChange={(e) => { setBranch(e.target.value); setBranchEdited(true); }}
            placeholder={t("agents.handoverBranch")}
            aria-label={t("agents.handoverBranch")}
          />
        )}
        <div className="agent-h4">{t("agents.handoverNote")}</div>
        <textarea
          className="input"
          rows={8}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-label={t("agents.handoverNote")}
        />
        <label className="agent-check">
          <input type="checkbox" checked={includeTail} onChange={(e) => setIncludeTail(e.target.checked)} />
          {t("agents.handoverIncludeTail")}
        </label>
        <label className="agent-check">
          <input type="checkbox" checked={includeDiff} onChange={(e) => setIncludeDiff(e.target.checked)} />
          {t("agents.handoverIncludeDiff")}
        </label>
        <label className="agent-check">
          <input type="checkbox" checked={stopSource} onChange={(e) => setStopSource(e.target.checked)} />
          {t("agents.handoverStopSource")}
        </label>
        <div className="dlg-meta">{previewCommand(targetCli, slug)} # {t("agents.handoverNoteFile")}</div>
        <div className="dlg-actions">
          <button type="button" className="btn" onClick={() => close()}>{t("agents.dialogCancel")}</button>
          <button type="button" className="btn p" disabled={!canStart} onClick={start}>{t("agents.handoverStart")}</button>
        </div>
      </div>
    </div>
  );
}

const RACEABLE_IDS = CLI_IDS.filter((id) => id !== "custom");

function defaultRaceSlug(prompt: string): string {
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "race";
  return slug;
}

function RaceDialog() {
  const open = useSessions((s) => s.raceOpen);
  const setOpen = useSessions((s) => s.setRaceOpen);
  const sessions = useSessions((s) => s.sessions);
  const entries = useSessions((s) => s.raceEntries);
  // Subscribe so profile add/remove re-renders the missing-profile hints.
  void useProfiles((s) => s.profiles);

  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<CliId[]>([]);
  const [binaries, setBinaries] = useState<Record<CliId, string | null> | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileCounts, setFileCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setSelected([]);
    setBusy(false);
    setBinaries(null);
    void useSessions.getState().checkBinaries().then(setBinaries);
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    for (const entry of entries) {
      if (fileCounts[entry.id] === undefined) {
        void readStatus(entry.worktreePath)
          .then((summary) => {
            const count = summary.staged.length + summary.unstaged.length;
            setFileCounts((counts) => ({ ...counts, [entry.id]: count }));
          })
          .catch(() => setFileCounts((counts) => ({ ...counts, [entry.id]: -1 })));
      }
    }
  }, [open, entries, fileCounts]);

  if (!open) return null;

  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    toast({ title: message, icon: "⚠" });
  };

  const toggle = (id: CliId) => {
    setSelected((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]));
  };

  const missingProfiles = selected.filter(
    (id) => !useProfiles.getState().resolveProfile(id),
  );
  const canStart =
    !!binaries &&
    !busy &&
    prompt.trim().length > 0 &&
    selected.length > 0 &&
    selected.every((id) => {
      const def = CLI_REGISTRY[id];
      return !def.binary || !!binaries[id];
    }) &&
    missingProfiles.length === 0 &&
    !!useWorktrees.getState().projectId;

  const start = () => {
    if (!canStart) return;
    setBusy(true);
    void (async () => {
      const store = useSessions.getState();
      const wtState = useWorktrees.getState();
      const projectId = wtState.projectId;
      const project = useRepos.getState().projects.find((p) => p.id === projectId) ?? null;
      if (!projectId || !project) {
        fail(new Error(t("agents.raceNoProject")));
        setBusy(false);
        return;
      }
      const slug = defaultRaceSlug(prompt.trim());
      const parent = worktreeParentDir(project.localPath);
      for (const cliId of selected) {
        const profile = useProfiles.getState().resolveProfile(cliId);
        if (!profile) {
          fail(new Error(t("agents.raceNoProfile", { name: CLI_REGISTRY[cliId].name })));
          continue;
        }
        const branch = `race/${slug}-${cliId}`;
        const dirName = branch.split("/").pop() || `race-${cliId}`;
        const destination = parent === "/" ? `/${dirName}` : `${parent}/${dirName}`;
        try {
          const created = await createUnpinnedWorktree(projectId, destination, branch);
          const newId = await store.startSession({
            cliId,
            profile,
            worktreePath: created.path,
            prompt: prompt.trim(),
          });
          if (!newId) continue;
          store.addRaceEntry({ id: newId, cliId, worktreePath: created.path });
        } catch (error) {
          fail(error);
        }
      }
      setBusy(false);
    })();
  };

  const keep = (id: string) => {
    useSessions.getState().removeRaceEntry(id);
  };

  const discard = (entry: RaceEntry) => {
    void (async () => {
      const branch =
        useWorktrees.getState().worktrees.find((w) => w.path === entry.worktreePath)?.branch ??
        tail(entry.worktreePath);
      const confirmed = await ask({
        title: t("agents.raceDiscardTitle"),
        body: t("agents.raceDiscardBody", { branch }),
        ok: t("agents.raceDiscardOk"),
        icon: "⚠",
      });
      if (!confirmed) return;
      const store = useSessions.getState();
      const wtState = useWorktrees.getState();
      if (!wtState.projectId) {
        fail(new Error(t("agents.raceNoProject")));
        return;
      }
      await store.closeSession(entry.id, { confirm: false });
      try {
        await removeWorktree(wtState.projectId, entry.worktreePath, true);
        const project =
          useRepos.getState().projects.find((p) => p.id === wtState.projectId) ?? null;
        if (project) await wtState.load(project);
      } catch (error) {
        fail(error);
        return;
      }
      store.removeRaceEntry(entry.id);
    })();
  };

  return (
    <div className="dlg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="dlg dlg-wide" role="dialog" aria-modal="true" aria-labelledby="race-dialog-title">
        <div className="dlg-ic">⚑</div>
        <h3 id="race-dialog-title">{t("agents.raceTitle")}</h3>
        <div className="agent-h4">{t("agents.racePrompt")}</div>
        <textarea
          className="input"
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("agents.racePromptPlaceholder")}
          aria-label={t("agents.racePrompt")}
        />
        <div className="agent-h4">{t("agents.raceClis")}</div>
        <div className="agent-apick" role="group" aria-label={t("agents.raceClis")}>
          {RACEABLE_IDS.map((id) => {
            const entry = CLI_REGISTRY[id];
            const missing = !!binaries && !!entry.binary && !binaries[id];
            return (
              <label key={id} className={missing ? "missing" : ""} title={entry.name}>
                <input
                  type="checkbox"
                  checked={selected.includes(id)}
                  disabled={missing}
                  onChange={() => toggle(id)}
                />
                <span className="agent-apick-icon" aria-hidden>
                  <CliIcon id={id} size={16} />
                </span>
                <span className="agent-apick-name">{entry.name}</span>
                <small>{id}</small>
              </label>
            );
          })}
        </div>
        {!binaries && <p className="agent-hint">{t("agents.dialogChecking")}</p>}
        {selected.length === 0 && binaries && (
          <p className="agent-hint">{t("agents.raceNeedCli")}</p>
        )}
        {missingProfiles.length > 0 && (
          <p className="agent-hint">
            {missingProfiles.map((id) => t("agents.raceNoProfile", { name: CLI_REGISTRY[id].name })).join(" · ")}
          </p>
        )}
        <div className="agent-h4">{t("agents.raceEntries")}</div>
        {entries.length === 0 ? (
          <p className="agent-hint">{t("agents.raceEmpty")}</p>
        ) : (
          <ul className="agent-race-list">
            {entries.map((entry) => {
              const def = CLI_REGISTRY[entry.cliId];
              const session = sessions.find((s) => s.id === entry.id);
              const count = fileCounts[entry.id];
              return (
                <li key={entry.id}>
                  <span className="agent-apick-icon" aria-hidden>
                    <CliIcon id={entry.cliId} size={16} />
                  </span>
                  {def.name} · {tail(entry.worktreePath)} · {session?.status ?? t("agents.statusDone")} ·{" "}
                  {count === undefined
                    ? "…"
                    : count < 0
                      ? t("agents.raceChangedUnknown")
                      : t("agents.raceChangedFiles", { count: String(count) })}
                  <span className="sp" />
                  <button type="button" className="btn sm" onClick={() => keep(entry.id)}>
                    {t("agents.raceKeep")}
                  </button>
                  <button type="button" className="btn sm" onClick={() => discard(entry)}>
                    {t("agents.raceDiscard")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="dlg-actions">
          <button type="button" className="btn" onClick={() => setOpen(false)}>{t("agents.dialogCancel")}</button>
          <button type="button" className="btn p" disabled={!canStart} onClick={start}>
            {t("agents.raceStart")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AgentsView() {
  const sessions = useSessions((s) => s.sessions);
  const layoutMode = useSessions((s) => s.layoutMode);
  const loaded = useSessions((s) => s.loaded);
  // The Agents page follows the active worktree like Files/Changes/Graph do;
  // with no project open every session stays visible. Off-worktree panes stay
  // mounted but hidden, so switching projects never replays terminal output
  // or storms the PTY with resizes that garble full-screen CLI apps.
  const activePath = useWorktrees((s) => s.activePath);
  const ordered = [...sessions].sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot));
  const visible = ordered.filter((s) => activePath == null || s.worktreePath === activePath);
  // A lone default session fills the whole view; the grid kicks in on split.
  const solo = visible.length === 1 && visible[0].slot === "auto";

  if (!loaded) return null;
  return (
    <div
      className={
        "agent-screen" + (layoutMode === "full" ? " agent-full" : "") + (solo ? " agent-solo" : "")
      }
    >
      <NewAgentDialog />
      <HandoverDialog />
      <RaceDialog />
      {visible.length === 0 && (
        <div className="agent-empty" role="status">
          <span>{t("agents.empty")}</span>
          <button type="button" className="btn" onClick={() => useSessions.getState().setNewAgentOpen(true)}>
            ＋ {t("agents.newAgent")}
          </button>
        </div>
      )}
      <div className={"agent-grid" + (visible.length === 0 ? " agent-grid-empty" : "")}>
        {ordered.map((session) => (
          <AgentPane
            key={session.id}
            session={session}
            off={activePath != null && session.worktreePath !== activePath}
          />
        ))}
      </div>
    </div>
  );
}

function slotOrder(slot: AgentSession["slot"]): number {
  return slot === "left" || slot === "right" ? 0 : slot === "auto" ? 1 : 2;
}
