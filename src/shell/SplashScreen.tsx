import { useEffect, useState } from "react";
import { t } from "../i18n/t";
import "./splash.css";

const MIN_MS = 800;
const FADE_MS = 320;

/** Launch splash: logo + app name while settings load, then a subtle fade out. */
export function SplashScreen() {
  const [visible, setVisible] = useState(true);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setLeaving(true), MIN_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setVisible(false), FADE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  if (!visible) return null;
  return (
    <div className={"splash" + (leaving ? " splash-leaving" : "")} role="status" aria-label={t("app.name")}>
      <span className="splash-mark" aria-hidden="true" />
      <span className="splash-name">{t("app.name")}</span>
      <span className="splash-bar" aria-hidden="true">
        <span className="splash-bar-fill" />
      </span>
    </div>
  );
}
