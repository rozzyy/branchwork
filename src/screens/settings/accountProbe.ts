import type { CliId } from "../../agents/registry";
import { useProfiles } from "../../agents/profiles";
import { parseClaudeAuth, parseMuseLoginStatus, parseMuseUsage } from "../../agents/probe";
import { probeCli } from "../../ipc/cli";

/** Outcome of one vendor probe round; null when the probe itself failed. */
export interface ProbeOutcome {
  linked: boolean;
  identity: string | null;
}

/**
 * Run the vendor probe and publish the result to the store (identity label,
 * muse usage bars). Failed probes leave the
 * store untouched — unknown stays unknown, never fabricated.
 */
export async function probeOnce(cliId: CliId): Promise<ProbeOutcome | null> {
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
      const linked = parseMuseLoginStatus(raw);
      if (linked === null) return null;
      store.setCliProbe(cliId, { linked, identity: null });
      return { linked, identity: null };
    }
    store.setCliProbe(cliId, { linked: true, identity: null });
    for (const profile of store.profiles.filter((item) => item.cliId === cliId)) {
      store.setProfileUsage({ cliId, slug: profile.slug }, usage);
    }
    return { linked: true, identity: null };
  }
  return null;
}
