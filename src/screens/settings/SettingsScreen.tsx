import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { useSettings } from "../../state/settings";
import { Segmented, Switch } from "../../ui/controls";
import { Button } from "../../ui/Button";
import { toast } from "../../ui/toast";
import { ask } from "../../ui/dialog";
import type { Density, ThemeMode } from "../../theme/theme";

const SWATCHES = [250, 300, 350, 25, 60, 155, 200];

export function SettingsToolbar() {
  return <h1 className="pane-title">{t("nav.settings")}</h1>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="opt">
      <div className="opt-label">{label}</div>
      <div className="opt-ctl">{children}</div>
    </div>
  );
}

export function SettingsView() {
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);

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
