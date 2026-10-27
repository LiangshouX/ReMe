import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";

import { safeError } from "../endpoint.js";
import type { InstallStatus } from "../pyenv/install.js";
import type { RemeCheck } from "../pyenv/reme.js";
import type {
  ServiceLog,
  ServiceStartResult,
  ServiceState,
} from "../pyenv/service.js";
import type {
  PythonDetection,
  PythonEnv,
  PythonOrigin,
} from "../pyenv/types.js";
import type { EnvSummary, LlmTestResult } from "../pyenv/workspace.js";
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
  dependencyHint:
    "The local service runs on the selected interpreter. reme-ai[core] provides search, automatic memory and memory consolidation.",
  interpreterLabel: "Interpreter",
  noInterpreter: "No interpreter selected",
  selectInterpreterFirst: "Select or install a Python interpreter above first.",
  recheck: "Check",
  checkingReme: "Checking ReMe installation…",
  checkRemeFailed: "ReMe check failed",
  remeLabel: "reme-ai",
  coreLabel: "[core] extras",
  cliLabel: "reme CLI",
  notInstalled: "Not installed",
  upgradeRecommended: "upgrade recommended",
  coreOk: "Available",
  coreMissing: "Missing (auto_memory / auto_dream unavailable)",
  cliFallback: "python wrapper fallback",
  installButton: "Install reme-ai[core]",
  upgradeButton: "Upgrade reme-ai",
  reinstall: "Reinstall reme-ai[core]",
  installConfirm:
    "Installs into {path}. Packages are downloaded on first use and may take 5–20 minutes depending on the network; progress is shown below.",
  confirmInstall: "Confirm install",
  cancel: "Cancel",
  installing: "Installing",
  cancelInstall: "Cancel install",
  waitingForOutput: "Waiting for pip output…",
  installSucceeded:
    "ReMe installed. Search, automatic memory and memory consolidation are now available.",
  installFailed: "Installation failed. See the log below.",
  installCancelled: "Installation cancelled.",
  dismiss: "Dismiss",
  mirrorLabel: "Package index",
  mirrorDefault: "Default (pip config)",
  mirrorPypi: "PyPI",
  mirrorTsinghua: "Tsinghua",
  mirrorAliyun: "Aliyun",
  condaHint:
    "In a conda environment pip still works; if dependency conflicts appear, prefer a dedicated environment.",
  configHint:
    "ReMe reads credentials from the workspace .env at service start. Secrets stay in that file; DSH settings never store them.",
  workspaceDir: "Workspace directory",
  workspaceDirHint:
    "Empty means ~/.reme. Restart the service after changing it.",
  saveWorkspace: "Save path",
  envLoading: "Loading .env…",
  envMissing: "No .env yet; saving creates it.",
  envPath: "File",
  llmGroup: "LLM (auto memory / consolidation)",
  embeddingGroup: "Embedding",
  backendLabel: "Backend",
  modelLabel: "Model",
  apiKeyLabel: "API key",
  baseUrlLabel: "Base URL",
  secretSet: "Set {masked}; leave blank to keep",
  secretUnset: "Not set",
  embeddingHint:
    "ReMe 0.4.0.x requires a non-empty key even without vector search; EMPTY is the placeholder.",
  saveEnv: "Save to .env",
  savingEnv: "Saving…",
  savedEnv: "Saved to {path}",
  saveEnvFailed: "Saving failed",
  testLlmButton: "Test LLM connection",
  testingLlm: "Testing…",
  llmOk: "LLM reachable ({ms} ms)",
  llmFailed: "LLM test failed",
  serviceHint:
    "Start or stop the local ReMe service. The service keeps running after DSH closes.",
  serviceBadgeStarting: "Starting…",
  serviceBadgeConflict: "Port occupied",
  serviceBadgeStopped: "Stopped",
  serviceRunning: "Running",
  startService: "Start service",
  stopService: "Stop service",
  startTimeout: "The service did not become healthy within 90 seconds",
  stopConfirm:
    "Stop the ReMe service? Automatic memory in flight may need a retry.",
  foreignNote:
    "This service was started outside DSH; its state is shown but it is not managed here.",
  conflictNote:
    "Another program occupies this port. Change the service URL port in Memory settings.",
  viewLogs: "View log",
  logEmpty: "The service log is empty.",
  autoStartLabel: "Start the service automatically with DSH",
  managedNote: "Managed by this plugin · PID {pid}",
  serviceError: "Service operation failed",
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
  dependencyHint:
    "本地服务运行在所选解释器上。安装 reme-ai[core] 后即可使用搜索、自动记忆与记忆整理。",
  interpreterLabel: "解释器",
  noInterpreter: "尚未选择解释器",
  selectInterpreterFirst: "请先在上方选择或安装 Python 解释器。",
  recheck: "检测",
  checkingReme: "正在检测 ReMe 安装…",
  checkRemeFailed: "ReMe 检测失败",
  remeLabel: "reme-ai",
  coreLabel: "[core] 依赖",
  cliLabel: "reme CLI",
  notInstalled: "未安装",
  upgradeRecommended: "建议升级",
  coreOk: "可用",
  coreMissing: "缺失（auto_memory / auto_dream 不可用）",
  cliFallback: "回退到 python 包装",
  installButton: "安装 reme-ai[core]",
  upgradeButton: "升级 reme-ai",
  reinstall: "重装 reme-ai[core]",
  installConfirm:
    "将安装到 {path}。首次使用需要下载依赖，视网络情况通常需要 5–20 分钟，进度见下方日志。",
  confirmInstall: "确认安装",
  cancel: "取消",
  installing: "正在安装",
  cancelInstall: "取消安装",
  waitingForOutput: "等待 pip 输出…",
  installSucceeded: "ReMe 安装完成，搜索、自动记忆与记忆整理现已可用。",
  installFailed: "安装失败，请查看下方日志。",
  installCancelled: "安装已取消。",
  dismiss: "关闭",
  mirrorLabel: "软件源",
  mirrorDefault: "默认（pip 配置）",
  mirrorPypi: "PyPI 官方",
  mirrorTsinghua: "清华镜像",
  mirrorAliyun: "阿里云镜像",
  condaHint:
    "conda 环境中使用 pip 通常没有问题；如遇依赖冲突，建议使用专用环境。",
  configHint:
    "ReMe 在服务启动时从 workspace 的 .env 读取凭据。密钥只保存在该文件里，不写入 DSH 设置。",
  workspaceDir: "Workspace 目录",
  workspaceDirHint: "留空表示 ~/.reme；修改后需重启服务。",
  saveWorkspace: "保存路径",
  envLoading: "正在读取 .env…",
  envMissing: "尚未创建 .env；保存后自动创建。",
  envPath: "文件",
  llmGroup: "LLM（自动记忆 / 记忆整理）",
  embeddingGroup: "Embedding",
  backendLabel: "后端",
  modelLabel: "模型",
  apiKeyLabel: "API Key",
  baseUrlLabel: "Base URL",
  secretSet: "已设置 {masked}；留空保持不变",
  secretUnset: "未设置",
  embeddingHint:
    "ReMe 0.4.0.x 即使不使用向量检索也要求此项非空，占位值 EMPTY 即可。",
  saveEnv: "保存到 .env",
  savingEnv: "正在保存…",
  savedEnv: "已保存到 {path}",
  saveEnvFailed: "保存失败",
  testLlmButton: "测试 LLM 连接",
  testingLlm: "正在测试…",
  llmOk: "LLM 连接正常（{ms} ms）",
  llmFailed: "LLM 测试失败",
  serviceHint: "启动或停止本地 ReMe 服务；DSH 关闭后服务仍会保持运行。",
  serviceBadgeStarting: "启动中…",
  serviceBadgeConflict: "端口被占用",
  serviceBadgeStopped: "已停止",
  serviceRunning: "运行中",
  startService: "启动服务",
  stopService: "停止服务",
  startTimeout: "服务在 90 秒内未就绪",
  stopConfirm: "停止 ReMe 服务？进行中的自动记忆可能需要重试。",
  foreignNote: "该服务由 DSH 之外的方式启动，这里只显示状态、不由本插件管理。",
  conflictNote: "端口被其他程序占用；请在『记忆设置』中修改服务地址的端口。",
  viewLogs: "查看日志",
  logEmpty: "服务日志为空。",
  autoStartLabel: "随 DSH 启动时自动拉起服务",
  managedNote: "由本插件托管 · PID {pid}",
  serviceError: "服务操作失败",
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

interface CheckState {
  phase: "idle" | "ready" | "error";
  data?: RemeCheck;
  error?: string;
  /** The interpreter this result belongs to. */
  forPath: string;
}

interface InstallState {
  phase: "idle" | "running" | "done";
  job?: InstallStatus;
  error?: string;
}

interface EnvState {
  phase: "loading" | "ready" | "error";
  data?: EnvSummary;
  error?: string;
}

interface EnvResultState {
  kind: "" | "saved" | "failed";
  message?: string;
}

interface LlmTestState {
  phase: "idle" | "running" | "ok" | "fail";
  result?: LlmTestResult;
}

interface ServiceViewState {
  phase: "checking" | "running" | "starting" | "stopped" | "conflict" | "error";
  data?: ServiceState;
  error?: string;
}

interface ServiceLogView {
  open: boolean;
  lines: string;
  logPath: string;
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

function parseRemeCheck(value: unknown): RemeCheck {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid ReMe check response");
  return value as unknown as RemeCheck;
}

function parseInstallStatus(value: unknown): InstallStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.phase === "string"
    ? (value as unknown as InstallStatus)
    : null;
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

function elapsedText(job: InstallStatus, now: number): string {
  const started = Date.parse(job.startedAt);
  if (!Number.isFinite(started) || now < started) return "";
  const seconds = Math.floor((now - started) / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** Environment management panel: connection, Python, dependency, service. */
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
  const [check, setCheck] = useState<CheckState>({
    phase: "idle",
    forPath: "",
  });
  const [install, setInstall] = useState<InstallState>({ phase: "idle" });
  const [detectTick, setDetectTick] = useState(0);
  const [healthTick, setHealthTick] = useState(0);
  const [checkTick, setCheckTick] = useState(0);
  const [savingExe, setSavingExe] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [mirror, setMirror] = useState("");
  const [now, setNow] = useState(0);
  const [env, setEnv] = useState<EnvState>({ phase: "loading" });
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({});
  const [envSaving, setEnvSaving] = useState(false);
  const [envResult, setEnvResult] = useState<EnvResultState>({ kind: "" });
  const [llmTest, setLlmTest] = useState<LlmTestState>({ phase: "idle" });
  const [envTick, setEnvTick] = useState(0);
  const [workspaceInput, setWorkspaceInput] = useState<string | undefined>(
    undefined,
  );
  const [service, setService] = useState<ServiceViewState>({
    phase: "checking",
  });
  const [serviceTick, setServiceTick] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [logView, setLogView] = useState<ServiceLogView>({
    open: false,
    lines: "",
    logPath: "",
  });

  // Derived values must precede hook dependency arrays.
  const detected = detection.phase === "ready" ? detection.data : undefined;
  const selectedExe = value?.pythonPath ?? "";
  const suggestedExe = detected?.suggested ?? "";
  const selectedPath = selectedExe || suggestedExe;
  const checking = Boolean(selectedPath) && check.forPath !== selectedPath;
  const checkData = check.forPath === selectedPath ? check.data : undefined;
  const checkError = check.forPath === selectedPath ? check.error : undefined;
  const local = isLocalEndpoint(endpoint);
  const healthCurrent =
    health.phase !== "loading" && health.endpoint === endpoint;
  const workspaceDir = value?.remeWorkspaceDir ?? "";
  const workspaceDraft = workspaceInput ?? workspaceDir;

  const loadDetection = useCallback(
    async (signal: AbortSignal, refresh: boolean) => {
      try {
        const result = await rpc.call(
          "/api",
          "remeEnv/python",
          { args: { input: { refresh } } },
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

  const ensureCheck = useCallback(
    async (signal: AbortSignal, pythonPath: string) => {
      if (!pythonPath) return;
      try {
        const result = await rpc.call(
          "/api",
          "remeEnv/checkReme",
          { args: { input: { pythonPath } } },
          signal,
        );
        if (!result.ok)
          throw new Error(result.error.message || result.error.code);
        setCheck((current) => ({
          ...current,
          phase: "ready",
          data: parseRemeCheck(result.value),
          error: undefined,
          forPath: pythonPath,
        }));
      } catch (error) {
        if (!signal.aborted)
          setCheck((current) => ({
            ...current,
            phase: "error",
            error: safeError(error),
            forPath: pythonPath,
          }));
      }
    },
    [rpc],
  );

  useEffect(() => {
    const controller = new AbortController();
    void ensureCheck(controller.signal, selectedPath);
    return () => controller.abort();
  }, [ensureCheck, selectedPath, checkTick]);

  const restoreInstall = useCallback(
    async (signal: AbortSignal) => {
      try {
        const result = await rpc.call(
          "/api",
          "remeEnv/installStatus",
          { args: {} },
          signal,
        );
        if (!result.ok) return;
        const status = parseInstallStatus(result.value);
        if (status?.phase === "running")
          setInstall((current) => ({
            ...current,
            phase: "running",
            job: status,
          }));
      } catch {
        // Restoring is best-effort; a later action reports real failures.
      }
    },
    [rpc],
  );

  useEffect(() => {
    const controller = new AbortController();
    void restoreInstall(controller.signal);
    return () => controller.abort();
  }, [restoreInstall]);

  useEffect(() => {
    if (install.phase !== "running") return;
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const result = await rpc.call(
          "/api",
          "remeEnv/installStatus",
          { args: {} },
          controller.signal,
        );
        if (cancelled) return;
        if (!result.ok) {
          setInstall((current) => ({
            ...current,
            phase: "done",
            error: result.error.message,
          }));
          return;
        }
        const status = parseInstallStatus(result.value);
        if (!status) {
          setInstall({ phase: "idle" });
          return;
        }
        if (status.phase === "running") {
          setInstall((current) => ({
            ...current,
            phase: "running",
            job: status,
          }));
          timer = setTimeout(() => void poll(), 2000);
          return;
        }
        setInstall((current) => ({ ...current, phase: "done", job: status }));
        if (status.phase === "succeeded") {
          setCheckTick((tick) => tick + 1);
          setDetectTick((tick) => tick + 1);
        }
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
  }, [install.phase, rpc]);

  useEffect(() => {
    if (install.phase !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [install.phase]);

  const loadEnv = useCallback(
    async (signal: AbortSignal, dir: string) => {
      try {
        const result = await rpc.call(
          "/api",
          "remeEnv/readEnv",
          { args: { input: { workspaceDir: dir } } },
          signal,
        );
        if (!result.ok)
          throw new Error(result.error.message || result.error.code);
        setEnv((current) => ({
          ...current,
          phase: "ready",
          data: parseEnvSummary(result.value),
        }));
      } catch (error) {
        if (!signal.aborted)
          setEnv((current) => ({
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
    void loadEnv(controller.signal, workspaceDir);
    return () => controller.abort();
  }, [loadEnv, workspaceDir, envTick]);

  const loadService = useCallback(
    async (signal: AbortSignal) => {
      try {
        const result = await rpc.call(
          "/api",
          "remeEnv/serviceStatus",
          { args: { input: { endpoint } } },
          signal,
        );
        if (!result.ok)
          throw new Error(result.error.message || result.error.code);
        const state = parseServiceState(result.value);
        setService((current) =>
          current.phase === "starting"
            ? current
            : { phase: state.phase, data: state },
        );
      } catch (error) {
        if (!signal.aborted)
          setService((current) =>
            current.phase === "starting"
              ? current
              : { phase: "error", error: safeError(error) },
          );
      }
    },
    [rpc, endpoint],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadService(controller.signal);
    return () => controller.abort();
  }, [loadService, serviceTick]);

  if (snapshot.status === "unavailable") return null;

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

  const startInstall = async (upgrade: boolean): Promise<void> => {
    if (!selectedPath || install.phase === "running") return;
    setConfirming(false);
    try {
      const result = await rpc.call("/api", "remeEnv/install", {
        args: {
          input: { pythonPath: selectedPath, upgrade, indexUrl: mirror },
        },
      });
      if (!result.ok)
        throw new Error(result.error.message || result.error.code);
      const status = parseInstallStatus(result.value);
      setInstall(
        status ? { phase: "running", job: status } : { phase: "idle" },
      );
    } catch (error) {
      setInstall({ phase: "done", error: safeError(error) });
    }
  };

  const cancelInstall = async (): Promise<void> => {
    const jobId = install.job?.id ?? "";
    try {
      await rpc.call("/api", "remeEnv/installCancel", {
        args: { input: { jobId } },
      });
    } catch {
      // Polling reflects the final phase either way.
    }
  };

  const envValue = (key: string): string => {
    const draft = envDraft[key];
    if (draft !== undefined) return draft;
    const entry = env.data?.entries.find((item) => item.key === key);
    return entry?.secret ? "" : entry?.value ?? "";
  };

  const envEntry = (key: string) =>
    env.data?.entries.find((item) => item.key === key);

  const updateEnvDraft = (key: string, next: string): void => {
    setEnvDraft((current) => ({ ...current, [key]: next }));
    setEnvResult({ kind: "" });
  };

  const saveEnv = async (): Promise<void> => {
    if (!env.data || envSaving) return;
    const values: Record<string, string> = {};
    for (const entry of env.data.entries) {
      if (!entry.secret) {
        const next = envValue(entry.key).trim();
        if (next !== "") values[entry.key] = next;
        continue;
      }
      const typed = envDraft[entry.key];
      if (typed !== undefined && typed !== "") values[entry.key] = typed;
      else if (!entry.set && entry.key === "EMBEDDING_API_KEY")
        values[entry.key] = "EMPTY";
    }
    setEnvSaving(true);
    setEnvResult({ kind: "" });
    try {
      const result = await rpc.call("/api", "remeEnv/writeEnv", {
        args: { input: { workspaceDir, values } },
      });
      if (!result.ok)
        throw new Error(result.error.message || result.error.code);
      setEnv((current) => ({
        ...current,
        phase: "ready",
        data: parseEnvSummary(result.value),
      }));
      setEnvDraft({});
      setEnvResult({ kind: "saved" });
    } catch (error) {
      setEnvResult({ kind: "failed", message: safeError(error) });
    } finally {
      setEnvSaving(false);
    }
  };

  const runLlmTest = async (): Promise<void> => {
    if (!selectedPath || llmTest.phase === "running") return;
    setLlmTest({ phase: "running" });
    try {
      const result = await rpc.call("/api", "remeEnv/testLlm", {
        args: { input: { workspaceDir, pythonPath: selectedPath } },
      });
      if (!result.ok)
        throw new Error(result.error.message || result.error.code);
      const data = parseLlmResult(result.value);
      setLlmTest({ phase: data.ok ? "ok" : "fail", result: data });
    } catch (error) {
      setLlmTest({
        phase: "fail",
        result: {
          ok: false,
          status: 0,
          latencyMs: 0,
          error: safeError(error),
        },
      });
    }
  };

  const saveWorkspace = async (): Promise<void> => {
    if (!value || !snapshot.writable) return;
    await scope
      .mutate(
        [
          {
            op: "set",
            path: ["remeWorkspaceDir"],
            value: workspaceDraft.trim(),
          },
        ],
        snapshot.revision,
      )
      .catch(() => undefined);
    setWorkspaceInput(undefined);
    setEnvTick((tick) => tick + 1);
  };

  const startService = async (): Promise<void> => {
    if (!selectedPath || service.phase === "starting") return;
    setService({ phase: "starting" });
    setLogView({ open: false, lines: "", logPath: "" });
    try {
      const result = await rpc.call("/api", "remeEnv/serviceStart", {
        args: {
          input: { endpoint, pythonPath: selectedPath, workspaceDir },
        },
      });
      if (!result.ok)
        throw new Error(result.error.message || result.error.code);
      const started = parseServiceStart(result.value);
      if (started.error) {
        setService({ phase: "error", error: started.error });
        return;
      }
      if (started.alreadyRunning) {
        setService({ phase: "running" });
        setServiceTick((tick) => tick + 1);
        return;
      }
      const deadline = Date.now() + 90_000;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (Date.now() > deadline) {
          setService({ phase: "error", error: t("startTimeout") });
          return;
        }
        const statusResult = await rpc.call("/api", "remeEnv/serviceStatus", {
          args: { input: { endpoint } },
        });
        if (!statusResult.ok) continue;
        const status = parseServiceState(statusResult.value);
        if (status.phase === "running") {
          setService({ phase: "running", data: status });
          return;
        }
      }
    } catch (error) {
      setService({ phase: "error", error: safeError(error) });
    }
  };

  const stopService = async (): Promise<void> => {
    if (stopping) return;
    setStopping(true);
    setConfirmingStop(false);
    try {
      const result = await rpc.call("/api", "remeEnv/serviceStop", {
        args: { input: { endpoint } },
      });
      if (!result.ok)
        throw new Error(result.error.message || result.error.code);
      setServiceTick((tick) => tick + 1);
    } catch (error) {
      setService({ phase: "error", error: safeError(error) });
    } finally {
      setStopping(false);
    }
  };

  const viewLog = async (): Promise<void> => {
    try {
      const result = await rpc.call("/api", "remeEnv/serviceLog", {
        args: { input: { workspaceDir } },
      });
      if (!result.ok) return;
      const log = parseServiceLog(result.value);
      setLogView({ open: true, lines: log.lines, logPath: log.logPath });
    } catch {
      // Log viewing is diagnostic only.
    }
  };

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
            {detection.phase === "error" ||
            (detected && detected.envs.length === 0) ? (
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
                      selectedPath === env.exe ? " active" : ""
                    }`}
                  >
                    <input
                      type="radio"
                      name="reme-python-interpreter"
                      checked={selectedPath === env.exe}
                      disabled={
                        !env.ok || savingExe !== "" || !snapshot.writable
                      }
                      onChange={() => select(env)}
                    />
                    <span className="reme-env-python-main">
                      <strong>
                        {`Python ${env.version || "?"}`}
                        {selectedPath !== env.exe &&
                        env.exe === detected.suggested
                          ? ` · ${t("recommended")}`
                          : ""}
                      </strong>
                      <small>
                        {`${originLabel(t, env.origin)} · ${env.exe}`}
                        {env.reme?.installed
                          ? ` · reme ${env.reme.version}`
                          : ""}
                      </small>
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
            <p className="reme-settings-muted">{t("dependencyHint")}</p>
            <div className="reme-env-row">
              <span className="reme-env-label">{t("interpreterLabel")}</span>
              <code className="reme-env-endpoint">
                {selectedPath || t("noInterpreter")}
              </code>
              <button
                type="button"
                className="reme-settings-button"
                disabled={!selectedPath}
                onClick={() => {
                  setCheck((current) => ({ ...current, phase: "idle" }));
                  setCheckTick((tick) => tick + 1);
                }}
              >
                {t("recheck")}
              </button>
            </div>
            {!selectedPath ? (
              <p className="reme-settings-muted">
                {t("selectInterpreterFirst")}
              </p>
            ) : checking ? (
              <p className="reme-settings-muted">{t("checkingReme")}</p>
            ) : null}
            {checkError ? (
              <p className="reme-settings-error">
                {t("checkRemeFailed")}
                {checkError ? `: ${checkError}` : ""}
              </p>
            ) : null}
            {checkData ? (
              <div className="reme-env-checks">
                <div className="reme-env-check">
                  <span>{t("remeLabel")}</span>
                  {checkData.installed ? (
                    <span
                      className={`reme-status-badge ${
                        checkData.versionOk ? "ok" : "progress"
                      }`}
                    >
                      <i />
                      {`reme-ai ${checkData.version}`}
                      {checkData.versionOk
                        ? ""
                        : ` · ${t("upgradeRecommended")}`}
                    </span>
                  ) : (
                    <span className="reme-status-badge bad">
                      <i />
                      {t("notInstalled")}
                    </span>
                  )}
                </div>
                <div className="reme-env-check">
                  <span>{t("coreLabel")}</span>
                  {checkData.installed ? (
                    <span
                      className={`reme-status-badge ${
                        checkData.hasCore ? "ok" : "progress"
                      }`}
                    >
                      <i />
                      {checkData.hasCore ? t("coreOk") : t("coreMissing")}
                    </span>
                  ) : (
                    <span className="reme-settings-muted">—</span>
                  )}
                </div>
                <div className="reme-env-check">
                  <span>{t("cliLabel")}</span>
                  {checkData.installed ? (
                    <span
                      className={`reme-status-badge ${
                        checkData.cliPath ? "ok" : "progress"
                      }`}
                    >
                      <i />
                      {checkData.cliPath || t("cliFallback")}
                    </span>
                  ) : (
                    <span className="reme-settings-muted">—</span>
                  )}
                </div>
              </div>
            ) : null}
            {checkData && install.phase !== "running" ? (
              <div className="reme-env-actions">
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
                    <p>
                      {t("installConfirm").replace(
                        "{path}",
                        selectedPath || "",
                      )}
                    </p>
                    <button
                      type="button"
                      className="reme-settings-save"
                      onClick={() => void startInstall(!checkData.versionOk)}
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
                  <span className="reme-status-badge progress">
                    <i />
                    {t("installing")}
                    {elapsedText(install.job, now || Date.now())
                      ? ` · ${elapsedText(install.job, now || Date.now())}`
                      : ""}
                  </span>
                  <button
                    type="button"
                    className="reme-settings-discard"
                    onClick={() => void cancelInstall()}
                  >
                    {t("cancelInstall")}
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
                  <p className="reme-settings-success">
                    {t("installSucceeded")}
                  </p>
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
                    setInstall({ phase: "idle" });
                    setConfirming(false);
                  }}
                >
                  {t("dismiss")}
                </button>
              </div>
            ) : null}
          </section>
          <section className="reme-settings-section">
            <h4>{t("configTitle")}</h4>
            <p className="reme-settings-muted">{t("configHint")}</p>
            <div className="reme-settings-grid">
              <EnvField label={t("workspaceDir")} hint={t("workspaceDirHint")}>
                <div className="reme-env-inline">
                  <input
                    value={workspaceDraft}
                    placeholder="~/.reme"
                    onChange={(event) => setWorkspaceInput(event.target.value)}
                  />
                  <button
                    type="button"
                    className="reme-settings-button"
                    disabled={!snapshot.writable || envSaving}
                    onClick={() => void saveWorkspace()}
                  >
                    {t("saveWorkspace")}
                  </button>
                </div>
              </EnvField>
            </div>
            {env.phase === "loading" ? (
              <p className="reme-settings-muted">{t("envLoading")}</p>
            ) : null}
            {env.phase === "error" ? (
              <p className="reme-settings-error">
                {t("saveEnvFailed")}
                {env.error ? `: ${env.error}` : ""}
              </p>
            ) : null}
            {env.phase === "ready" && env.data ? (
              <>
                <p className="reme-settings-muted">
                  {env.data.exists
                    ? `${t("envPath")}: ${env.data.envPath}`
                    : t("envMissing")}
                </p>
                <div className="reme-settings-grid reme-env-config">
                  <h5 className="reme-env-group">{t("llmGroup")}</h5>
                  <EnvField label={t("backendLabel")}>
                    <select
                      value={envValue("LLM_BACKEND")}
                      onChange={(event) =>
                        updateEnvDraft("LLM_BACKEND", event.target.value)
                      }
                    >
                      <option value="">—</option>
                      {envOptions(LLM_BACKENDS, envValue("LLM_BACKEND")).map(
                        (name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ),
                      )}
                    </select>
                  </EnvField>
                  <EnvField label={t("modelLabel")}>
                    <input
                      value={envValue("LLM_MODEL_NAME")}
                      placeholder="qwen3.7-plus"
                      onChange={(event) =>
                        updateEnvDraft("LLM_MODEL_NAME", event.target.value)
                      }
                    />
                  </EnvField>
                  <EnvField
                    label={t("apiKeyLabel")}
                    hint={
                      envEntry("LLM_API_KEY")?.set
                        ? t("secretSet").replace(
                            "{masked}",
                            envEntry("LLM_API_KEY")?.masked ?? "",
                          )
                        : t("secretUnset")
                    }
                  >
                    <input
                      type="password"
                      autoComplete="off"
                      value={envDraft["LLM_API_KEY"] ?? ""}
                      placeholder={envEntry("LLM_API_KEY")?.masked ?? ""}
                      onChange={(event) =>
                        updateEnvDraft("LLM_API_KEY", event.target.value)
                      }
                    />
                  </EnvField>
                  <EnvField label={t("baseUrlLabel")}>
                    <input
                      value={envValue("LLM_BASE_URL")}
                      placeholder="https://…/v1"
                      onChange={(event) =>
                        updateEnvDraft("LLM_BASE_URL", event.target.value)
                      }
                    />
                  </EnvField>
                  <h5 className="reme-env-group">{t("embeddingGroup")}</h5>
                  <EnvField label={t("backendLabel")}>
                    <select
                      value={envValue("EMBEDDING_BACKEND")}
                      onChange={(event) =>
                        updateEnvDraft("EMBEDDING_BACKEND", event.target.value)
                      }
                    >
                      <option value="">—</option>
                      {envOptions(
                        EMBEDDING_BACKENDS,
                        envValue("EMBEDDING_BACKEND"),
                      ).map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </EnvField>
                  <EnvField label={t("modelLabel")}>
                    <input
                      value={envValue("EMBEDDING_MODEL_NAME")}
                      placeholder="text-embedding-v4"
                      onChange={(event) =>
                        updateEnvDraft(
                          "EMBEDDING_MODEL_NAME",
                          event.target.value,
                        )
                      }
                    />
                  </EnvField>
                  <EnvField
                    label={t("apiKeyLabel")}
                    hint={
                      envEntry("EMBEDDING_API_KEY")?.set
                        ? t("secretSet").replace(
                            "{masked}",
                            envEntry("EMBEDDING_API_KEY")?.masked ?? "",
                          )
                        : t("secretUnset")
                    }
                  >
                    <input
                      type="password"
                      autoComplete="off"
                      value={envDraft["EMBEDDING_API_KEY"] ?? ""}
                      placeholder={
                        envEntry("EMBEDDING_API_KEY")?.masked ?? "EMPTY"
                      }
                      onChange={(event) =>
                        updateEnvDraft("EMBEDDING_API_KEY", event.target.value)
                      }
                    />
                  </EnvField>
                  <EnvField label={t("baseUrlLabel")} hint={t("embeddingHint")}>
                    <input
                      value={envValue("EMBEDDING_BASE_URL")}
                      placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                      onChange={(event) =>
                        updateEnvDraft("EMBEDDING_BASE_URL", event.target.value)
                      }
                    />
                  </EnvField>
                </div>
                <div className="reme-env-actions">
                  <button
                    type="button"
                    className="reme-settings-save"
                    disabled={envSaving || !snapshot.writable}
                    onClick={() => void saveEnv()}
                  >
                    {t(envSaving ? "savingEnv" : "saveEnv")}
                  </button>
                  <button
                    type="button"
                    className="reme-settings-button"
                    disabled={!selectedPath || llmTest.phase === "running"}
                    onClick={() => void runLlmTest()}
                  >
                    {t(
                      llmTest.phase === "running"
                        ? "testingLlm"
                        : "testLlmButton",
                    )}
                  </button>
                  <span className="reme-settings-result" role="status">
                    {envResult.kind === "saved" ? (
                      <span className="reme-settings-success">
                        {t("savedEnv").replace(
                          "{path}",
                          env.data?.envPath ?? "",
                        )}
                      </span>
                    ) : null}
                    {envResult.kind === "failed" ? (
                      <span className="reme-settings-error">
                        {`${t("saveEnvFailed")}${
                          envResult.message ? `: ${envResult.message}` : ""
                        }`}
                      </span>
                    ) : null}
                    {llmTest.phase === "ok" && llmTest.result ? (
                      <span className="reme-settings-success">
                        {t("llmOk").replace(
                          "{ms}",
                          String(llmTest.result.latencyMs),
                        )}
                      </span>
                    ) : null}
                    {llmTest.phase === "fail" && llmTest.result ? (
                      <span className="reme-settings-error">
                        {`${t("llmFailed")}${
                          llmTest.result.error
                            ? `: ${llmTest.result.error}`
                            : ""
                        }`}
                      </span>
                    ) : null}
                  </span>
                </div>
              </>
            ) : null}
          </section>
          <section className="reme-settings-section">
            <h4>{t("controlTitle")}</h4>
            <p className="reme-settings-muted">{t("serviceHint")}</p>
            <div className="reme-env-row">
              <span className="reme-env-label">{t("endpointLabel")}</span>
              <code className="reme-env-endpoint">{endpoint}</code>
              {service.phase === "checking" || service.phase === "starting" ? (
                <span className="reme-status-badge progress">
                  <i />
                  {t(
                    service.phase === "starting"
                      ? "serviceBadgeStarting"
                      : "checking",
                  )}
                </span>
              ) : service.phase === "running" ? (
                <span className="reme-status-badge ok">
                  <i />
                  {service.data?.version
                    ? `ReMe ${service.data.version}`
                    : t("serviceRunning")}
                </span>
              ) : service.phase === "conflict" ? (
                <span className="reme-status-badge progress">
                  <i />
                  {t("serviceBadgeConflict")}
                </span>
              ) : (
                <span className="reme-status-badge bad">
                  <i />
                  {t("serviceBadgeStopped")}
                </span>
              )}
              <button
                type="button"
                className="reme-settings-button"
                onClick={() => setServiceTick((tick) => tick + 1)}
              >
                {t("recheck")}
              </button>
            </div>
            {service.phase === "running" ? (
              <p className="reme-settings-muted">
                {service.data?.managed
                  ? t("managedNote").replace(
                      "{pid}",
                      String(service.data?.pid ?? ""),
                    )
                  : t("foreignNote")}
              </p>
            ) : null}
            {service.phase === "conflict" ? (
              <p className="reme-settings-muted">{t("conflictNote")}</p>
            ) : null}
            {service.phase === "error" && service.error ? (
              <p className="reme-settings-error">
                {`${t("serviceError")}: ${service.error}`}
              </p>
            ) : null}
            <div className="reme-env-actions">
              {service.phase === "running" ? (
                confirmingStop ? (
                  <div className="reme-env-confirm">
                    <p>{t("stopConfirm")}</p>
                    <button
                      type="button"
                      className="reme-settings-save"
                      disabled={stopping}
                      onClick={() => void stopService()}
                    >
                      {t("stopService")}
                    </button>
                    <button
                      type="button"
                      className="reme-settings-discard"
                      onClick={() => setConfirmingStop(false)}
                    >
                      {t("cancel")}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="reme-settings-button"
                    disabled={stopping || !service.data?.managed}
                    onClick={() => setConfirmingStop(true)}
                  >
                    {t("stopService")}
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="reme-settings-save"
                  disabled={
                    service.phase === "starting" ||
                    !checkData?.installed ||
                    !selectedPath
                  }
                  onClick={() => void startService()}
                >
                  {t("startService")}
                </button>
              )}
              <button
                type="button"
                className="reme-settings-button"
                onClick={() => void viewLog()}
              >
                {t("viewLogs")}
              </button>
              <label className="reme-settings-check reme-env-check-inline">
                <input
                  type="checkbox"
                  checked={value?.autoStart === true}
                  onChange={(event) => {
                    if (!value || !snapshot.writable) return;
                    void scope
                      .mutate(
                        [
                          {
                            op: "set",
                            path: ["autoStart"],
                            value: event.target.checked,
                          },
                        ],
                        snapshot.revision,
                      )
                      .catch(() => undefined);
                  }}
                />
                <span>{t("autoStartLabel")}</span>
              </label>
            </div>
            {logView.open ? (
              <div className="reme-env-result">
                <p className="reme-settings-muted">
                  {`${t("envPath")}: ${logView.logPath}`}
                </p>
                <pre className="reme-env-log">
                  {logView.lines || t("logEmpty")}
                </pre>
                <button
                  type="button"
                  className="reme-settings-button"
                  onClick={() =>
                    setLogView({ open: false, lines: "", logPath: "" })
                  }
                >
                  {t("dismiss")}
                </button>
              </div>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}

const LLM_BACKENDS = [
  "openai",
  "dashscope",
  "deepseek",
  "anthropic",
  "gemini",
  "moonshot",
  "ollama",
  "xai",
] as const;
const EMBEDDING_BACKENDS = [
  "openai",
  "dashscope",
  "dashscope_multimodal",
  "gemini",
  "ollama",
] as const;

function envOptions(list: readonly string[], current: string): string[] {
  return current && !list.includes(current) ? [...list, current] : [...list];
}

function EnvField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div className="reme-settings-field">
      <label>{label}</label>
      {children}
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function parseEnvSummary(value: unknown): EnvSummary {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { entries?: unknown }).entries)
  )
    throw new Error("Invalid .env summary response");
  return value as unknown as EnvSummary;
}

function parseLlmResult(value: unknown): LlmTestResult {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid LLM test response");
  return value as unknown as LlmTestResult;
}

function parseServiceState(value: unknown): ServiceState {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { phase?: unknown }).phase !== "string"
  )
    throw new Error("Invalid service status response");
  return value as unknown as ServiceState;
}

function parseServiceStart(value: unknown): ServiceStartResult {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { started?: unknown }).started !== "boolean"
  )
    throw new Error("Invalid service start response");
  return value as unknown as ServiceStartResult;
}

function parseServiceLog(value: unknown): ServiceLog {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { lines?: unknown }).lines !== "string"
  )
    throw new Error("Invalid service log response");
  return value as unknown as ServiceLog;
}
