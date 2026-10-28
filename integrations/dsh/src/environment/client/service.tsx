import { useCallback, useEffect, useState } from "react";
import type { StatusRpc } from "../../client/status-page.js";
import { safeError } from "../../endpoint.js";
import type { ServiceState } from "../types.js";
import type { EnvTranslator } from "./locales.js";
import { fill } from "./locales.js";
import { StatusBadge } from "./presentation.js";
import {
  envCall,
  parseHealth,
  parseServiceLog,
  parseServiceStart,
  parseServiceState,
} from "./rpc.js";

/** How long a detached start may take to answer `/health_check`. */
const START_DEADLINE_MS = 90_000;

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
  const [tick, setTick] = useState(0);
  const [log, setLog] = useState<ServiceLogView>({
    open: false,
    lines: "",
    logPath: "",
  });

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
        setState((current) =>
          current.phase === "starting"
            ? current
            : { phase: next.phase, data: next },
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((current) =>
          current.phase === "starting"
            ? current
            : { phase: "error", error: safeError(error) },
        );
      }
    })();
    return () => controller.abort();
  }, [rpc, endpoint, local, authToken, tick]);

  const refresh = useCallback(() => setTick((current) => current + 1), []);

  const start = useCallback(async () => {
    if (!pythonPath || state.phase === "starting") return;
    setState({ phase: "starting" });
    setLog({ open: false, lines: "", logPath: "" });
    try {
      const started = parseServiceStart(
        await envCall(rpc, "serviceStart", {
          endpoint,
          pythonPath,
          workspaceDir,
          authToken,
        }),
      );
      if (started.error) {
        setState({ phase: "error", error: started.error });
        return;
      }
      const deadline = Date.now() + START_DEADLINE_MS;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (Date.now() > deadline) {
          setState({ phase: "error", error: t("startTimeout") });
          return;
        }
        try {
          const status = parseServiceState(
            await envCall(rpc, "serviceStatus", { endpoint, authToken }),
          );
          if (status.phase === "running") {
            setState({ phase: "running", data: status });
            return;
          }
        } catch {
          // Keep polling: a starting service answers once it is listening.
        }
      }
    } catch (error) {
      setState({ phase: "error", error: safeError(error) });
    }
  }, [authToken, endpoint, pythonPath, rpc, state.phase, t, workspaceDir]);

  const stop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await envCall(rpc, "serviceStop", { endpoint });
      refresh();
    } catch (error) {
      setState({ phase: "error", error: safeError(error) });
    } finally {
      setStopping(false);
    }
  }, [endpoint, refresh, rpc, stopping]);

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

  return { state, stopping, start, stop, refresh, log, viewLog, dismissLog };
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
  onAutoStart,
}: {
  t: EnvTranslator;
  endpoint: string;
  pythonPath: string;
  control: ServiceControl;
  remeInstalled: boolean;
  autoStart: boolean;
  writable: boolean;
  onAutoStart(checked: boolean): void;
}): JSX.Element {
  const { state, stopping, log } = control;
  const [confirming, setConfirming] = useState(false);

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
          {state.phase === "checking" || state.phase === "starting" ? (
            <StatusBadge tone="progress">
              {t(
                state.phase === "starting"
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
              {t("serviceBadgeConflict")}
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
        {state.phase === "running" ? (
          <p className="reme-settings-muted">
            {state.data?.managed
              ? fill(t("managedNote"), { pid: state.data?.pid ?? "" })
              : t("foreignNote")}
          </p>
        ) : null}
        {state.phase === "conflict" ? (
          <p className="reme-settings-muted">{t("conflictNote")}</p>
        ) : null}
        {state.phase === "error" && state.error ? (
          <p className="reme-settings-error">
            {`${t("serviceError")}: ${state.error}`}
          </p>
        ) : null}
        <div className="reme-env-cta">
          {state.phase === "running" ? (
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
                state.phase === "starting" || !remeInstalled || !pythonPath
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
