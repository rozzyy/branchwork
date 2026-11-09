import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { CliPane } from "../../terminal/CliPane";
import { CLI_IDS, CLI_REGISTRY, resolveCli, type CliId } from "../../agents/registry";
import { useProfiles } from "../../agents/profiles";
import { useSessions, type AgentSession, type AgentStatus } from "../../agents/sessions";
import { useStage } from "../../state/stage";
import { useWorktrees } from "../../state/worktrees";
import { Menu, type MenuItem } from "../../ui/Menu";
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

function AgentPane({ session }: { session: AgentSession }) {
  const store = useSessions.getState();
  const isExited = useSessions((s) => s.isExited);
  const status = paneStatus(session, isExited);
  const def = CLI_REGISTRY[session.cliId];
  return (
    <div
      className={`agent-pane st-${status}`}
      data-slot={session.slot}
      aria-label={t("agents.paneLabel", { cli: def.name, name: tail(session.worktreePath) })}
    >
      <div className="agent-phd">
        <StatusDot status={status} />
        <span className="mono agent-wt" title={session.worktreePath}>
          {tail(session.worktreePath)}
        </span>
        <span className="agent-cli" title={def.name}>
          {def.icon} {def.name}
        </span>
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
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="agent-dialog-title">
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
                  {entry.icon}
                </span>
                {entry.name}
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

export function AgentsView() {
  const sessions = useSessions((s) => s.sessions);
  const layoutMode = useSessions((s) => s.layoutMode);
  const loaded = useSessions((s) => s.loaded);
  const ordered = [...sessions].sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot));
  // A lone default session fills the whole view; the grid kicks in on split.
  const solo = ordered.length === 1 && ordered[0].slot === "auto";

  if (!loaded) return null;
  return (
    <div
      className={
        "agent-screen" + (layoutMode === "full" ? " agent-full" : "") + (solo ? " agent-solo" : "")
      }
    >
      <NewAgentDialog />
      {ordered.length === 0 ? (
        <div className="agent-empty" role="status">
          <span>{t("agents.empty")}</span>
          <button type="button" className="btn" onClick={() => useSessions.getState().setNewAgentOpen(true)}>
            ＋ {t("agents.newAgent")}
          </button>
        </div>
      ) : (
        <div className="agent-grid">
          {ordered.map((session) => (
            <AgentPane key={session.id} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}

function slotOrder(slot: AgentSession["slot"]): number {
  return slot === "left" || slot === "right" ? 0 : slot === "auto" ? 1 : 2;
}
