import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusRpc } from "../../client/status-page.js";
import { safeError } from "../../endpoint.js";
import type { InstallStatus, RemeCheck } from "../types.js";
import { fill, type EnvTranslator } from "./locales.js";
import { StatusBadge } from "./presentation.js";
import { envCall, parseInstallStatus, parseRemeCheck } from "./rpc.js";

export interface CheckState {
  phase: "idle" | "ready" | "error";
  data?: RemeCheck;
  error?: string;
  /** The interpreter this result belongs to. */
  forPath: string;
}

export interface InstallState {
  phase: "idle" | "running" | "done";
  /** Job this section polls; another installation cannot replace it. */
  jobId?: string;
  job?: InstallStatus;
  error?: string;
}

export interface DependencyState {
  /** Check result, only when it belongs to the interpreter on screen. */
  checkData: RemeCheck | undefined;
  checkError: string | undefined;
  checking: boolean;
  install: InstallState;
  /** Wall clock tick while an installation runs, for the elapsed label. */
  now: number;
  recheck(): void;
  start(
    upgrade: boolean,
    indexUrl?: string,
    forceReinstall?: boolean,
  ): Promise<void>;
  cancel(): Promise<void>;
  dismiss(): void;
}

/**
 * The dependency section's asynchronous state: one reme-ai check per
 * interpreter, and one installation job bound to its own id.
 */
export function useDependency(
  rpc: StatusRpc,
  options: {
    pythonPath: string;
    /** False for a remote endpoint, whose local steps are hidden. */
    enabled?: boolean;
    onInstalled(): void;
  },
): DependencyState {
  const { pythonPath, enabled = true, onInstalled } = options;
  const [check, setCheck] = useState<CheckState>({
    phase: "idle",
    forPath: "",
  });
  const [install, setInstall] = useState<InstallState>({ phase: "idle" });
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(0);
  const installed = useRef(onInstalled);
  installed.current = onInstalled;

  useEffect(() => {
    if (!enabled || !pythonPath) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const value = await envCall(
          rpc,
          "checkReme",
          { pythonPath },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setCheck({
          phase: "ready",
          data: parseRemeCheck(value),
          error: undefined,
          forPath: pythonPath,
        });
      } catch (error) {
        if (!controller.signal.aborted)
          setCheck({
            phase: "error",
            error: safeError(error),
            forPath: pythonPath,
          });
      }
    })();
    return () => controller.abort();
  }, [rpc, pythonPath, tick, enabled]);

  // Progress belongs to an interpreter: switching interpreters must not keep
  // showing (or cancelling) a job that was started for the previous one.
  const installFor = useRef(pythonPath);
  useEffect(() => {
    if (installFor.current === pythonPath) return;
    installFor.current = pythonPath;
    setInstall({ phase: "idle" });
  }, [pythonPath]);

  // Restoring a running job is per interpreter: a job started for another
  // interpreter belongs to that interpreter's section, not this one.
  useEffect(() => {
    if (!enabled || !pythonPath) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const status = parseInstallStatus(
          await envCall(rpc, "installStatus", {}, controller.signal),
        );
        if (controller.signal.aborted) return;
        if (status?.phase !== "running" || status.pythonPath !== pythonPath)
          return;
        setInstall({ phase: "running", jobId: status.id, job: status });
      } catch {
        // Restoring is best-effort; a later action reports real failures.
      }
    })();
    return () => controller.abort();
  }, [rpc, pythonPath, enabled]);

  const jobId = install.jobId;
  useEffect(() => {
    if (install.phase !== "running") return;
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const status = parseInstallStatus(
          await envCall(
            rpc,
            "installStatus",
            { jobId: jobId ?? "" },
            controller.signal,
          ),
        );
        if (cancelled) return;
        if (!status) {
          setInstall({ phase: "idle" });
          return;
        }
        if (status.phase === "running") {
          setInstall((current) => ({ ...current, job: status }));
          timer = setTimeout(() => void poll(), 2000);
          return;
        }
        setInstall((current) => ({ ...current, phase: "done", job: status }));
        if (status.phase === "succeeded") installed.current();
      } catch (error) {
        if (cancelled) return;
        setInstall((current) => ({
          ...current,
          phase: "done",
          error: safeError(error),
        }));
      }
    };
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [install.phase, jobId, rpc]);

  useEffect(() => {
    if (install.phase !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [install.phase]);

  const recheck = useCallback(() => {
    setCheck({ phase: "idle", forPath: "" });
    setTick((current) => current + 1);
  }, []);

  const start = useCallback(
    async (upgrade: boolean, indexUrl?: string, forceReinstall?: boolean) => {
      if (!pythonPath || install.phase === "running") return;
      setInstall({ phase: "idle" });
      try {
        const status = parseInstallStatus(
          await envCall(rpc, "install", {
            pythonPath,
            upgrade,
            ...(indexUrl ? { indexUrl } : {}),
            ...(forceReinstall ? { forceReinstall } : {}),
          }),
        );
        setInstall(
          status && status.phase === "running"
            ? { phase: "running", jobId: status.id, job: status }
            : status
            ? { phase: "done", jobId: status.id, job: status }
            : { phase: "idle" },
        );
      } catch (error) {
        setInstall({ phase: "done", error: safeError(error) });
      }
    },
    [install.phase, pythonPath, rpc],
  );

  const cancel = useCallback(async () => {
    if (!jobId) return;
    try {
      await envCall(rpc, "installCancel", { jobId });
    } catch {
      // Polling reflects the final phase either way.
    }
  }, [jobId, rpc]);

  const dismiss = useCallback(() => setInstall({ phase: "idle" }), []);

  const current = check.forPath === pythonPath ? check : undefined;
  return {
    checkData: current?.data,
    checkError: current?.error,
    checking: Boolean(pythonPath) && check.forPath !== pythonPath,
    install,
    now,
    recheck,
    start,
    cancel,
    dismiss,
  };
}

function elapsedText(job: InstallStatus, now: number): string {
  const started = Date.parse(job.startedAt);
  if (!Number.isFinite(started) || now < started) return "";
  const seconds = Math.floor((now - started) / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** Step 2: reme-ai in the selected interpreter, and its one-click install. */
export function DependencySection({
  t,
  pythonPath,
  dependency,
}: {
  t: EnvTranslator;
  pythonPath: string;
  dependency: DependencyState;
}): JSX.Element {
  const { checkData, checkError, checking, install, now } = dependency;
  const [confirming, setConfirming] = useState(false);
  const [mirror, setMirror] = useState("");

  const badge = !checkData
    ? undefined
    : !checkData.installed
    ? { tone: "progress" as const, text: t("depMissing") }
    : checkData.versionOk && checkData.hasCore
    ? { tone: "ok" as const, text: t("depReady") }
    : checkData.versionOk
    ? { tone: "progress" as const, text: t("coreMissingBadge") }
    : { tone: "progress" as const, text: t("depUpgrade") };

  return (
    <section className="reme-env-card">
      <header>
        <span className="reme-env-step" aria-hidden="true">
          2
        </span>
        <div>
          <h4>{t("dependencyTitle")}</h4>
          <p>{t("dependencyHint")}</p>
        </div>
        {badge ? (
          <aside>
            <StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>
          </aside>
        ) : null}
      </header>
      <div className="reme-env-card-body">
        <div className="reme-env-factrow">
          <span className="reme-env-field-label">{t("interpreterLabel")}</span>
          <code className="reme-env-path" title={pythonPath}>
            {pythonPath || t("noInterpreter")}
          </code>
          <button
            type="button"
            className="reme-settings-button"
            disabled={!pythonPath}
            onClick={dependency.recheck}
          >
            {t("recheck")}
          </button>
        </div>
        {!pythonPath ? (
          <p className="reme-settings-muted">{t("selectInterpreterFirst")}</p>
        ) : checking ? (
          <p className="reme-settings-muted">{t("checkingReme")}</p>
        ) : null}
        {checkError ? (
          <p className="reme-settings-error">
            {t("checkRemeFailed")}
            {checkError ? `: ${checkError}` : ""}
          </p>
        ) : null}
        {checkData?.error ? (
          <p className="reme-settings-error">
            {`${t("checkRemeFailed")}: ${checkData.error}`}
          </p>
        ) : null}
        {checkData ? (
          <div className="reme-env-metrics">
            <div className="reme-env-metric">
              <span>{t("remeLabel")}</span>
              <div>
                {checkData.installed ? (
                  <>
                    <StatusBadge
                      tone={checkData.versionOk ? "ok" : "progress"}
                    >{`reme-ai ${checkData.version}`}</StatusBadge>
                    {checkData.versionOk ? null : (
                      <small>{t("upgradeRecommended")}</small>
                    )}
                  </>
                ) : (
                  <StatusBadge tone="bad">{t("notInstalled")}</StatusBadge>
                )}
              </div>
            </div>
            <div className="reme-env-metric">
              <span>{t("coreLabel")}</span>
              <div>
                {checkData.installed ? (
                  <StatusBadge tone={checkData.hasCore ? "ok" : "progress"}>
                    {checkData.hasCore ? t("coreOk") : t("coreMissing")}
                  </StatusBadge>
                ) : (
                  <span className="reme-settings-muted">—</span>
                )}
              </div>
            </div>
            <div className="reme-env-metric">
              <span>{t("cliLabel")}</span>
              <div>
                {checkData.installed ? (
                  checkData.cliPath ? (
                    <code
                      className="reme-env-metric-path"
                      title={checkData.cliPath}
                    >
                      {checkData.cliPath}
                    </code>
                  ) : (
                    <StatusBadge tone="progress">
                      {t("cliFallback")}
                    </StatusBadge>
                  )
                ) : (
                  <span className="reme-settings-muted">—</span>
                )}
              </div>
            </div>
          </div>
        ) : null}
        {checkData && install.phase !== "running" ? (
          <div className="reme-env-cta">
            <label className="reme-env-mirror">
              <span>{t("mirrorLabel")}</span>
              <select
                value={mirror}
                onChange={(event) => setMirror(event.target.value)}
              >
                <option value="">{t("mirrorDefault")}</option>
                <option value="https://pypi.org/simple">
                  {t("mirrorPypi")}
                </option>
                <option value="https://pypi.tuna.tsinghua.edu.cn/simple">
                  {t("mirrorTsinghua")}
                </option>
                <option value="https://mirrors.aliyun.com/pypi/simple">
                  {t("mirrorAliyun")}
                </option>
              </select>
            </label>
            {confirming ? (
              <div className="reme-env-confirm">
                <p>{fill(t("installConfirm"), { path: pythonPath })}</p>
                <button
                  type="button"
                  className="reme-settings-save"
                  onClick={() => {
                    setConfirming(false);
                    // Fresh install: no upgrade. Outdated: upgrade. Current
                    // but suspect (Reinstall): force pip to reinstall.
                    const reinstall =
                      checkData.installed && checkData.versionOk;
                    // The mirror choice reaches pip as `--index-url`; without
                    // it the selector would be decorative.
                    void dependency.start(
                      checkData.installed && !checkData.versionOk,
                      mirror || undefined,
                      reinstall,
                    );
                  }}
                >
                  {t("confirmInstall")}
                </button>
                <button
                  type="button"
                  className="reme-settings-discard"
                  onClick={() => setConfirming(false)}
                >
                  {t("cancel")}
                </button>
              </div>
            ) : checkData.installed && checkData.versionOk ? (
              <button
                type="button"
                className="reme-settings-button"
                onClick={() => setConfirming(true)}
              >
                {t("reinstall")}
              </button>
            ) : checkData.installed ? (
              <button
                type="button"
                className="reme-settings-save"
                onClick={() => setConfirming(true)}
              >
                {t("upgradeButton")}
              </button>
            ) : (
              <button
                type="button"
                className="reme-settings-save"
                onClick={() => setConfirming(true)}
              >
                {t("installButton")}
              </button>
            )}
            <p className="reme-settings-muted reme-env-hint-inline">
              {t("condaHint")}
            </p>
          </div>
        ) : null}
        {install.phase === "running" && install.job ? (
          <div className="reme-env-progress">
            <div className="reme-env-row">
              <StatusBadge tone="progress">
                {t("installing")}
                {elapsedText(install.job, now)
                  ? ` · ${elapsedText(install.job, now)}`
                  : ""}
              </StatusBadge>
              <button
                type="button"
                className="reme-settings-discard"
                disabled={install.job.cancelling === true}
                onClick={() => void dependency.cancel()}
              >
                {t(install.job.cancelling ? "cancelling" : "cancelInstall")}
              </button>
            </div>
            <pre className="reme-env-log">
              {install.job.logTail || t("waitingForOutput")}
            </pre>
          </div>
        ) : null}
        {install.phase === "done" ? (
          <div className="reme-env-result">
            {install.job?.phase === "succeeded" ? (
              <p className="reme-settings-success">{t("installSucceeded")}</p>
            ) : null}
            {install.job?.phase === "cancelled" ? (
              <p className="reme-settings-muted">{t("installCancelled")}</p>
            ) : null}
            {install.job?.phase === "failed" ? (
              <>
                <p className="reme-settings-error">{t("installFailed")}</p>
                {install.job.logTail ? (
                  <pre className="reme-env-log">{install.job.logTail}</pre>
                ) : null}
                <p className="reme-settings-muted">{install.job.logPath}</p>
              </>
            ) : null}
            {install.error ? (
              <p className="reme-settings-error">{install.error}</p>
            ) : null}
            <button
              type="button"
              className="reme-settings-button"
              onClick={() => {
                setConfirming(false);
                dependency.dismiss();
              }}
            >
              {t("dismiss")}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
