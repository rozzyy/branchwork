// GitHub account management in Settings (M4 Task 03, spec §6.7).
// Multi-account: device flow and PAT add usernames to the index; only
// usernames (never tokens, codes, or URIs) reach toasts or settings.
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { useGithubAccounts } from "../../github/store";
import {
  githubAuthStatus,
  openGithubUrl,
  pollGithubDeviceFlow,
  signOutGithub,
  startGithubDeviceFlow,
  verifyGithubPat,
  type DevicePoll,
} from "../../ipc/github";
import { errorMessage } from "../../ipc/errors";
import { Button } from "../../ui/Button";
import { BusyButton } from "../../ui/BusyButton";
import { toast } from "../../ui/toast";
import { ask } from "../../ui/dialog";

/** Verified state of one account row: null = checking. */
type RowState = boolean | null | "unknown";

function GithubAccountRow({
  account,
  isDefault,
}: {
  account: string;
  isDefault: boolean;
}) {
  const store = useGithubAccounts.getState();
  const [linked, setLinked] = useState<RowState>(null);

  const check = useCallback(() => {
    let live = true;
    setLinked(null);
    void githubAuthStatus(account)
      .then((status) => {
        if (!live) return;
        if (status.linked) setLinked(true);
        else store.removeAccount(account); // stale index entry: prune silently
      })
      .catch(() => {
        if (live) setLinked("unknown");
      });
    return () => {
      live = false;
    };
  }, [account, store]);

  useEffect(() => check(), [check]);

  const signOut = async () => {
    const confirmed = await ask({
      title: t("agents.logoutTitle", { name: "GitHub", profile: account }),
      body: t("agents.logoutBody"),
      ok: t("agents.logoutOk"),
      danger: true,
      icon: "◔",
    });
    if (confirmed !== true) return;
    // Prune only when the backend confirms (stored or already absent):
    // on backend errors the token may still exist, so keep the row.
    try {
      await signOutGithub(account);
    } catch (error) {
      toast({ title: errorMessage(error), icon: "⚠" });
      return;
    }
    store.removeAccount(account);
    toast({ title: t("agents.loggedOut", { name: "GitHub", profile: account }), icon: "◔" });
  };

  return (
    <div className="opt agent-acct-row">
      <div className="opt-label">
        <b>
          {account}{" "}
          {isDefault && <span className="chip cg">{t("settings.isDefault")}</span>}
        </b>
        <small className="mono agent-acct-path">github.com/{account}</small>
      </div>
      <div className="opt-ctl">
        <Button
          size="sm"
          variant="ghost"
          title={isDefault ? t("settings.clearDefault") : t("settings.setDefault")}
          onClick={() => store.setDefault(isDefault ? null : account)}
        >
          {isDefault ? `✓ ${t("settings.isDefault")}` : t("settings.setDefault")}
        </Button>
        {linked === true ? (
          <span className="chip cg">✓ {t("settings.loggedIn")}</span>
        ) : linked === "unknown" ? (
          <span className="agent-acct-status">{t("settings.loginStatusUnknown")}</span>
        ) : (
          <span className="agent-acct-check" role="status" aria-label={t("settings.checkingLogin")}>
            <span className="spin" aria-hidden="true" />
          </span>
        )}
        {linked === "unknown" && (
          <Button size="sm" onClick={() => check()}>
            {t("settings.retry")}
          </Button>
        )}
        {linked === true && (
          <Button size="sm" variant="danger" onClick={() => void signOut()}>
            {t("agents.logoutOk")}
          </Button>
        )}
      </div>
    </div>
  );
}

interface FlowState {
  requestId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

function errorForPoll(poll: DevicePoll): string | null {
  if (poll.state === "expired") return t("settings.githubExpired");
  if (poll.state === "denied") return t("settings.githubDenied");
  return null;
}

/** Device-flow sign-in box: start → code + URI → interval polling. */
function DeviceFlowBox() {
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [starting, setStarting] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(
    () => () => {
      cancelled.current = true;
      clearTimer();
    },
    [],
  );

  const pollOnce = useCallback((requestId: string, intervalSecs: number) => {
    timer.current = setTimeout(() => {
      if (cancelled.current) return;
      void pollGithubDeviceFlow(requestId)
        .then((poll) => {
          if (cancelled.current) return;
          if (poll.state === "authorized" && poll.username) {
            useGithubAccounts.getState().addAccount(poll.username);
            toast({
              title: t("agents.loginDetected", { name: "GitHub", profile: poll.username }),
              icon: "◔",
            });
            setFlow(null);
            return;
          }
          const message = errorForPoll(poll);
          if (message) {
            setFlowError(message);
            return;
          }
          pollOnce(requestId, poll.interval);
        })
        .catch((error: unknown) => {
          if (!cancelled.current) setFlowError(errorMessage(error));
        });
    }, Math.max(1, intervalSecs) * 1000);
  }, []);

  const openBrowser = useCallback((uri: string) => {
    // The URI stays on screen as the manual fallback: a blocked popup or a
    // headless session must never strand the flow.
    void openGithubUrl(uri).catch((error: unknown) => {
      if (!cancelled.current) setFlowError(errorMessage(error));
    });
  }, []);

  const start = async () => {
    setStarting(true);
    setFlowError(null);
    try {
      const started = await startGithubDeviceFlow();
      cancelled.current = false;
      setFlow(started);
      openBrowser(started.verificationUri);
      pollOnce(started.requestId, started.interval);
    } catch (error) {
      setFlowError(errorMessage(error));
    } finally {
      setStarting(false);
    }
  };

  const cancel = () => {
    cancelled.current = true;
    clearTimer();
    setFlow(null);
    setFlowError(null);
    // The backend PENDING entry is intentionally left to expire on its own:
    // there is no cancel command, and the entry holds no usable credential.
  };

  if (!flow) {
    return (
      <div className="opt">
        <div className="opt-label">
          <b>{t("settings.githubDeviceTitle")}</b>
        </div>
        <div className="opt-ctl">
          {flowError && <span className="agent-acct-status">{flowError}</span>}
          <BusyButton size="sm" onExecute={start} disabled={starting}>
            {t("settings.githubSignIn")}
          </BusyButton>
        </div>
      </div>
    );
  }

  return (
    <div className="opt">
      <div className="opt-label">
        <b>{t("settings.githubDeviceTitle")}</b>
        <small className="mono agent-acct-path">{t("settings.githubDeviceBody", { uri: flow.verificationUri })}</small>
      </div>
      <div className="opt-ctl">
        <code className="mono">{flow.userCode}</code>
        {flowError ? (
          <span className="agent-acct-status">{flowError}</span>
        ) : (
          <span className="agent-acct-status" role="status">
            <span className="spin" aria-hidden="true" /> {t("settings.waitingLogin")}
          </span>
        )}
        <Button size="sm" onClick={() => openBrowser(flow.verificationUri)}>
          {t("settings.githubOpenBrowser")}
        </Button>
        <Button size="sm" variant="ghost" onClick={cancel}>
          {t("settings.githubDeviceCancel")}
        </Button>
      </div>
    </div>
  );
}

/** PAT entry: password field, verified before anything is stored. */
function PatBox() {
  const [token, setToken] = useState("");
  const [patError, setPatError] = useState<string | null>(null);

  const submit = async () => {
    setPatError(null);
    try {
      const username = await verifyGithubPat(token);
      useGithubAccounts.getState().addAccount(username);
      toast({
        title: t("agents.loginDetected", { name: "GitHub", profile: username }),
        icon: "◔",
      });
      setToken("");
    } catch (error) {
      setPatError(errorMessage(error));
    }
  };

  return (
    <div className="opt">
      <div className="opt-label">
        <b>{t("settings.githubPatLabel")}</b>
      </div>
      <div className="opt-ctl">
        {patError && <span className="agent-acct-status">{patError}</span>}
        <input
          type="password"
          className="input"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t("settings.githubPatPlaceholder")}
          aria-label={t("settings.githubPatLabel")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && token.trim()) void submit();
          }}
        />
        <BusyButton size="sm" onExecute={submit} disabled={!token.trim()}>
          {t("settings.githubPatAdd")}
        </BusyButton>
      </div>
    </div>
  );
}

export function GithubAccounts() {
  const accounts = useGithubAccounts((s) => s.accounts);
  const defaultAccount = useGithubAccounts((s) => s.defaultAccount);
  const loaded = useGithubAccounts((s) => s.loaded);
  const store = useGithubAccounts.getState();

  useEffect(() => {
    if (!loaded) void store.load();
  }, [loaded, store]);

  return (
    <div className="card agent-accts">
      {accounts.map((account) => (
        <GithubAccountRow
          key={account}
          account={account}
          isDefault={defaultAccount === account}
        />
      ))}
      <DeviceFlowBox />
      <PatBox />
    </div>
  );
}
