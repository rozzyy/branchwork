import { LaunchpadToolbar, LaunchpadView } from "../launchpad/LaunchpadScreen";
import { InboxView } from "../inbox/InboxScreen";

/** Home = prototype composition: greeting + KPIs, the "Needs your attention"
 * panel (Inbox), then Issues for you / CI feed. */
export function HomeToolbar() {
  return <LaunchpadToolbar />;
}

export function HomeView() {
  return <LaunchpadView attention={<InboxView />} />;
}
