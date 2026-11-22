import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/t";
import { CLI_REGISTRY, type CliId } from "../../agents/registry";
import { useProfiles, usageKey, type AgentProfile } from "../../agents/profiles";
import { PROBED_CLIS } from "../../agents/probe";
import {
  QUOTA_CLIS,
  effectivePercent,
  formatAgo,
  formatReset,
  headlineWindows,
  useAgentMeters,
  windowExpired,
  windowLabel,
} from "../../agents/quota";
import { UsageBar } from "../../agents/usage";
import type { QuotaWindow } from "../../ipc/bindings";
import { profileHasCredentials } from "../../ipc/cli";
import { Button } from "../../ui/Button";
import { BusyButton } from "../../ui/BusyButton";
import { Menu, type MenuItem } from "../../ui/Menu";
import { ask } from "../../ui/dialog";
import { probeOnce } from "./accountProbe";

/** One usage line: label, percent, bar and (optionally) its reset text. */
function Meter({ label, percent, reset }: { label: string; percent: number; reset?: string }) {
  return (
    <div className="acct-meter">
      <span className="acct-meter-label" title={label}>{label}</span>
      <span className="acct-meter-pct">{`${percent}%`}</span>
      <UsageBar usage={{ window: label, percent }} className="acct-meter-bar" />
      {reset && <span className="acct-meter-reset">{reset}</span>}
    </div>
  );
}

function windowMeter(window: QuotaWindow, now: number, withReset: boolean) {
  const expired = windowExpired(window, now);
  const reset = !withReset
    ? undefined
    : expired
      ? t("usage.resetShort")
      : window.resetsAtMs != null
        ? t("usage.resetsIn", { reset: formatReset(window.resetsAtMs, now) })
        : t("usage.resetUnknown");
  return (
    <Meter
      key={`${window.minutes}-${window.scope ?? ""}`}
      label={windowLabel(window)}
      percent={effectivePercent(window, now)}
      reset={reset}
    />
  );
}

/** Same order the pane header uses: shorter windows first, model-wide before scoped. */
function orderedWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return [...windows].sort(
    (a, b) => a.minutes - b.minutes || Number(a.scope != null) - Number(b.scope != null),
  );
}

/**
 * One connected agent account: identity, headline usage meters, login
 * status, an expandable list of every quota window and a ⋯ action menu.
 * Linked state comes from a credential-file check (providers with
 * per-profile credentials) or a vendor probe (claude/muse) — otherwise it
 * stays unknown. Log out exists only where profile-dir credentials can
 * actually be deleted (spec §6.6.4), so a row never looks connected when it
 * is not.
 */
export function AccountRow({
  cliId,
  profile,
  isDefault,
  onCheckingChange,
}: {
  cliId: CliId;
  profile: AgentProfile;
  isDefault: boolean;
  onCheckingChange: (key: string, checking: boolean) => void;
}) {
  const def = CLI_REGISTRY[cliId];
  const { slug, name } = profile;
  const store = useProfiles.getState();
  const ref = { cliId, slug };
  const key = usageKey(ref);
  const pending = useProfiles((s) => s.loginPending[key] != null);
  const observedProbe = useProfiles((s) => (cliId === "claude" ? s.profileProbes[key] : s.cliProbes[cliId]));
  const museUsage = useProfiles((s) => (cliId === "muse" ? s.usage[key] : undefined));
  const quota = useAgentMeters((s) => s.quotas[key]);
  const identity = observedProbe?.identity ?? null;
  const verifiable = def.credentialPaths.length > 0 || PROBED_CLIS.includes(cliId);
  const [expanded, setExpanded] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenuAt(null), []);
  // null = still checking: render no Log out affordance at all until the
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
  // the row flips to Sign in again without requiring a reload.
  const logout = async () => {
    const removed = await store.logoutProfile(ref);
    if (removed !== null) check();
  };
  const rename = async () => {
    const nextName = await ask({
      title: t("settings.editProfileTitle", { name }),
      body: t("settings.editProfileBody"),
      input: name,
      ok: t("settings.editProfileOk"),
      icon: "✎",
    });
    if (typeof nextName === "string") store.renameProfile(ref, nextName);
  };
  const menuItems: MenuItem[] = [
    isDefault
      ? { kind: "item", label: t("settings.clearDefault"), onSelect: () => store.setCliDefault(cliId, null) }
      : { kind: "item", label: t("settings.setDefault"), onSelect: () => store.setCliDefault(cliId, ref) },
    { kind: "item", label: t("settings.renameAccount"), onSelect: () => void rename() },
    // Logout only deletes profile-dir credentials. Probe-based providers
    // have no verified credential file to remove.
    ...(linked === true && !pending && def.credentialPaths.length > 0
      ? [{ kind: "item" as const, label: t("agents.logoutOk"), onSelect: () => void logout() }]
      : []),
    { kind: "separator" },
    { kind: "item", label: t("settings.removeAccount"), danger: true, onSelect: () => void remove() },
  ];

  const now = Date.now();
  const windows = quota?.kind === "ok" ? quota.windows : [];
  let meters;
  if (QUOTA_CLIS.includes(cliId)) {
    meters =
      quota?.kind === "ok" && windows.length > 0 ? (
        headlineWindows(windows, now).map((window) => windowMeter(window, now, false))
      ) : (
        <span className="acct-nousage">
          {!quota || quota.kind === "loading"
            ? t("usage.loading")
            : quota.kind === "unavailable"
              ? t("usage.unavailable")
              : quota.kind === "unsupported"
                ? t("usage.unsupportedHelp", { name: def.name })
                : t("usage.none")}
        </span>
      );
  } else if (cliId === "muse") {
    meters = museUsage ? (
      <Meter label={t("settings.planLimit")} percent={museUsage.percent} reset={museUsage.window} />
    ) : (
      <span className="acct-nousage">{t("usage.none")}</span>
    );
  } else {
    meters = <span className="acct-nousage">{t("usage.unsupportedHelp", { name: def.name })}</span>;
  }

  return (
    <div className="acct-row" role="group" aria-label={name}>
      <div className="acct-main">
        <div className="acct-who">
          <b>
            {name} {isDefault && <span className="chip cg">{t("settings.isDefault")}</span>}
          </b>
          <small className={identity ? undefined : "mono"}>
            {identity ?? `~/.branchwork/profiles/${cliId}-${slug}`}
          </small>
        </div>
        <div className={quota?.kind === "ok" && quota.stale ? "acct-meters stale" : "acct-meters"}>
          {meters}
          {quota?.kind === "ok" && quota.stale && (
            <span className="acct-stale-mark" role="img" title={t("usage.stale")} aria-label={t("usage.stale")}>
              ⚠
            </span>
          )}
        </div>
        <div className="acct-actions">
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
          ) : (
            <span className="agent-acct-check" role="status" aria-label={t("settings.checkingLogin")}>
              <span className="spin" aria-hidden="true" />
            </span>
          )}
          {linked !== null && linked !== true && (
            <BusyButton size="sm" onExecute={() => store.loginProfile(ref)}>
              {t("settings.signInAgain")}
            </BusyButton>
          )}
          {windows.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="acct-toggle"
              aria-expanded={expanded}
              aria-label={expanded ? t("settings.hideUsage") : t("settings.showUsage")}
              title={expanded ? t("settings.hideUsage") : t("settings.showUsage")}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? "▴" : "▾"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-haspopup="menu"
            aria-label={t("settings.accountMenu", { name })}
            title={t("settings.accountMenu", { name })}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenuAt({ x: rect.right - 200, y: rect.bottom + 4 });
            }}
          >
            ⋯
          </Button>
        </div>
      </div>
      {expanded && quota?.kind === "ok" && windows.length > 0 && (
        <div className="acct-detail">
          <div className="acct-detail-windows">
            {orderedWindows(windows).map((window) => windowMeter(window, now, true))}
          </div>
          <div className="acct-detail-foot">
            <span>
              {quota.fetchedAtMs != null
                ? t("usage.updated", { ago: formatAgo(quota.fetchedAtMs, now) })
                : t("usage.updatedUnknown")}
            </span>
            {quota.stale && <span className="acct-stale">{t("usage.stale")}</span>}
            <BusyButton size="sm" variant="ghost" onExecute={() => useAgentMeters.getState().refreshProfile(ref)}>
              <span aria-hidden="true">↻</span> {t("settings.checkUsage")}
            </BusyButton>
          </div>
        </div>
      )}
      {menuAt && <Menu x={menuAt.x} y={menuAt.y} width={200} items={menuItems} onClose={closeMenu} />}
    </div>
  );
}
