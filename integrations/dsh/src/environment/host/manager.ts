import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { safeError } from "../../endpoint.js";
import { detectPythonEnvs } from "./detect.js";
import { createInstallSpawner, InstallJobs, tailLog } from "./install.js";
import { checkReme, MINIMUM_REME, remeVersionAtLeast } from "./reme.js";
import { createNodeRunner } from "./runner.js";
import {
  createServiceIO,
  processAlive,
  readServiceState,
  removeServiceState,
  serviceEndpointKey,
  serviceOwnership,
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
    // A malformed record must not turn the log path into a relative one.
    let logDir = resolveWorkspaceDir("", homedir());
    const recordedDir = persisted?.workspaceDir?.trim() ?? "";
    if (recordedDir) {
      try {
        logDir = resolveWorkspaceDir(recordedDir, homedir());
      } catch {
        // Keep the default log directory.
      }
    }
    const status = await serviceStatus(this.serviceIO, {
      endpoint: endpointValue,
      statePath: this.serviceStatePath,
      authToken,
      logPath: join(logDir, "service.log"),
    });
    if (this.starting?.endpoint === endpointValue) {
      // Running and conflict both mean the port answered: the launch is no
      // longer "in flight". Stopped without a live pid means it died before it
      // ever listened, so a retry must not be blocked either. A stopped status
      // *with* a pid is a service still booting.
      if (
        status.phase === "running" ||
        status.phase === "conflict" ||
        (status.phase === "stopped" && status.pid === undefined)
      )
        this.starting = undefined;
    }
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

  /**
   * Stop the plugin-managed service; a foreign service stays untouched. Stop
   * joins the start queue, so a request that arrives while a launch is still
   * being recorded waits for it and then stops that launch instead of
   * reporting "nothing started".
   */
  serviceStop(endpoint: string): Promise<ServiceStopResult> {
    const endpointValue = this.endpoint(endpoint);
    const run = this.startQueue.then(() => this.stopLocked(endpointValue));
    this.startQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
    if (url.username || url.password)
      throw new TypeError("ReMe endpoint must not contain credentials");
    if (url.search || url.hash)
      throw new TypeError(
        "ReMe endpoint must not contain a query string or fragment",
      );
    // The client appends job names to the endpoint, so it never keeps a
    // trailing slash; normalising here is what makes records comparable.
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  }

  private async stopLocked(endpointValue: string): Promise<ServiceStopResult> {
    const result = await stopService(this.serviceIO, {
      statePath: this.serviceStatePath,
      endpoint: endpointValue,
    });
    if (result.stopped && this.starting?.endpoint === endpointValue)
      this.starting = undefined;
    return result;
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
    const starting = this.starting;
    if (starting && Date.now() - starting.at < START_GRACE_MS) {
      if (starting.endpoint === endpointValue)
        // A genuine launch is in flight. Observing it is not an error: the
        // client keeps polling just as the first request does.
        return {
          started: false,
          alreadyRunning: true,
          command: "",
          logPath,
          startedAt: now,
        };
      // The service record is per install, not per endpoint; spawning a second
      // endpoint's service now would overwrite the first one's record and
      // orphan it.
      return {
        started: false,
        alreadyRunning: false,
        command: "",
        logPath,
        startedAt: now,
        error: `A service start for ${starting.endpoint} is still in progress`,
      };
    }
    this.starting = undefined;
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
    if (current.phase === "conflict") {
      // The port is answered by something that is not a healthy service. A
      // provable launch of ours (still booting or rejecting our token) is
      // stopped and replaced; anything else is left alone.
      if (!current.managed)
        return {
          started: false,
          alreadyRunning: false,
          command: "",
          logPath,
          startedAt: now,
          error: "Another process is already listening on this endpoint",
        };
      const previous = await stopService(this.serviceIO, {
        statePath: this.serviceStatePath,
        endpoint: endpointValue,
        ownership: "owned",
      });
      if (!previous.stopped)
        return {
          started: false,
          alreadyRunning: false,
          command: "",
          logPath,
          startedAt: now,
          error: `A previous launch could not be stopped: ${
            previous.reason ?? "unknown reason"
          }`,
        };
    }
    // A record for a *different* endpoint that is still alive would be
    // overwritten by the new launch, leaving that endpoint unable to stop it.
    // Only a provably owned process blocks the new start; an unprovable record
    // is stale and is discarded, just like the same-endpoint case below.
    const recorded = readServiceState(this.serviceStatePath);
    if (
      recorded &&
      recorded.pid !== undefined &&
      serviceEndpointKey(recorded.endpoint) !==
        serviceEndpointKey(endpointValue) &&
      processAlive(this.serviceIO, recorded.pid)
    ) {
      const other = await serviceOwnership(
        this.serviceIO,
        recorded,
        recorded.endpoint,
      );
      if (other === "owned")
        return {
          started: false,
          alreadyRunning: false,
          command: "",
          logPath,
          startedAt: now,
          error: `A service for ${recorded.endpoint} is still running; stop it from that endpoint first`,
        };
      removeServiceState(this.serviceStatePath);
    }
    // A previous launch that never became healthy may still be alive. Stop it
    // when ownership is proven; when it cannot be proven, drop the stale record
    // without killing anything so a recycled pid is never touched.
    if (current.pid !== undefined) {
      const ownership = await serviceOwnership(
        this.serviceIO,
        recorded,
        endpointValue,
      );
      if (ownership === "owned") {
        const previous = await stopService(this.serviceIO, {
          statePath: this.serviceStatePath,
          endpoint: endpointValue,
          ownership,
        });
        if (!previous.stopped)
          return {
            started: false,
            alreadyRunning: false,
            command: "",
            logPath,
            startedAt: now,
            error: `A previous launch could not be stopped: ${
              previous.reason ?? "unknown reason"
            }`,
          };
      } else {
        removeServiceState(this.serviceStatePath);
      }
    }
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
    if (!check.versionOk)
      return {
        started: false,
        alreadyRunning: false,
        command: "",
        logPath,
        startedAt: now,
        error: `reme-ai ${
          check.version || "(unknown version)"
        } is older than ${MINIMUM_REME}; upgrade it first`,
      };
    // Set before the spawn so a second request arriving while the service is
    // booting observes the first launch instead of spawning another one. It is
    // cleared again when the spawn fails, so a retry is possible immediately.
    this.starting = { endpoint: endpointValue, at: Date.now() };
    try {
      const result = await startService(this.serviceIO, {
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
      if (!result.started) this.starting = undefined;
      return result;
    } catch (error) {
      this.starting = undefined;
      return {
        started: false,
        alreadyRunning: false,
        command: "",
        logPath,
        startedAt: now,
        error: `Could not start the ReMe service: ${safeError(error)}`,
      };
    }
  }
}
