import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { detectPythonEnvs } from "./detect.js";
import {
  createInstallSpawner,
  InstallJobs,
  tailLog,
} from "./install.js";
import { checkReme, remeVersionAtLeast } from "./reme.js";
import { createNodeRunner } from "./runner.js";
import {
  createServiceIO,
  readServiceState,
  serviceStatus,
  startService,
  stopService,
} from "./service.js";
import type { ServiceIO } from "./service.js";
import {
  envSummary,
  parseEnvFile,
  resolveWorkspaceDir,
  testLlm,
  validateEnvUpdate,
  writeEnvFile,
} from "./workspace.js";
import type {
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

const CACHE_MS = 60_000;

/**
 * Host-side local environment manager: read-only Python detection plus the
 * reme-ai dependency check and the one-click pip install job.
 */
export class ReMeEnvManager {
  private cache?: { at: number; detection: PythonDetection };
  private readonly installs: InstallJobs;
  private readonly env: NodeJS.ProcessEnv;
  private readonly serviceIO: ServiceIO = createServiceIO();
  private readonly serviceStatePath: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
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

  /** Masked .env projection for the selected workspace. */
  readEnv(workspaceDir: string): EnvSummary {
    const dir = resolveWorkspaceDir(workspaceDir, homedir());
    return envSummary(join(dir, ".env"), dir);
  }

  /**
   * Merge edited values into the workspace .env. Validation covers the whole
   * effective file, so an untouched real key still satisfies the requirement.
   */
  writeEnv(workspaceDir: string, values: Record<string, string>): EnvSummary {
    const dir = resolveWorkspaceDir(workspaceDir, homedir());
    const path = join(dir, ".env");
    let existing: Record<string, string> = {};
    try {
      existing = parseEnvFile(readFileSync(path, "utf8"));
    } catch {
      // First write creates the file.
    }
    validateEnvUpdate({ ...existing, ...values });
    writeEnvFile(path, values);
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

  /** Current service phase (running / conflict / stopped) and ownership. */
  async serviceStatus(endpoint: string): Promise<ServiceState> {
    const endpointValue = endpoint.trim() || "http://127.0.0.1:2333";
    const persisted = readServiceState(this.serviceStatePath);
    return serviceStatus(this.serviceIO, {
      endpoint: endpointValue,
      statePath: this.serviceStatePath,
      logPath: join(
        persisted?.workspaceDir ?? resolveWorkspaceDir("", homedir()),
        "service.log",
      ),
    });
  }

  /** Spawn `reme start` detached; the caller polls serviceStatus. */
  async serviceStart(
    endpoint: string,
    pythonPath: string,
    workspaceDir: string,
  ): Promise<ServiceStartResult> {
    const endpointValue = endpoint.trim() || "http://127.0.0.1:2333";
    const dir = resolveWorkspaceDir(workspaceDir, homedir());
    const logPath = join(dir, "service.log");
    const now = new Date().toISOString();
    const current = await this.serviceStatus(endpointValue);
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

  /** Stop the plugin-managed service; a foreign service stays untouched. */
  serviceStop(_endpoint: string): { stopped: boolean; pid?: number } {
    return stopService(this.serviceIO, { statePath: this.serviceStatePath });
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
  }): Promise<void> {
    const status = await this.serviceStatus(options.endpoint);
    if (status.phase === "running") return;
    let pythonPath = options.pythonPath.trim();
    if (!pythonPath) {
      const detection = await this.detectPython();
      pythonPath = detection.suggested;
    }
    if (!pythonPath) return;
    await this.serviceStart(options.endpoint, pythonPath, options.workspaceDir);
  }
}
