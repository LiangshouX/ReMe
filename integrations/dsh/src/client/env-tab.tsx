import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";

import { safeError } from "../endpoint.js";
import type {
  PythonDetection,
  PythonEnv,
  PythonOrigin,
} from "../pyenv/types.js";
import { ReMeClient } from "../reme/client.js";
import type { ReMeSettings } from "../types.js";
import type { StatusRpc } from "./status-page.js";

const MINICONDA_URL = "https://docs.conda.io/en/latest/miniconda.html";

export const envEn = {
  connectionTitle: "Service connection",
  endpointLabel: "Service URL",
  checking: "Checking…",
  connected: "Connected",
  disconnected: "Not connected",
  retest: "Test connection",
  remoteNotice:
    "This service URL is not local, so local environment management is disabled.",
  pythonTitle: "Local Python",
  pythonHint:
    "ReMe requires Python 3.11 or newer. Pick the interpreter that a local service should use.",
  detecting: "Detecting Python environments…",
  detectFailed: "Detection failed",
  refresh: "Refresh",
  emptyTitle: "No usable Python found",
  emptyHint:
    "Install Miniconda or any Python 3.11+, then refresh. Existing conda environments are detected automatically.",
  miniconda: "Miniconda download",
  recommended: "recommended",
  okBadge: "OK",
  tooOld: "Needs 3.11+",
  originConda: "Conda ({name})",
  originPythonOrg: "python.org installer",
  originStore: "Microsoft Store",
  originVenv: "venv environment",
  originSystem: "System PATH",
  originUnknown: "Unknown origin",
  errorsTitle: "Probe details",
  dependencyTitle: "ReMe dependency",
  configTitle: "ReMe parameters",
  controlTitle: "Service control",
  upcoming:
    "This section arrives with the next milestone of the environment feature.",
};

export const envZh: typeof envEn = {
  connectionTitle: "服务连接",
  endpointLabel: "服务地址",
  checking: "正在检查…",
  connected: "已连接",
  disconnected: "未连接",
  retest: "测试连接",
  remoteNotice: "当前服务地址不是本机地址，本地环境管理已停用。",
  pythonTitle: "本地 Python 环境",
  pythonHint:
    "ReMe 需要 Python 3.11 或更新版本。请选择本地服务使用的 Python 解释器。",
  detecting: "正在探测本地 Python 环境…",
  detectFailed: "探测失败",
  refresh: "重新探测",
  emptyTitle: "未检测到可用的 Python 环境",
  emptyHint:
    "可安装 Miniconda 或任意 Python 3.11+ 后点击“重新探测”；已有的 conda 环境会被自动识别。",
  miniconda: "下载 Miniconda",
  recommended: "推荐",
  okBadge: "可用",
  tooOld: "需要 3.11+",
  originConda: "Conda（{name}）",
  originPythonOrg: "python.org 安装器",
  originStore: "Microsoft Store",
  originVenv: "venv 虚拟环境",
  originSystem: "系统 PATH",
  originUnknown: "来源未知",
  errorsTitle: "探测细节",
  dependencyTitle: "ReMe 依赖",
  configTitle: "ReMe 参数",
  controlTitle: "服务控制",
  upcoming: "该分区将随环境管理特性的后续里程碑提供。",
};

export type EnvTranslator = (key: keyof typeof envEn) => string;

export interface ReMeEnvironmentTabProps {
  scope: ConfigForm<ReMeSettings>;
  rpc: StatusRpc;
  t: EnvTranslator;
}

interface DetectState {
  phase: "loading" | "ready" | "error";
  data?: PythonDetection;
  error?: string;
}

interface HealthState {
  phase: "loading" | "ok" | "fail";
  /** The endpoint this result was measured against. */
  endpoint: string;
  version?: string;
  error?: string;
}

function isLocalEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function parseDetection(value: unknown): PythonDetection {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { envs?: unknown }).envs)
  )
    throw new Error("Invalid environment detection response");
  return value as unknown as PythonDetection;
}

function originLabel(t: EnvTranslator, origin: PythonOrigin): string {
  switch (origin.kind) {
    case "conda":
      return t("originConda").replace("{name}", origin.envName);
    case "python.org":
      return t("originPythonOrg");
    case "windows-store":
      return t("originStore");
    case "venv":
      return t("originVenv");
    case "system":
      return t("originSystem");
    default:
      return t("originUnknown");
  }
}

/** Environment management panel: local service connection, Python, service. */
export function ReMeEnvironmentTab({
  scope,
  rpc,
  t,
}: ReMeEnvironmentTabProps): JSX.Element | null {
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  );
  const value = snapshot.value;
  const endpoint = value?.endpoint ?? "";
  const [detection, setDetection] = useState<DetectState>({
    phase: "loading",
  });
  const [health, setHealth] = useState<HealthState>({
    phase: "loading",
    endpoint: "",
  });
  const [detectTick, setDetectTick] = useState(0);
  const [healthTick, setHealthTick] = useState(0);
  const [savingExe, setSavingExe] = useState("");

  const loadDetection = useCallback(
    async (signal: AbortSignal, refresh: boolean) => {
      try {
        const result = await rpc.call(
          "/api",
          "remeEnv/python",
          { args: { refresh } },
          signal,
        );
        if (!result.ok)
          throw new Error(result.error.message || result.error.code);
        setDetection((current) => ({
          ...current,
          phase: "ready",
          data: parseDetection(result.value),
        }));
      } catch (error) {
        if (!signal.aborted)
          setDetection((current) => ({
            ...current,
            phase: "error",
            error: safeError(error),
          }));
      }
    },
    [rpc],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadDetection(controller.signal, detectTick > 0);
    return () => controller.abort();
  }, [loadDetection, detectTick]);

  useEffect(() => {
    if (!endpoint) return;
    const controller = new AbortController();
    const client = new ReMeClient({
      endpoint,
      requestTimeoutMs: value?.requestTimeoutMs ?? 10000,
      backgroundTimeoutMs: value?.backgroundTimeoutMs ?? 3600000,
    });
    void client
      .healthCheck({ signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.ok)
          setHealth({
            phase: "ok",
            endpoint,
            version: result.health?.version ?? "",
          });
        else setHealth({ phase: "fail", endpoint, error: result.error });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setHealth({ phase: "fail", endpoint, error: safeError(error) });
      });
    return () => controller.abort();
    // Reload when connection settings or the manual retest tick change.
  }, [
    endpoint,
    value?.requestTimeoutMs,
    value?.backgroundTimeoutMs,
    healthTick,
  ]);

  if (snapshot.status === "unavailable") return null;

  const detected = detection.phase === "ready" ? detection.data : undefined;
  const select = (env: PythonEnv): void => {
    if (!value || !snapshot.writable || savingExe) return;
    setSavingExe(env.exe);
    void scope
      .mutate(
        [{ op: "set", path: ["pythonPath"], value: env.exe }],
        snapshot.revision,
      )
      .catch(() => undefined)
      .finally(() => setSavingExe(""));
  };

  const local = isLocalEndpoint(endpoint);
  const selectedExe = value?.pythonPath ?? "";
  const healthCurrent =
    health.phase !== "loading" && health.endpoint === endpoint;

  return (
    <div className="reme-env">
      <section className="reme-settings-section">
        <h4>{t("connectionTitle")}</h4>
        <div className="reme-env-row">
          <span className="reme-env-label">{t("endpointLabel")}</span>
          <code className="reme-env-endpoint">{endpoint}</code>
          {!healthCurrent ? (
            <span className="reme-status-badge">
              <i />
              {t("checking")}
            </span>
          ) : health.phase === "ok" ? (
            <span className="reme-status-badge ok">
              <i />
              {health.version ? `ReMe ${health.version}` : t("connected")}
            </span>
          ) : (
            <span className="reme-status-badge bad">
              <i />
              {t("disconnected")}
            </span>
          )}
          <button
            type="button"
            className="reme-settings-button"
            onClick={() => {
              setHealth({ phase: "loading", endpoint });
              setHealthTick((tick) => tick + 1);
            }}
          >
            {t("retest")}
          </button>
        </div>
        {healthCurrent && health.phase === "fail" && health.error ? (
          <p className="reme-settings-error">{health.error}</p>
        ) : null}
      </section>
      {!local ? (
        <p className="reme-settings-muted reme-env-notice">
          {t("remoteNotice")}
        </p>
      ) : (
        <>
          <section className="reme-settings-section">
            <h4>{t("pythonTitle")}</h4>
            <p className="reme-settings-muted">{t("pythonHint")}</p>
            <div className="reme-env-row">
              {detection.phase === "loading" ? (
                <span className="reme-settings-muted">{t("detecting")}</span>
              ) : null}
              <button
                type="button"
                className="reme-settings-button"
                onClick={() => {
                  setDetection({ phase: "loading" });
                  setDetectTick((tick) => tick + 1);
                }}
              >
                {t("refresh")}
              </button>
            </div>
            {detection.phase === "error" ? (
              <p className="reme-settings-error">
                {t("detectFailed")}
                {detection.error ? `: ${detection.error}` : ""}
              </p>
            ) : null}
            {detected && detected.envs.length === 0 ? (
              <div className="reme-env-hint">
                <strong>{t("emptyTitle")}</strong>
                <span>{t("emptyHint")}</span>
                <a
                  className="reme-settings-button"
                  href={MINICONDA_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("miniconda")}
                </a>
              </div>
            ) : null}
            {detected && detected.envs.length > 0 ? (
              <div className="reme-env-list">
                {detected.envs.map((env) => (
                  <label
                    key={env.exe}
                    className={`reme-env-python${
                      selectedExe === env.exe ? " active" : ""
                    }`}
                  >
                    <input
                      type="radio"
                      name="reme-python-interpreter"
                      checked={selectedExe === env.exe}
                      disabled={
                        !env.ok || savingExe !== "" || !snapshot.writable
                      }
                      onChange={() => select(env)}
                    />
                    <span className="reme-env-python-main">
                      <strong>
                        {`Python ${env.version || "?"}`}
                        {selectedExe !== env.exe &&
                        env.exe === detected.suggested
                          ? ` · ${t("recommended")}`
                          : ""}
                      </strong>
                      <small>{`${originLabel(t, env.origin)} · ${
                        env.exe
                      }`}</small>
                    </span>
                    <span
                      className={`reme-status-badge ${env.ok ? "ok" : "bad"}`}
                    >
                      <i />
                      {env.ok ? t("okBadge") : t("tooOld")}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
            {detected && detected.errors.length > 0 ? (
              <details className="reme-settings-details">
                <summary>{t("errorsTitle")}</summary>
                <pre>{detected.errors.join("\n")}</pre>
              </details>
            ) : null}
          </section>
          <section className="reme-settings-section">
            <h4>{t("dependencyTitle")}</h4>
            <p className="reme-settings-muted reme-env-upcoming">
              {t("upcoming")}
            </p>
          </section>
          <section className="reme-settings-section">
            <h4>{t("configTitle")}</h4>
            <p className="reme-settings-muted reme-env-upcoming">
              {t("upcoming")}
            </p>
          </section>
          <section className="reme-settings-section">
            <h4>{t("controlTitle")}</h4>
            <p className="reme-settings-muted reme-env-upcoming">
              {t("upcoming")}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
