import type { StatusRpc } from "../../client/status-page.js";
import type {
  ConnectionHealth,
  EnvSummary,
  InstallStatus,
  LlmTestResult,
  PythonDetection,
  RemeCheck,
  ServiceLog,
  ServiceStartResult,
  ServiceState,
} from "../types.js";

/** Methods the Host exposes on the `remeEnv` wire namespace. */
export type EnvMethod =
  | "python"
  | "checkReme"
  | "install"
  | "installStatus"
  | "installCancel"
  | "readEnv"
  | "writeEnv"
  | "testLlm"
  | "health"
  | "serviceStatus"
  | "serviceStart"
  | "serviceStop"
  | "serviceLog";

/**
 * Call one environment method. DSH exposes the SRC gateway with a single plain
 * `input` parameter, so every call sends `{ args: { input } }`.
 */
export async function envCall(
  rpc: StatusRpc,
  method: EnvMethod,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await rpc.call(
    "/api",
    `remeEnv/${method}`,
    { args: { input } },
    signal,
  );
  if (!result.ok) throw new Error(result.error.message || result.error.code);
  return result.value;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null)
    throw new Error(`Invalid ${what} response`);
  return value as Record<string, unknown>;
}

/** Guard a detection payload: the interpreter list is what the tab needs. */
export function parseDetection(value: unknown): PythonDetection {
  const body = record(value, "environment detection");
  if (!Array.isArray(body.envs))
    throw new Error("Invalid environment detection response");
  return value as PythonDetection;
}

export function parseRemeCheck(value: unknown): RemeCheck {
  return record(value, "ReMe check") as unknown as RemeCheck;
}

/** `null` is the valid "no job yet" answer, so it is not an error. */
export function parseInstallStatus(value: unknown): InstallStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  return typeof body.id === "string" && typeof body.phase === "string"
    ? (value as unknown as InstallStatus)
    : null;
}

export function parseEnvSummary(value: unknown): EnvSummary {
  const body = record(value, ".env summary");
  if (!Array.isArray(body.entries))
    throw new Error("Invalid .env summary response");
  return value as unknown as EnvSummary;
}

export function parseLlmResult(value: unknown): LlmTestResult {
  return record(value, "LLM test") as unknown as LlmTestResult;
}

export function parseHealth(value: unknown): ConnectionHealth {
  const body = record(value, "health");
  if (typeof body.ok !== "boolean") throw new Error("Invalid health response");
  return value as unknown as ConnectionHealth;
}

export function parseServiceState(value: unknown): ServiceState {
  const body = record(value, "service status");
  if (typeof body.phase !== "string")
    throw new Error("Invalid service status response");
  return value as unknown as ServiceState;
}

export function parseServiceStart(value: unknown): ServiceStartResult {
  const body = record(value, "service start");
  if (typeof body.started !== "boolean")
    throw new Error("Invalid service start response");
  return value as unknown as ServiceStartResult;
}

export function parseServiceLog(value: unknown): ServiceLog {
  const body = record(value, "service log");
  if (typeof body.lines !== "string")
    throw new Error("Invalid service log response");
  return value as unknown as ServiceLog;
}
