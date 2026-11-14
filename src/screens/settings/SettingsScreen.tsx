import { useCallback, useEffect, useState, type ReactNode } from "react";
import { t } from "../../i18n/t";
import { useSettings } from "../../state/settings";
import { CLI_IDS, CLI_REGISTRY, type CliId } from "../../agents/registry";
import { CliIcon } from "../../agents/cliIcons";
import { useProfiles, usageKey } from "../../agents/profiles";
import { GithubAccounts } from "./GithubAccounts";
import { parseClaudeAuth, parseMuseUsage, PROBED_CLIS } from "../../agents/probe";
import { probeCli, profileHasCredentials } from "../../ipc/cli";

/** Outcome of one vendor probe round; null when the probe itself failed. */
interface ProbeOutcome {
  linked: boolean;
  identity: string | null;
}

/**
 * Run the vendor probe and publish the result to the store (identity label,
 * muse usage bars). Failed probes leave the
 * store untouched — unknown stays unknown, never fabricated.
 */
async function probeOnce(cliId: CliId): Promise<ProbeOutcome | null> {
  const store = useProfiles.getState();
  let raw: string;
  try {
    raw = await probeCli(cliId);
  } catch {
    return null;
  }
  if (cliId === "claude") {
    const auth = parseClaudeAuth(raw);
    if (!auth) return null;
    store.setCliProbe(cliId, { linked: auth.loggedIn, identity: auth.email });
    return { linked: auth.loggedIn, identity: auth.email };
  }
  if (cliId === "muse") {
    const usage = parseMuseUsage(raw);
    if (!usage) {
      store.setCliProbe(cliId, { linked: false, identity: null });
      return { linked: false, identity: null };
    }
    store.setCliProbe(cliId, { linked: true, identity: null });
    for (const profile of store.profiles.filter((item) => item.cliId === cliId)) {
      store.setProfileUsage({ cliId, slug: profile.slug }, usage);
    }
    return { linked: true, identity: null };
  }
  return null;
}

const AGENT_CLIS = CLI_IDS.filter((id): id is Exclude<CliId, "custom"> => id !== "custom");
import { UsageBar } from "../../agents/usage";
import { Segmented, Switch } from "../../ui/controls";
import { Button } from "../../ui/Button";
import { BusyButton } from "../../ui/BusyButton";
import { toast } from "../../ui/toast";
import { ask } from "../../ui/dialog";
import type { Density, TextSize, ThemeMode } from "../../theme/theme";

const SWATCHES = [250, 300, 350, 25, 60, 155, 200];

export function SettingsToolbar() {
  return <h1 className="pane-title">{t("nav.settings")}</h1>;
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="opt">
      <div className="opt-label">{label}</div>
      <div className="opt-ctl">{children}</div>
    </div>
  );
}

/**
 * Actions for one profile row. Linked state comes from a credential-file
 * check (providers with per-profile credentials) or a host-global vendor
 * probe (claude/muse) — otherwise it stays unknown. A verified-unlinked row
 * shows Log in + Remove; Logout exists only where profile-dir credentials
 * can actually be deleted (spec §6.6.4), so a row never looks connected
 * when it is not.
 */
function AccountActions({
  cliId,
  slug,
  name,
  isDefault,
  onCheckingChange,
}: {
  cliId: CliId;
  slug: string;
  name: string;
  isDefault: boolean;
  onCheckingChange: (key: string, checking: boolean) => void;
}) {
  const def = CLI_REGISTRY[cliId];
  const store = useProfiles.getState();
  const ref = { cliId, slug };
  const key = usageKey(ref);
  const pending = useProfiles((s) => s.loginPending[usageKey(ref)] != null);
  const observedProbe = useProfiles((s) =>
    cliId === "claude" ? s.profileProbes[key] : s.cliProbes[cliId],
  );
  const verifiable = def.credentialPaths.length > 0 || PROBED_CLIS.includes(cliId);
  // null = still checking: render no Logout affordance at all until the
  // check resolves, so a row never flashes "connected".
  const [linked, setLinked] = useState<boolean | null | "unknown">(null);
  const readLoginStatus = useCallback(async (): Promise<boolean | null> => {
    if (cliId === "claude") {
      return useProfiles.getState().checkProfileLogin({ cliId, slug });
    }
    if (def.credentialPaths.length > 0) {
      try {
        return await profileHasCredentials(cliId, slug, def.credentialPaths);
      } catch {
        return false;
      }
    }
    if (!PROBED_CLIS.includes(cliId)) return null;
    return (await probeOnce(cliId))?.linked ?? null;
  }, [cliId, slug, def.credentialPaths]);
  const check = useCallback(() => {
    let live = true;
    setLinked(null);
    onCheckingChange(key, true);
    void readLoginStatus()
      .then((value) => {
        if (live) setLinked(value ?? "unknown");
      })
      .catch(() => {
        if (live) setLinked("unknown");
      })
      .finally(() => {
        if (live) onCheckingChange(key, false);
      });
    return () => {
      live = false;
      onCheckingChange(key, false);
    };
  }, [key, onCheckingChange, readLoginStatus]);
  useEffect(() => check(), [check]);
  useEffect(() => {
    if (observedProbe) setLinked(observedProbe.linked);
  }, [observedProbe]);
  // Re-check while unlinked: the user may finish the vendor login in the
  // login PTY at any moment — flip without requiring a reload.
  useEffect(() => {
    if ((linked !== false && linked !== "unknown") || !verifiable) return undefined;
    const timer = setInterval(() => {
      void readLoginStatus().then((value) => setLinked(value ?? "unknown"));
    }, 5000);
    return () => clearInterval(timer);
  }, [linked, verifiable, readLoginStatus]);
  const remove = async () => {
    const confirmed = await ask({
      title: t("settings.removeAccountTitle", { name }),
      body: t(cliId === "muse" ? "settings.removeMuseAccountBody" : "settings.removeAccountBody"),
      ok: t("settings.removeAccountOk"),
      danger: true,
      icon: "◔",
    });
    if (confirmed !== true) return;
    await store.removeAccount(ref);
  };
  // After logout the credential files are gone: re-check immediately so
  // the row flips to Log in without requiring a reload.
  const logout = async () => {
    const removed = await store.logoutProfile(ref);
    if (removed !== null) check();
  };
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        title={isDefault ? t("settings.clearDefault") : t("settings.setDefault")}
        onClick={() => store.setCliDefault(cliId, isDefault ? null : ref)}
      >
        {isDefault ? `✓ ${t("settings.isDefault")}` : t("settings.setDefault")}
      </Button>
      {pending ? (
        <span className="agent-acct-status" role="status">
          <span className="spin" aria-hidden="true" /> {t("settings.waitingLogin")}
        </span>
      ) : !verifiable || linked === "unknown" ? (
        <span className="agent-acct-status">{t("settings.loginStatusUnknown")}</span>
      ) : linked === true ? (
        <span className="chip cg">✓ {t("settings.loggedIn")}</span>
      ) : linked === false ? (
        <span className="chip">{t("settings.notLoggedIn")}</span>
      ) : null}
      {!verifiable || pending ? null : linked === true ? (
        // Logout only deletes profile-dir credentials. Probe-based providers
        // have no verified credential file to remove.
        def.credentialPaths.length > 0 ? (
          <Button size="sm" variant="danger" onClick={() => void logout()}>
            {t("agents.logoutOk")}
          </Button>
        ) : null
      ) : linked === null ? (
        <span className="agent-acct-check" role="status" aria-label={t("settings.checkingLogin")}>
          <span className="spin" aria-hidden="true" />
        </span>
      ) : null}
      {linked !== null && linked !== true && (
        <BusyButton size="sm" onExecute={() => store.loginProfile(ref)}>
          {t("settings.signInAgain")}
        </BusyButton>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => {
          const nextName = await ask({
            title: t("settings.editProfileTitle", { name }),
            body: t("settings.editProfileBody"),
            input: name,
            ok: t("settings.editProfileOk"),
            icon: "✎",
          });
          if (typeof nextName === "string") store.renameProfile(ref, nextName);
        }}
      >
        {t("settings.editProfile")}
      </Button>
      <BusyButton size="sm" variant="ghost" onExecute={remove}>
        {t("settings.removeAccount")}
      </BusyButton>
    </>
  );
}

/** Per-CLI account management on top of the profiles store (spec Accounts). */
function AgentAccounts() {
  const profiles = useProfiles((s) => s.profiles);
  const cliDefaults = useProfiles((s) => s.cliDefaults);
  const usageBy = useProfiles((s) => s.usage);
  const cliProbes = useProfiles((s) => s.cliProbes);
  const profileProbes = useProfiles((s) => s.profileProbes);
  const store = useProfiles.getState();
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const onCheckingChange = useCallback((key: string, isChecking: boolean) => {
    setChecking((current) => {
      const next = new Set(current);
      if (isChecking) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const addProfile = async (cliId: CliId) => {
    const def = CLI_REGISTRY[cliId];
    const name = await ask({
      title: t("agents.addTitle", { name: def.name }),
      body: t(cliId === "muse" ? "settings.addMuseAccountBody" : "agents.addBody", {
        name: def.name,
      }),
      input: "",
      ok: t("agents.addOk"),
      icon: <CliIcon id={def.id} />,
    });
    if (typeof name !== "string") return;
    const profile = await store.createProfile(cliId, name);
    if (profile) await store.loginProfile({ cliId, slug: profile.slug });
  };
  // Muse usage is CLI-global. Claude rows probe their selected profile's
  // config dir independently.
  useEffect(() => {
    for (const cliId of AGENT_CLIS) {
      if (PROBED_CLIS.includes(cliId) && cliId !== "claude") void probeOnce(cliId);
    }
  }, []);
  return (
    <div className="card agent-accts">
      {checking.size > 0 && (
        <div className="settings-account-loading" role="status">
          <span className="spin" aria-hidden="true" />
          {t("settings.checkingAccounts", { count: checking.size })}
        </div>
      )}
      {AGENT_CLIS.map((cliId) => {
        const def = CLI_REGISTRY[cliId];
        const list = profiles.filter((p) => p.cliId === cliId);
        return (
          <div key={cliId} className="agent-acct-cli">
            <div className="opt">
              <div className="opt-label">
                <b>
                  <CliIcon id={cliId} /> {def.name}
                </b>
                <small className="mono agent-acct-path">
                  ~/.branchwork/profiles/{cliId}-&lt;account&gt;
                </small>
              </div>
              <div className="opt-ctl">
                <BusyButton size="sm" onExecute={() => addProfile(cliId)}>
                  {t("settings.addAccount")}
                </BusyButton>
              </div>
            </div>
            {list.map((profile) => {
              const isDefault = cliDefaults[cliId]?.slug === profile.slug;
              const usage = usageBy[usageKey({ cliId, slug: profile.slug })];
              const identity =
                (cliId === "claude"
                  ? profileProbes[usageKey({ cliId, slug: profile.slug })]
                  : cliProbes[cliId]
                )?.identity ?? null;
              return (
                <div key={profile.slug} className="opt agent-acct-row">
                  <div className="opt-label">
                    <b>
                      {profile.name}{" "}
                      {isDefault && <span className="chip cg">{t("settings.isDefault")}</span>}
                    </b>
                    <small className="mono agent-acct-path">
                      ~/.branchwork/profiles/{cliId}-{profile.slug}
                    </small>
                  </div>
                  <div className="opt-ctl">
                    {usage ? (
                      <div className="agent-acct-usage">
                        {t("settings.usageLimit", { window: usage.window, percent: usage.percent })}
                        <UsageBar usage={usage} className="agent-acct-bar" />
                      </div>
                    ) : identity ? (
                      <span className="agent-acct-nousage">{identity}</span>
                    ) : (
                      <span className="agent-acct-nousage">{t("settings.noUsageLimit")}</span>
                    )}
                    <AccountActions
                      cliId={cliId}
                      slug={profile.slug}
                      name={profile.name}
                      isDefault={isDefault}
                      onCheckingChange={onCheckingChange}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Comma-separated commands the RTK-style saver never rewrites; saved on blur/Enter. */
function SaverProtectedInput() {
  const saved = useSettings((s) => s.agentSaverProtected);
  const setProtected = useSettings((s) => s.setAgentSaverProtected);
  const [draft, setDraft] = useState(saved.join(", "));
  useEffect(() => setDraft(saved.join(", ")), [saved]);
  const commit = () => setProtected(draft.split(","));
  return (
    <input
      type="text"
      className="input"
      value={draft}
      placeholder={t("settings.saverProtectedPlaceholder")}
      aria-label={t("settings.saverProtected")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

export function SettingsView() {
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const agentAutoSwitch = useSettings((s) => s.agentAutoSwitch);
  const setAgentAutoSwitch = useSettings((s) => s.setAgentAutoSwitch);
  const agentTokenSaver = useSettings((s) => s.agentTokenSaver);
  const setAgentTokenSaver = useSettings((s) => s.setAgentTokenSaver);
  const singleKeyShortcuts = useSettings((s) => s.singleKeyShortcuts);
  const setSingleKeyShortcuts = useSettings((s) => s.setSingleKeyShortcuts);
  const profilesLoaded = useProfiles((s) => s.loaded);
  const profileLoadError = useProfiles((s) => s.loadError);
  const loadProfiles = useProfiles((s) => s.load);

  const demoConfirm = async () => {
    const r = await ask({ title: t("demo.confirm.title"), body: t("demo.confirm.body"), ok: t("demo.confirm.ok"), icon: "↑" });
    toast({ title: r ? t("demo.result.confirmed") : t("demo.result.cancelled"), icon: r ? "✓" : "✕" });
  };
  const demoDanger = async () => {
    const r = await ask({
      title: t("demo.danger.title"), body: t("demo.danger.body"), ok: t("demo.danger.ok"), danger: true, icon: "↶",
      meta: "M  src/auth/callback.ts\nA  src/ui/LoginButton.tsx\nD  src/auth/legacy.ts",
    });
    toast({ title: r ? t("demo.result.confirmed") : t("demo.result.cancelled"), icon: r ? "✓" : "✕" });
  };
  const demoInput = async () => {
    const r = await ask({ title: t("demo.input.title"), body: t("demo.input.body"), ok: t("demo.input.ok"), icon: "＋", input: "src/new-file.ts" });
    toast(typeof r === "string" ? { title: t("demo.result.created", { name: r }) } : { title: t("demo.result.cancelled"), icon: "✕" });
  };

  if (!profilesLoaded) {
    return (
      <div className="settings settings-loading" role="status" aria-live="polite">
        <span className="spin" aria-hidden="true" />
        <span>{t("settings.loadingSettings")}</span>
        {profileLoadError && (
          <>
            <small>{t("settings.settingsLoadFailed", { message: profileLoadError })}</small>
            <BusyButton
              size="sm"
              onExecute={loadProfiles}
            >
              {t("settings.retry")}
            </BusyButton>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="settings">
      <h3>{t("settings.appearance")}</h3>
      <div className="card">
        <Row label={t("settings.theme")}>
          <Segmented<ThemeMode>
            label={t("settings.theme")}
            value={theme.mode}
            onChange={(mode) => setTheme({ mode })}
            options={[
              { value: "system", label: t("settings.theme.system") },
              { value: "light", label: t("settings.theme.light") },
              { value: "dark", label: t("settings.theme.dark") },
            ]}
          />
        </Row>
        <Row label={t("settings.accent")}>
          <div className="swatches">
            {SWATCHES.map((h) => (
              <button key={h} aria-label={t("settings.accentHue", { hue: h })} className={"swatch" + (theme.accentHue === h ? " on" : "")} style={{ background: `oklch(.68 .19 ${h})` }} onClick={() => setTheme({ accentHue: h })} />
            ))}
          </div>
          <input type="range" min={0} max={360} value={theme.accentHue} aria-label={t("settings.accent")} onChange={(e) => setTheme({ accentHue: Number(e.target.value) })} />
        </Row>
        <Row label={t("settings.baseTint")}>
          <input type="range" min={0} max={360} value={theme.baseHue} aria-label={t("settings.baseTint")} onChange={(e) => setTheme({ baseHue: Number(e.target.value) })} />
        </Row>
        <Row label={t("settings.textSize")}>
          <Segmented<TextSize>
            label={t("settings.textSize")}
            value={theme.textSize}
            onChange={(textSize) => setTheme({ textSize })}
            options={[
              { value: "default", label: t("settings.textSize.default") },
              { value: "large", label: t("settings.textSize.large") },
            ]}
          />
        </Row>
        <Row label={t("settings.density")}>
          <Segmented<Density>
            label={t("settings.density")}
            value={theme.density}
            onChange={(density) => setTheme({ density })}
            options={[
              { value: "compact", label: t("settings.density.compact") },
              { value: "default", label: t("settings.density.default") },
              { value: "comfy", label: t("settings.density.comfy") },
            ]}
          />
        </Row>
      </div>

      <h3>{t("settings.keyboard")}</h3>
      <div className="card">
        <Row label={t("settings.singleKeyShortcuts")}>
          <Switch label={t("settings.singleKeyShortcuts")} checked={singleKeyShortcuts} onChange={setSingleKeyShortcuts} />
        </Row>
        <Row label={t("settings.terminalShortcut")}><kbd>Ctrl+`</kbd></Row>
      </div>

      <h3>{t("settings.agents")}</h3>
      <div className="card">
        <Row label={t("settings.autoSwitch")}>
          <Switch
            label={t("settings.autoSwitch")}
            checked={agentAutoSwitch}
            onChange={(on) => setAgentAutoSwitch(on)}
          />
        </Row>
        <Row label={t("settings.tokenSaver")}>
          <Switch
            label={t("settings.tokenSaver")}
            checked={agentTokenSaver}
            onChange={(on) => setAgentTokenSaver(on)}
          />
        </Row>
        <Row label={t("settings.saverProtected")}>
          <SaverProtectedInput />
        </Row>
      </div>
      <h3>{t("settings.agentAccounts")}</h3>
      <AgentAccounts />
      <h3>{t("settings.githubAccounts")}</h3>
      <GithubAccounts />

      <h3>{t("settings.demo")}</h3>
      <div className="card demo">
        <Button onClick={() => toast({ title: t("demo.toast.title"), detail: t("demo.toast.detail"), action: { label: t("toast.undo"), run: () => toast({ title: t("demo.undone"), icon: "↶" }) } })}>{t("settings.demo.toast")}</Button>
        <Button variant="primary" onClick={demoConfirm}>{t("settings.demo.confirm")}</Button>
        <Button variant="danger" onClick={demoDanger}>{t("settings.demo.danger")}</Button>
        <Button onClick={demoInput}>{t("settings.demo.input")}</Button>
      </div>
    </div>
  );
}
