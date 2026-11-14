import { t } from "../../i18n/t";
import { LaunchpadToolbar, LaunchpadView } from "../launchpad/LaunchpadScreen";
import { InboxToolbar, InboxView } from "../inbox/InboxScreen";

export function HomeToolbar() {
  return <LaunchpadToolbar />;
}

export function HomeView() {
  return <div className="home-screen"><section aria-label={t("inbox.title")}><InboxToolbar /><InboxView /></section><section aria-label={t("launchpad.summary", {projects: 0, worktrees: 0})}><LaunchpadView /></section></div>;
}
