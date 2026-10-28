import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { detectPythonEnvs } from "./detect.js";
import { createInstallSpawner, InstallJobs, tailLog } from "./install.js";
import { checkReme, remeVersionAtLeast } from "./reme.js";
import { createNodeRunner } from "./runner.js";
import {
  createServiceIO,
  readServiceState,
  serviceStatus,
  startService,
  stopService,
} from "./service.js";
import type { ServiceIO, ServiceStopResult } from "./service.js";
import {
  envSummary,
  mergeEnvFile,
  parseEnvFile,
  resolveWorkspaceDir,
  testLlm,
  validateEnvUpdate,
  writeEnvText,
} from "./workspace.js";
import type {
  ConnectionHealth,
  EnvSummary,
  InstallRequest,
  InstallStatus,
  LlmTestResult,
  PythonDetection,
  RemeCheck,
  ServiceLog,
  ServiceStartResult,
  ServiceState,
} from "../types.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:2333";
const CACHE_MS = 60_000;
/** How long a spawn is treated as "already starting" while it comes up. */
const START_GRACE_MS = 120_000;

/**
 * Host-side environment manager: the one place that runs local operations and
 * hands the results to the gateway.
 *
 * Everything here runs on the machine DSH runs on, so the tab and the Host can
 * never disagree about which Python, which `.env` or which service "local"
 * means. Lifetimes are explicit:
 *
 * - Python probes and reme-ai checks are bounded one-shot commands (`timeoutMs`).
 * - A pip installation is a job in this manager's registry; {@link dispose}
 *   stops the ones still running when the plugin unloads, and its log survives
 *   in `$DSH_HOME/reme-memory`.
 * - The ReMe service is detached on purpose: it must outlive DSH, so it is not
 *   handed to DSH's subprocess provider, which kills its children on Host exit.
 *   It is stopped only through the ownership-checked adapter in `service.ts`.
 */
export class ReMeEnvManager {
  private cache?: { at: number; detection: PythonDetection };
  private readonly installs: InstallJobs;
  private readonly env: NodeJS.ProcessEnv;
  private readonly serviceIO: ServiceIO;
  private readonly serviceStatePath: string;
  /** Serializes starts so two requests cannot spawn two services. */
  private startQueue: Promise<unknown> = Promise.resolve();
  private starting?: { endpoint: string; at: number };

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    serviceIO: ServiceIO = createServiceIO(),
  ) {
    this.env = env;
    this.serviceIO = serviceIO;
    const home = env.DSH_HOME?.trim() || join(homedir(), ".dsh");
    this.installs = new InstallJobs({
      spawner: createInstallSpawner(env),
      logDir: join(home, "reme-memory"),
    });
    this.serviceStatePath = join(home, "reme-memory", "service.json");
  }

  async detectPython(
    options: { refresh?: boolean } = {},
  ): Promise<PythonDetection> {
    if (!options.refresh && this.cache && Date.now() - this.cache.at < CACHE_MS)
      return this.cache.detection;
    const detection = await detectPythonEnvs({
      run: createNodeRunner(this.env),
      platform: process.platform,
      env: this.env,
      homedir: homedir(),
      exists: existsSync,
    });
    this.cache = { at: Date.now(), detection };
    return detection;
  }

  async checkReme(pythonPath: string): Promise<RemeCheck> {
    return checkReme(
      {
        run: createNodeRunner(this.env),
        platform: process.platform,
        exists: existsSync,
      },
      pythonPath,
    );
  }

  install(request: InstallRequest): InstallStatus {
    return this.installs.start(request);
  }

  installStatus(jobId?: string): InstallStatus | null {
    return this.installs.status(jobId);
  }

  installCancel(jobId?: string): boolean {
    return this.installs.cancel(jobId);
  }

  /** Stop the installations this manager owns, on plugin disposal. */
  dispose(): void {
    this.installs.dispose();
  }

  /** Masked .env projection for the selected workspace. */
  readEnv(workspaceDir: string): EnvSummary {
    const dir = resolveWorkspaceDir(workspaceDir, homedir());
    return envSummary(join(dir, ".env"), dir);
  }

  /**
   * Merge edited values into the workspace .env. The whole merged file is
   * validated, so an untouched real key still satisfies the requirement and a
   * cleared one fails here rather than at the next service start.
   */
  writeEnv(workspaceDir: string, values: Record<string, string>): EnvSummary {
    const dir = resolveWorkspaceDir(workspaceDir, homedir());
    const path = join(dir, ".env");
    let existing = "";
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      // First write creates the file.
    }
    const merged = mergeEnvFile(existing, values);
    validateEnvUpdate(parseEnvFile(merged));
    writeEnvText(path, merged);
    return envSummary(path, dir);
  }

  /** One-off LLM connectivity probe reading the workspace .env. */
  async testLlm(
    workspaceDir: string,
    pythonPath: string,
  ): Promise<LlmTestResult> {
    const dir = resolveWorkspaceDir(workspaceDir, homedir());
    return testLlm(
      { run: createNodeRunner(this.env) },
      { workspaceDir: dir, pythonPath },
    );
  }

  /** Whether the configured ReMe endpoint answers, probed from this Host. */
  async health(endpoint: string, authToken = ""): Promise<ConnectionHealth> {
    const endpointValue = this.endpoint(endpoint);
    const health = await this.serviceIO.fetchHealth(endpointValue, authToken);
    return {
      endpoint: endpointValue,
      ok: health.ok,
      version: health.version,
      error: health.error,
      checkedAt: new Date().toISOString(),
    };
  }

  /** Current service phase (running / conflict / stopped) and ownership. */
  async serviceStatus(endpoint: string, authToken = ""): Promise<ServiceState> {
    const endpointValue = this.endpoint(endpoint);
    const persisted = readServiceState(this.serviceStatePath);
    const status = await serviceStatus(this.serviceIO, {
      endpoint: endpointValue,
      statePath: this.serviceStatePath,
      authToken,
      logPath: join(
        persisted?.workspaceDir ?? resolveWorkspaceDir("", homedir()),
        "service.log",
      ),
    });
    if (status.phase === "running" && this.starting?.endpoint === endpointValue)
      this.starting = undefined;
    return status;
  }

  /**
   * Spawn `reme start` detached; the caller polls serviceStatus. Starts are
   * serialized and re-check the phase inside the lock, so two requests cannot
   * spawn two services and overwrite the one recorded pid.
   */
  serviceStart(
    endpoint: string,
    pythonPath: string,
    workspaceDir: string,
    authToken = "",
  ): Promise<ServiceStartResult> {
    const run = this.startQueue.then(() =>
      this.startLocked(endpoint, pythonPath, workspaceDir, authToken),
    );
    this.startQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Stop the plugin-managed service; a foreign service stays untouched. */
  async serviceStop(endpoint: string): Promise<ServiceStopResult> {
    const result = await stopService(this.serviceIO, {
      statePath: this.serviceStatePath,
      endpoint: this.endpoint(endpoint),
    });
    if (result.stopped) this.starting = undefined;
    return result;
  }

  /** Tail of the workspace service log. */
  serviceLog(workspaceDir: string): ServiceLog {
    const dir = resolveWorkspaceDir(workspaceDir, homedir());
    const logPath = join(dir, "service.log");
    return { logPath, lines: tailLog(logPath, 40) };
  }

  /** DSH-startup best effort: start a stopped local service when configured. */
  async autoStart(options: {
    endpoint: string;
    pythonPath: string;
    workspaceDir: string;
    authToken?: string;
  }): Promise<void> {
    const status = await this.serviceStatus(
      options.endpoint,
      options.authToken ?? "",
    );
    if (status.phase === "running") return;
    let pythonPath = options.pythonPath.trim();
    if (!pythonPath) {
      const detection = await this.detectPython();
      pythonPath = detection.suggested;
    }
    if (!pythonPath) return;
    await this.serviceStart(
      options.endpoint,
      pythonPath,
      options.workspaceDir,
      options.authToken ?? "",
    );
  }

  private endpoint(raw: string): string {
    const value = raw.trim() || DEFAULT_ENDPOINT;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError("Invalid ReMe endpoint");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new TypeError("ReMe endpoint must be an http(s) URL");
    return value;
  }

  private async startLocked(
    endpoint: string,
    pythonPath: string,
    workspaceDir: string,
    authToken: string,
  ): Promise<ServiceStartResult> {
    const endpointValue = this.endpoint(endpoint);
    const dir = resolveWorkspaceDir(workspaceDir, homedir());
    const logPath = join(dir, "service.log");
    const now = new Date().toISOString();
    if (
      this.starting?.endpoint === endpointValue &&
      Date.now() - this.starting.at < START_GRACE_MS
    )
      return {
        started: false,
        alreadyRunning: true,
        command: "",
        logPath,
        startedAt: now,
      };
    const current = await this.serviceStatus(endpointValue, authToken);
    if (current.phase === "running")
      return {
        started: false,
        alreadyRunning: true,
        command: "",
        logPath,
        startedAt: now,
        ...(current.version ? { version: current.version } : {}),
      };
    const path = pythonPath.trim();
    if (!path)
      return {
        started: false,
        alreadyRunning: false,
        command: "",
        logPath,
        startedAt: now,
        error: "Select a Python interpreter first",
      };
    const check = await this.checkReme(path);
    if (!check.installed)
      return {
        started: false,
        alreadyRunning: false,
        command: "",
        logPath,
        startedAt: now,
        error: "reme-ai is not installed in the selected interpreter",
      };
    this.starting = { endpoint: endpointValue, at: Date.now() };
    return startService(this.serviceIO, {
      endpoint: endpointValue,
      workspaceDir: dir,
      pythonPath: path,
      cliPath: check.cliPath,
      // 0.4.0.x has no jobs.<name>.enabled; only newer releases accept it.
      disableDreamCron: remeVersionAtLeast(check.version, "0.4.1"),
      statePath: this.serviceStatePath,
      logPath,
      env: this.env,
    });
  }
}
