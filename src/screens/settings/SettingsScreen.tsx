import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { useSettings } from "../../state/settings";
import { CLI_IDS, CLI_REGISTRY, type CliId } from "../../agents/registry";
import { CliIcon } from "../../agents/cliIcons";
import { useProfiles } from "../../agents/profiles";
import { Segmented, Switch } from "../../ui/controls";
import { Button } from "../../ui/Button";
import { toast } from "../../ui/toast";
import { ask } from "../../ui/dialog";
import type { Density, ThemeMode } from "../../theme/theme";

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

/** Per-CLI account management on top of the profiles store (spec Accounts). */
function AgentAccounts() {
  const profiles = useProfiles((s) => s.profiles);
  const cliDefaults = useProfiles((s) => s.cliDefaults);
  const store = useProfiles.getState();
  const agentClis = CLI_IDS.filter((id): id is Exclude<CliId, "custom"> => id !== "custom");
  return (
    <div className="card agent-accts">
      {agentClis.map((cliId) => {
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
                <Button size="sm" onClick={() => void store.addProfile(cliId)}>
                  {t("agents.addAccount")}
                </Button>
              </div>
            </div>
            {list.map((profile) => {
              const isDefault = cliDefaults[cliId]?.slug === profile.slug;
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
                    <Button
                      size="sm"
                      variant="ghost"
                      title={isDefault ? t("settings.clearDefault") : t("settings.setDefault")}
                      onClick={() =>
                        store.setCliDefault(cliId, isDefault ? null : { cliId, slug: profile.slug })
                      }
                    >
                      {isDefault ? `✓ ${t("settings.isDefault")}` : t("settings.setDefault")}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void store.logoutProfile({ cliId, slug: profile.slug })}
                    >
                      {t("agents.logoutOk")}
                    </Button>
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

export function SettingsView() {
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const agentAutoSwitch = useSettings((s) => s.agentAutoSwitch);
  const setAgentAutoSwitch = useSettings((s) => s.setAgentAutoSwitch);

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
        <Row label={t("settings.contrast")}>
          <input type="range" min={0.6} max={1.8} step={0.05} value={theme.contrast} aria-label={t("settings.contrast")} onChange={(e) => setTheme({ contrast: Number(e.target.value) })} />
        </Row>
        <Row label={t("settings.reduceTransparency")}>
          <Switch label={t("settings.reduceTransparency")} checked={theme.reduceTransparency} onChange={(reduceTransparency) => setTheme({ reduceTransparency })} />
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

      <h3>{t("settings.agents")}</h3>
      <div className="card">
        <Row label={t("settings.autoSwitch")}>
          <Switch
            label={t("settings.autoSwitch")}
            checked={agentAutoSwitch}
            onChange={(on) => setAgentAutoSwitch(on)}
          />
        </Row>
      </div>
      <h3>{t("settings.agentAccounts")}</h3>
      <AgentAccounts />

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
