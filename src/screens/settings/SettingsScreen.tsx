import { useCallback, useEffect, useState, type ReactNode } from "react";
import { t } from "../../i18n/t";
import { useSettings } from "../../state/settings";
import { CLI_IDS, CLI_REGISTRY, type CliId } from "../../agents/registry";
import { CliIcon } from "../../agents/cliIcons";
import { useProfiles, usageKey } from "../../agents/profiles";
import { QUOTA_CLIS, useAgentMeters } from "../../agents/quota";
import { GithubAccounts } from "./GithubAccounts";
import { AccountRow } from "./AccountRow";
import { probeOnce } from "./accountProbe";
import { PROBED_CLIS } from "../../agents/probe";
import { Segmented, Switch } from "../../ui/controls";
import { Button } from "../../ui/Button";
import { BusyButton } from "../../ui/BusyButton";
import { Menu } from "../../ui/Menu";
import { ask } from "../../ui/dialog";
import type { Density, TextSize, ThemeMode } from "../../theme/theme";

const AGENT_CLIS = CLI_IDS.filter((id): id is Exclude<CliId, "custom"> => id !== "custom");

const SWATCHES = [250, 300, 350, 25, 60, 155, 200];

export function SettingsToolbar() {
  return <h1 className="pane-title">{t("nav.settings")}</h1>;
}

function Row({ label, hint, children }: { label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div className="opt">
      <div className="opt-label">{label}{hint && <small>{hint}</small>}</div>
      <div className="opt-ctl">{children}</div>
    </div>
  );
}

/** Read every account's usage once: quota files for Claude/Codex, the vendor probe for Muse. */
function refreshAllUsage(profiles: { cliId: CliId; slug: string }[]): Promise<unknown> {
  const meters = useAgentMeters.getState();
  return Promise.all([
    ...profiles
      .filter((profile) => QUOTA_CLIS.includes(profile.cliId))
      .map((profile) => meters.refreshProfile({ cliId: profile.cliId, slug: profile.slug })),
    // Muse usage is CLI-global. Claude rows probe their selected profile's
    // config dir independently.
    ...AGENT_CLIS.filter((cliId) => PROBED_CLIS.includes(cliId) && cliId !== "claude").map(probeOnce),
  ]);
}

/** Per-CLI account management on top of the profiles store (spec Accounts). */
function AgentAccounts() {
  const profiles = useProfiles((s) => s.profiles);
  const cliDefaults = useProfiles((s) => s.cliDefaults);
  const store = useProfiles.getState();
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [addMenuAt, setAddMenuAt] = useState<{ x: number; y: number } | null>(null);
  const closeAddMenu = useCallback(() => setAddMenuAt(null), []);
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
  // On open (and when the account list changes): one read per account, no polling.
  const accountKeys = profiles.map(usageKey).join("|");
  useEffect(() => {
    void refreshAllUsage(useProfiles.getState().profiles);
  }, [accountKeys]);
  const connected = AGENT_CLIS.filter((cliId) => profiles.some((p) => p.cliId === cliId));
  const unconnected = AGENT_CLIS.filter((cliId) => !connected.includes(cliId));
  return (
    <div className="card agent-accts">
      <div className="acct-toolbar">
        {checking.size > 0 && (
          <span className="settings-account-loading" role="status">
            <span className="spin" aria-hidden="true" />
            {t("settings.checkingAccounts", { count: checking.size })}
          </span>
        )}
        <span className="grow" />
        <BusyButton size="sm" variant="ghost" onExecute={() => refreshAllUsage(profiles)}>
          <span aria-hidden="true">↻</span> {t("settings.checkAllUsage")}
        </BusyButton>
        <Button
          size="sm"
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setAddMenuAt({ x: rect.right - 220, y: rect.bottom + 4 });
          }}
        >
          {t("settings.addAccount")}
        </Button>
      </div>
      {addMenuAt && (
        <Menu
          x={addMenuAt.x}
          y={addMenuAt.y}
          width={220}
          onClose={closeAddMenu}
          items={AGENT_CLIS.map((cliId) => ({
            kind: "item" as const,
            label: CLI_REGISTRY[cliId].name,
            onSelect: () => void addProfile(cliId),
          }))}
        />
      )}
      {connected.map((cliId) => {
        const def = CLI_REGISTRY[cliId];
        return (
          <div key={cliId} className="agent-acct-cli">
            <div className="acct-prov-h">
              <CliIcon id={cliId} />
              <h4>{def.name}</h4>
              {(cliId === "copilot" || cliId === "muse") && (
                <small>
                  {cliId === "copilot" ? t("settings.copilotSharedCredentials") : t("settings.museSharedCredentials")}
                </small>
              )}
            </div>
            {profiles
              .filter((p) => p.cliId === cliId)
              .map((profile) => (
                <AccountRow
                  key={profile.slug}
                  cliId={cliId}
                  profile={profile}
                  isDefault={cliDefaults[cliId]?.slug === profile.slug}
                  onCheckingChange={onCheckingChange}
                />
              ))}
          </div>
        );
      })}
      {unconnected.length > 0 && (
        <div className="acct-unconnected" role="group" aria-label={t("settings.notConnected")}>
          <span>{t("settings.notConnected")}</span>
          {unconnected.map((cliId) => (
            <BusyButton
              key={cliId}
              size="sm"
              variant="ghost"
              aria-label={t("settings.addCliAccount", { name: CLI_REGISTRY[cliId].name })}
              onExecute={() => addProfile(cliId)}
            >
              <CliIcon id={cliId} /> {CLI_REGISTRY[cliId].name}
            </BusyButton>
          ))}
        </div>
      )}
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

type SettingsTab = "general" | "agents" | "accounts" | "github";
const SETTINGS_TABS: SettingsTab[] = ["general", "agents", "accounts", "github"];

export function SettingsView() {
  const [tab, setTab] = useState<SettingsTab>("general");
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
      <div className="settings-tabs" role="tablist" aria-label={t("settings.tabs")}>
        {SETTINGS_TABS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`settings-tab-${value}`}
            className="tab"
            aria-selected={tab === value}
            aria-controls="settings-tabpanel"
            onClick={() => setTab(value)}
          >
            {t(`settings.tab.${value}`)}
          </button>
        ))}
      </div>
      <div className="settings-body" role="tabpanel" id="settings-tabpanel" aria-labelledby={`settings-tab-${tab}`}>
        {tab === "general" && (
          <>
            <section className="panel">
              <div className="section-h"><h3>{t("settings.appearance")}</h3></div>
              <Row label={t("settings.theme")} hint={t("settings.themeHint")}>
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
              <Row label={t("settings.textSize")} hint={t("settings.textSizeHint")}>
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
              <Row label={t("settings.density")} hint={t("settings.densityHint")}>
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
            </section>

            <section className="panel">
              <div className="section-h"><h3>{t("settings.keyboard")}</h3></div>
              <Row label={t("settings.singleKeyShortcuts")} hint={t("settings.singleKeyShortcutsHint")}>
                <Switch label={t("settings.singleKeyShortcuts")} checked={singleKeyShortcuts} onChange={setSingleKeyShortcuts} />
              </Row>
              <Row label={t("settings.terminalShortcut")} hint={t("settings.terminalShortcutHint")}><kbd className="kbd">Ctrl+`</kbd></Row>
            </section>
          </>
        )}

        {tab === "agents" && (
          <section className="panel">
            <div className="section-h"><h3>{t("settings.agents")}</h3></div>
            <Row label={t("settings.autoSwitch")}>
              <Switch
                label={t("settings.autoSwitch")}
                checked={agentAutoSwitch}
                onChange={(on) => setAgentAutoSwitch(on)}
              />
            </Row>
            <Row label={t("settings.tokenSaver")} hint={t("settings.tokenSaverHint")}>
              <Switch
                label={t("settings.tokenSaver")}
                checked={agentTokenSaver}
                onChange={(on) => setAgentTokenSaver(on)}
              />
            </Row>
            <Row label={t("settings.saverProtected")}>
              <SaverProtectedInput />
            </Row>
          </section>
        )}

        {tab === "accounts" && (
          <section className="panel">
            <div className="section-h"><h3>{t("settings.agentAccounts")}</h3></div>
            <AgentAccounts />
          </section>
        )}

        {tab === "github" && (
          <section className="panel">
            <div className="section-h"><h3>{t("settings.githubAccounts")}</h3></div>
            <GithubAccounts />
          </section>
        )}
      </div>
    </div>
  );
}
