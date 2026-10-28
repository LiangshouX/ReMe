import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusRpc } from "../../client/status-page.js";
import { safeError } from "../../endpoint.js";
import type { ServiceStartResult, ServiceState } from "../types.js";
import { fill, type EnvKey, type EnvTranslator } from "./locales.js";
import { StatusBadge } from "./presentation.js";
import {
  envCall,
  parseHealth,
  parseServiceLog,
  parseServiceStart,
  parseServiceState,
  parseServiceStop,
} from "./rpc.js";

/**
 * How long a detached start may take to answer `/health_check`. Kept at the
 * Host's start grace period, so the client never gives up while the Host still
 * considers the launch in flight.
 */
const START_DEADLINE_MS = 120_000;

/** Host start errors carry a stable code; older/unknown codes fall back. */
const START_ERROR_KEYS: Record<string, EnvKey> = {
  "other-endpoint-starting": "startErrorOtherEndpoint",
  conflict: "startErrorConflict",
  "other-endpoint-running": "startErrorOtherEndpointRunning",
  "previous-not-stopped": "startErrorPreviousNotStopped",
  "no-python": "startErrorNoPython",
  "not-installed": "startErrorNotInstalled",
  "version-too-old": "startErrorVersionTooOld",
  "start-failed": "startErrorFailed",
};

function startErrorText(t: EnvTranslator, result: ServiceStartResult): string {
  const key = result.code ? START_ERROR_KEYS[result.code] : undefined;
  return key ? t(key) : result.error || t("serviceError");
}

const STOP_REASON_KEYS: Record<string, EnvKey> = {
  "no-record": "stopNoRecord",
  foreign: "stopForeign",
  unverified: "stopUnknownIdentity",
  "not-exited": "stopNotExited",
};

function stopReasonText(
  t: EnvTranslator,
  result: { code?: string; reason?: string },
): string {
  const key = result.code ? STOP_REASON_KEYS[result.code] : undefined;
  return key ? t(key) : result.reason || t("serviceError");
}

export interface ServiceViewState {
  phase: "checking" | "running" | "starting" | "stopped" | "conflict" | "error";
  data?: ServiceState;
  error?: string;
}

export interface ServiceLogView {
  open: boolean;
  lines: string;
  logPath: string;
}

export interface ServiceControl {
  state: ServiceViewState;
  stopping: boolean;
  /** Why the last Stop request left the service alone, if it did. */
  stopError: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(): void;
  log: ServiceLogView;
  viewLog(): Promise<void>;
  dismissLog(): void;
}

/**
 * The service section's asynchronous state, keyed by endpoint: one status read
 * per endpoint, plus the start and stop operations for the managed instance.
 */
export function useService(
  rpc: StatusRpc,
  options: {
    t: EnvTranslator;
    endpoint: string;
    /** Only a loopback endpoint can be managed, so remote ones are read-only. */
    local: boolean;
    pythonPath: string;
    workspaceDir: string;
    authToken: string;
  },
): ServiceControl {
  const { t, endpoint, local, pythonPath, workspaceDir, authToken } = options;
  const [state, setState] = useState<ServiceViewState>({ phase: "checking" });
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState("");
  const [tick, setTick] = useState(0);
  const [log, setLog] = useState<ServiceLogView>({
    open: false,
    lines: "",
    logPath: "",
  });
  const startController = useRef<AbortController | undefined>(undefined);

  // A new endpoint has no known phase yet; keeping the previous endpoint's
  // "running + old pid/version" on screen would mislabel the new one. A start
  // poll for the old endpoint must stop before it can paint that old data.
  useEffect(() => {
    startController.current?.abort();
    // Resetting the view when the endpoint prop changes is intentional; the
    // hook has no key, so this is the reset path.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ phase: "checking" });
    setStopError("");
  }, [endpoint]);

  useEffect(() => () => startController.current?.abort(), []);

  useEffect(() => {
    if (!local || !endpoint) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const next = parseServiceState(
          await envCall(
            rpc,
            "serviceStatus",
            { endpoint, authToken },
            controller.signal,
          ),
        );
        if (controller.signal.aborted) return;
        // Recheck must not be swallowed while a start is in flight: the
        // response belongs to the endpoint on screen. `stopped` with a live pid
        // is the Host's "launch still booting" signal.
        setState({
          phase:
            next.phase === "stopped" && next.pid !== undefined
              ? "starting"
              : next.phase,
          data: next,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({ phase: "error", error: safeError(error) });
      }
    })();
    return () => controller.abort();
  }, [rpc, endpoint, local, authToken, tick]);

  const refresh = useCallback(() => setTick((current) => current + 1), []);

  const start = useCallback(async () => {
    if (!pythonPath || state.phase === "starting") return;
    startController.current?.abort();
    const controller = new AbortController();
    startController.current = controller;
    setState({ phase: "starting" });
    setStopError("");
    setLog({ open: false, lines: "", logPath: "" });
    try {
      const started = parseServiceStart(
        await envCall(
          rpc,
          "serviceStart",
          { endpoint, pythonPath, workspaceDir, authToken },
          controller.signal,
        ),
      );
      if (controller.signal.aborted) return;
      if (started.error) {
        setState({ phase: "error", error: startErrorText(t, started) });
        return;
      }
      const deadline = Date.now() + START_DEADLINE_MS;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (controller.signal.aborted) return;
        if (Date.now() > deadline) {
          setState({ phase: "error", error: t("startTimeout") });
          return;
        }
        try {
          const status = parseServiceState(
            await envCall(
              rpc,
              "serviceStatus",
              { endpoint, authToken },
              controller.signal,
            ),
          );
          if (controller.signal.aborted) return;
          if (status.phase === "running") {
            setState({ phase: "running", data: status });
            return;
          }
          if (status.phase === "conflict") {
            // Someone (possibly our own booting service) owns the port.
            setState({ phase: "conflict", data: status });
            return;
          }
          if (status.phase === "stopped" && status.pid === undefined) {
            // The Host already dropped the start marker: the launch died before
            // it ever listened, so waiting out the 120 s deadline is wrong.
            setState({ phase: "error", error: t("startFailedStopped") });
            return;
          }
          // stopped with a live pid: the process is still booting.
        } catch {
          // Keep polling: a starting service answers once it is listening.
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({ phase: "error", error: safeError(error) });
    }
  }, [authToken, endpoint, pythonPath, rpc, state.phase, t, workspaceDir]);

  const stop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    try {
      const result = parseServiceStop(
        await envCall(rpc, "serviceStop", { endpoint }),
      );
      setStopError(result.stopped ? "" : stopReasonText(t, result));
      refresh();
    } catch (error) {
      setState({ phase: "error", error: safeError(error) });
    } finally {
      setStopping(false);
    }
  }, [endpoint, refresh, rpc, stopping, t]);

  const viewLog = useCallback(async () => {
    try {
      const value = parseServiceLog(
        await envCall(rpc, "serviceLog", { workspaceDir }),
      );
      setLog({ open: true, lines: value.lines, logPath: value.logPath });
    } catch {
      // Log viewing is diagnostic only.
    }
  }, [rpc, workspaceDir]);

  const dismissLog = useCallback(
    () => setLog({ open: false, lines: "", logPath: "" }),
    [],
  );

  return {
    state,
    stopping,
    stopError,
    start,
    stop,
    refresh,
    log,
    viewLog,
    dismissLog,
  };
}

export interface ConnectionState {
  phase: "loading" | "ok" | "fail";
  endpoint: string;
  version?: string;
  error?: string;
}

/**
 * Health of a ReMe service that this plugin cannot manage locally (a remote
 * URL), so the hero still reports whether the configured endpoint answers.
 */
export function useHealth(options: {
  rpc: StatusRpc;
  endpoint: string;
  enabled: boolean;
  tick: number;
  authToken: string;
}): ConnectionState {
  const { rpc, endpoint, enabled, tick, authToken } = options;
  const [health, setHealth] = useState<ConnectionState>({
    phase: "loading",
    endpoint: "",
  });

  useEffect(() => {
    if (!enabled || !endpoint) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const result = parseHealth(
          await envCall(
            rpc,
            "health",
            { endpoint, authToken },
            controller.signal,
          ),
        );
        if (controller.signal.aborted) return;
        setHealth(
          result.ok
            ? { phase: "ok", endpoint, version: result.version }
            : { phase: "fail", endpoint, error: result.error },
        );
      } catch (error) {
        if (!controller.signal.aborted)
          setHealth({ phase: "fail", endpoint, error: safeError(error) });
      }
    })();
    return () => controller.abort();
  }, [authToken, endpoint, enabled, rpc, tick]);

  return health;
}

/** Step 4: the local ReMe service that DSH talks to. */
export function ServiceSection({
  t,
  endpoint,
  pythonPath,
  control,
  remeInstalled,
  autoStart,
  writable,
  current,
  onAutoStart,
}: {
  t: EnvTranslator;
  endpoint: string;
  pythonPath: string;
  control: ServiceControl;
  remeInstalled: boolean;
  autoStart: boolean;
  writable: boolean;
  /** False while the state on screen belongs to another endpoint. */
  current: boolean;
  onAutoStart(checked: boolean): void;
}): JSX.Element {
  const { state, stopping, stopError, log } = control;
  const [confirming, setConfirming] = useState(false);
  // A conflict can still be our own unhealthy service (booting, wrong token);
  // offer the same Stop affordance instead of leaving the tab without a way
  // out other than editing the record by hand.
  const canStop =
    current &&
    (state.phase === "running" ||
      (state.phase === "conflict" && state.data?.managed === true));

  return (
    <section className="reme-env-card">
      <header>
        <span className="reme-env-step" aria-hidden="true">
          4
        </span>
        <div>
          <h4>{t("controlTitle")}</h4>
          <p>{t("serviceHint")}</p>
        </div>
        <aside>
          {!current ||
          state.phase === "checking" ||
          state.phase === "starting" ? (
            <StatusBadge tone="progress">
              {t(
                !current
                  ? "checking"
                  : state.phase === "starting"
                  ? "serviceBadgeStarting"
                  : "checking",
              )}
            </StatusBadge>
          ) : state.phase === "running" ? (
            <StatusBadge tone="ok">
              {state.data?.version
                ? `ReMe ${state.data.version}`
                : t("serviceRunning")}
            </StatusBadge>
          ) : state.phase === "conflict" ? (
            <StatusBadge tone="progress">
              {t(
                state.data?.managed
                  ? "serviceBadgeUnhealthy"
                  : "serviceBadgeConflict",
              )}
            </StatusBadge>
          ) : (
            <StatusBadge tone="bad">{t("serviceBadgeStopped")}</StatusBadge>
          )}
        </aside>
      </header>
      <div className="reme-env-card-body">
        <div className="reme-env-factrow">
          <span className="reme-env-field-label">{t("endpointLabel")}</span>
          <code className="reme-env-path" title={endpoint}>
            {endpoint}
          </code>
          <button
            type="button"
            className="reme-settings-button"
            onClick={control.refresh}
          >
            {t("recheck")}
          </button>
        </div>
        {current &&
        (state.phase === "running" || state.phase === "conflict") ? (
          <p className="reme-settings-muted">
            {state.data?.managed
              ? fill(t("managedNote"), { pid: state.data?.pid ?? "" })
              : state.phase === "running"
              ? t("foreignNote")
              : null}
          </p>
        ) : null}
        {current && state.phase === "conflict" ? (
          <p className="reme-settings-muted">
            {state.data?.managed ? t("conflictManagedNote") : t("conflictNote")}
          </p>
        ) : null}
        {state.phase === "error" && state.error ? (
          <p className="reme-settings-error">
            {`${t("serviceError")}: ${state.error}`}
          </p>
        ) : null}
        {stopError ? (
          <p className="reme-settings-error" role="alert">
            {stopError}
          </p>
        ) : null}
        <div className="reme-env-cta">
          {canStop ? (
            confirming ? (
              <div className="reme-env-confirm">
                <p>{t("stopConfirm")}</p>
                <button
                  type="button"
                  className="reme-settings-save"
                  disabled={stopping}
                  onClick={() => {
                    setConfirming(false);
                    void control.stop();
                  }}
                >
                  {t("stopService")}
                </button>
                <button
                  type="button"
                  className="reme-settings-discard"
                  onClick={() => setConfirming(false)}
                >
                  {t("cancel")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="reme-settings-button"
                disabled={stopping || !state.data?.managed}
                onClick={() => setConfirming(true)}
              >
                {t("stopService")}
              </button>
            )
          ) : (
            <button
              type="button"
              className="reme-settings-save"
              disabled={
                !current ||
                state.phase === "starting" ||
                state.phase === "conflict" ||
                !remeInstalled ||
                !pythonPath
              }
              onClick={() => void control.start()}
            >
              {t("startService")}
            </button>
          )}
          <button
            type="button"
            className="reme-settings-button"
            onClick={() => void control.viewLog()}
          >
            {t("viewLogs")}
          </button>
          <label className="reme-settings-check reme-env-autostart">
            <input
              type="checkbox"
              checked={autoStart}
              disabled={!writable}
              onChange={(event) => {
                if (!writable) return;
                onAutoStart(event.target.checked);
              }}
            />
            <span>{t("autoStartLabel")}</span>
          </label>
        </div>
        {log.open ? (
          <div className="reme-env-result">
            <p className="reme-settings-muted">
              {`${t("envPath")}: ${log.logPath}`}
            </p>
            <pre className="reme-env-log">{log.lines || t("logEmpty")}</pre>
            <button
              type="button"
              className="reme-settings-button"
              onClick={control.dismissLog}
            >
              {t("dismiss")}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
