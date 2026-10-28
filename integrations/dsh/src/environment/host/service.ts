import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname } from "node:path";

import { safeError } from "../../endpoint.js";
import type { ServiceStartResult, ServiceState } from "../types.js";

/**
 * The local ReMe service is a *detached* process: it outlives DSH, which is the
 * point of starting it from here, so it is deliberately not owned by DSH's
 * subprocess provider (that provider terminates its children on Host exit).
 * This module is the small service adapter that owns that lifetime instead:
 * it spawns the process, records the pid in a state file, verifies ownership
 * before reporting or stopping it, and tree-kills it on request.
 */

export interface PersistedService {
  pid?: number;
  endpoint: string;
  workspaceDir: string;
  pythonPath: string;
  command: string;
  startedAt: string;
}

export interface ServiceHealth {
  ok: boolean;
  version: string;
  /** Non-empty when the endpoint answered but not as a ReMe service. */
  error: string;
}

export interface ServiceStopResult {
  stopped: boolean;
  pid?: number;
  /** Why an unmanaged or missing service was left alone. */
  reason?: string;
}

export interface ServiceIO {
  fetchHealth(endpoint: string, authToken: string): Promise<ServiceHealth>;
  portOpen(host: string, port: number): Promise<boolean>;
  spawnService(options: {
    exe: string;
    args: string[];
    cwd: string;
    logPath: string;
    env: NodeJS.ProcessEnv;
  }): Promise<{ pid: number | undefined }>;
  /**
   * Ask the process, and its process group on POSIX, to stop. `force`
   * escalates to `SIGKILL` (always `/F` on Windows).
   */
  killTree(pid: number, force?: boolean): void;
  probePid(pid: number): void;
  /** OS image name of a pid, or "" when it cannot be read. */
  processImage(pid: number): Promise<string>;
  exists(path: string): boolean;
  platform: string;
}

/** A pid we are willing to signal: > 1, so kill(0)/kill(-1) is impossible. */
export function isValidPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

/**
 * Canonical identity of an endpoint for service-record matching. Loopback
 * aliases and default ports compare equal, so saving `localhost:2333` does not
 * make the service this plugin started on `127.0.0.1:2333` look foreign.
 */
export function serviceEndpointKey(endpoint: string): string {
  try {
    const url = new URL(endpoint.trim());
    const hostname = url.hostname.toLowerCase();
    const host = hostname === "localhost" ? "127.0.0.1" : hostname;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${host}:${port}${path}`;
  } catch {
    return endpoint.trim();
  }
}

/** Only loopback HTTP endpoints may be managed as a local service. */
export function parseLocalEndpoint(endpoint: string): {
  host: string;
  port: number;
} {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new TypeError("Invalid ReMe endpoint");
  }
  // The service this plugin launches is plain HTTP, so an https loopback URL
  // could never become healthy and must not be offered as manageable.
  if (url.protocol !== "http:")
    throw new TypeError(
      "Local service management requires an http:// endpoint",
    );
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname))
    throw new TypeError(
      "Local service management requires a loopback endpoint",
    );
  const port = Number(url.port || "80");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new TypeError("Invalid ReMe endpoint port");
  return { host: "127.0.0.1", port };
}

/**
 * Compose the `reme start` invocation. The working directory must be the
 * workspace so ReMe's `.env` discovery (cwd plus five parents) finds the file
 * the Environment tab writes.
 */
export function buildStartCommand(options: {
  cliPath: string;
  pythonPath: string;
  workspaceDir: string;
  endpoint: string;
  disableDreamCron: boolean;
  exists(path: string): boolean;
}): { exe: string; args: string[]; display: string } {
  const { port } = parseLocalEndpoint(options.endpoint);
  const args = [
    "start",
    `workspace_dir=${options.workspaceDir}`,
    "service.host=127.0.0.1",
    `service.port=${port}`,
    // Keeps the rich logo from crashing GBK consoles in the background.
    "enable_logo=false",
    ...(options.disableDreamCron ? ["jobs.dream_cron.enabled=false"] : []),
  ];
  if (options.cliPath && options.exists(options.cliPath))
    return {
      exe: options.cliPath,
      args,
      display: `${options.cliPath} ${args.join(" ")}`,
    };
  // The console script is missing (e.g. a bare venv without Scripts entry):
  // run the same CLI entry through the interpreter itself.
  const wrapper = `import sys;sys.argv=${JSON.stringify([
    "reme",
    ...args,
  ])};from reme.reme import main;sys.exit(main())`;
  return {
    exe: options.pythonPath,
    args: ["-c", wrapper],
    display: `${options.pythonPath} -c <reme wrapper>`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a record defensively: a malformed file is "no record", not a crash. */
export function readServiceState(path: string): PersistedService | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const endpoint = typeof value.endpoint === "string" ? value.endpoint : "";
  if (!endpoint.trim()) return undefined;
  return {
    ...(isValidPid(value.pid) ? { pid: value.pid } : {}),
    endpoint,
    workspaceDir:
      typeof value.workspaceDir === "string" ? value.workspaceDir : "",
    pythonPath: typeof value.pythonPath === "string" ? value.pythonPath : "",
    command: typeof value.command === "string" ? value.command : "",
    startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
  };
}

export function writeServiceState(path: string, state: PersistedService): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function clearServiceState(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A stale state file is retried by the next status read.
  }
}

function alive(io: ServiceIO, pid?: number): boolean {
  if (!isValidPid(pid)) return false;
  try {
    io.probePid(pid);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether an OS image name is a process that could be running the ReMe
 * service: an exact Python-family name or `reme`, never a prefix match (which
 * would accept e.g. `pycharm64.exe`).
 */
export function isServiceImage(image: string): boolean {
  const name = basename(image.trim().replaceAll("\\", "/")).toLowerCase();
  return /^(python|pythonw|reme)([0-9.]*)?(\.exe)?$/.test(name);
}

/**
 * Whether the recorded process is the service this plugin started for the
 * endpoint on screen. The saved endpoint must match the requested one, the pid
 * must still be alive, and its image must still be a Python (or `reme`)
 * executable, which is what a recycled pid would rarely be.
 *
 * This guards a destructive operation, so it fails *closed*: an unreadable
 * image is not proof of ownership.
 */
export async function ownsService(
  io: ServiceIO,
  persisted: PersistedService | undefined,
  endpoint: string,
): Promise<boolean> {
  if (!persisted || !isValidPid(persisted.pid)) return false;
  if (serviceEndpointKey(persisted.endpoint) !== serviceEndpointKey(endpoint))
    return false;
  if (!alive(io, persisted.pid)) return false;
  const image = await io.processImage(persisted.pid);
  if (!image.trim()) return false;
  return isServiceImage(image);
}

/** Running / conflict / stopped, with ownership of the running process. */
export async function serviceStatus(
  io: ServiceIO,
  options: {
    endpoint: string;
    statePath: string;
    logPath: string;
    authToken?: string;
  },
): Promise<ServiceState> {
  const health = await io.fetchHealth(
    options.endpoint,
    options.authToken ?? "",
  );
  const persisted = readServiceState(options.statePath);
  const recordForEndpoint =
    persisted !== undefined &&
    serviceEndpointKey(persisted.endpoint) ===
      serviceEndpointKey(options.endpoint);
  const recordAlive = alive(io, persisted?.pid);
  // A record whose process is gone must not be reported, or a later start
  // would keep seeing a stale pid. Remove it while nobody can be relying on it.
  if (persisted && !recordAlive) clearServiceState(options.statePath);
  if (health.ok) {
    const managed =
      recordForEndpoint &&
      recordAlive &&
      (await ownsService(io, persisted, options.endpoint));
    return {
      phase: "running",
      managed,
      endpoint: options.endpoint,
      ...(managed && persisted?.pid !== undefined
        ? { pid: persisted.pid }
        : {}),
      ...(health.version ? { version: health.version } : {}),
      ...(managed && persisted ? { startedAt: persisted.startedAt } : {}),
      logPath: options.logPath,
    };
  }
  let portOpen = false;
  try {
    const { host, port } = parseLocalEndpoint(options.endpoint);
    portOpen = await io.portOpen(host, port);
  } catch {
    // A remote or https endpoint is health-checked only; it has no local port.
  }
  if (portOpen)
    return {
      phase: "conflict",
      managed: false,
      endpoint: options.endpoint,
      logPath: options.logPath,
    };
  return {
    phase: "stopped",
    managed: false,
    endpoint: options.endpoint,
    // A live record for this endpoint means a launch that never became
    // healthy; the manager stops it before spawning a replacement.
    ...(recordForEndpoint && recordAlive && persisted?.pid !== undefined
      ? { pid: persisted.pid }
      : {}),
    logPath: options.logPath,
  };
}

/**
 * Spawn a detached service; the caller polls status until it is healthy. The
 * launch is recorded only once the OS acknowledged the spawn, so a missing
 * interpreter leaves no state file behind for a later tab to adopt.
 */
export async function startService(
  io: ServiceIO,
  options: {
    endpoint: string;
    workspaceDir: string;
    pythonPath: string;
    cliPath: string;
    disableDreamCron: boolean;
    statePath: string;
    logPath: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<ServiceStartResult> {
  const startedAt = new Date().toISOString();
  let command: { exe: string; args: string[]; display: string };
  try {
    mkdirSync(options.workspaceDir, { recursive: true });
    command = buildStartCommand({
      cliPath: options.cliPath,
      pythonPath: options.pythonPath,
      workspaceDir: options.workspaceDir,
      endpoint: options.endpoint,
      disableDreamCron: options.disableDreamCron,
      exists: io.exists,
    });
  } catch (error) {
    return {
      started: false,
      alreadyRunning: false,
      command: "",
      logPath: options.logPath,
      startedAt,
      error: `Could not start the ReMe service: ${safeError(error)}`,
    };
  }
  let child: { pid: number | undefined };
  try {
    child = await io.spawnService({
      exe: command.exe,
      args: command.args,
      cwd: options.workspaceDir,
      logPath: options.logPath,
      env: {
        ...options.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        NO_PROXY: "localhost,127.0.0.1,::1",
      },
    });
  } catch (error) {
    return {
      started: false,
      alreadyRunning: false,
      command: command.display,
      logPath: options.logPath,
      startedAt,
      error: `Could not start the ReMe service: ${safeError(error)}`,
    };
  }
  try {
    writeServiceState(options.statePath, {
      pid: child.pid,
      endpoint: options.endpoint,
      workspaceDir: options.workspaceDir,
      pythonPath: options.pythonPath,
      command: command.display,
      startedAt,
    });
  } catch (error) {
    // The process exists but could not be recorded; leaving it running would
    // make it unmanageable, so stop it before reporting the failure.
    try {
      if (child.pid !== undefined) io.killTree(child.pid, true);
    } catch {
      // Best effort: the error below already explains the launch failed.
    }
    return {
      started: false,
      alreadyRunning: false,
      command: command.display,
      logPath: options.logPath,
      startedAt,
      error: `Could not record the ReMe service: ${safeError(error)}`,
    };
  }
  return {
    started: true,
    alreadyRunning: false,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    command: command.display,
    logPath: options.logPath,
    startedAt,
  };
}

const STOP_TIMEOUT_MS = 5_000;
const STOP_FORCE_TIMEOUT_MS = 3_000;
const STOP_POLL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Poll until the pid disappears; true when it exited within `timeoutMs`. */
async function waitForExit(
  io: ServiceIO,
  pid: number,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!alive(io, pid)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.max(1, Math.min(pollMs, remaining)));
  }
}

/**
 * Stop the service this plugin started for the endpoint, and only that one: a
 * service on another port, or a foreign process, is left running.
 *
 * The record is removed only after the process is confirmed gone. Otherwise a
 * SIGTERM the service ignored would delete the pid, leaving a running process
 * that the tab can never stop again.
 */
export async function stopService(
  io: ServiceIO,
  options: {
    statePath: string;
    endpoint: string;
    /** Grace period before escalating to SIGKILL (tests shorten it). */
    timeoutMs?: number;
    forceTimeoutMs?: number;
    pollMs?: number;
  },
): Promise<ServiceStopResult> {
  const persisted = readServiceState(options.statePath);
  if (!persisted || !isValidPid(persisted.pid)) {
    if (persisted) clearServiceState(options.statePath);
    return { stopped: false, reason: "No service started by this plugin" };
  }
  if (!(await ownsService(io, persisted, options.endpoint)))
    return {
      stopped: false,
      reason: "The recorded service does not belong to this endpoint",
    };
  const pid = persisted.pid;
  const pollMs = options.pollMs ?? STOP_POLL_MS;
  try {
    io.killTree(pid);
  } catch {
    // Already exited.
  }
  if (
    await waitForExit(io, pid, options.timeoutMs ?? STOP_TIMEOUT_MS, pollMs)
  ) {
    clearServiceState(options.statePath);
    return { stopped: true, pid };
  }
  // The service ignored (or slowly handled) SIGTERM: escalate, then only drop
  // the record once the process is really gone.
  try {
    io.killTree(pid, true);
  } catch {
    // Already exited.
  }
  if (
    await waitForExit(
      io,
      pid,
      options.forceTimeoutMs ?? STOP_FORCE_TIMEOUT_MS,
      pollMs,
    )
  ) {
    clearServiceState(options.statePath);
    return { stopped: true, pid };
  }
  return {
    stopped: false,
    pid,
    reason: "The service did not exit after SIGKILL",
  };
}

/** Node-backed IO: fetch health, probe the port, spawn detached, tree-kill. */
export function createServiceIO(): ServiceIO {
  return {
    async fetchHealth(endpoint, authToken) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      try {
        const response = await fetch(`${endpoint}/health_check`, {
          method: "POST",
          headers,
          body: "{}",
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => ({}))) as {
          success?: boolean;
          metadata?: { health?: { version?: unknown } };
        };
        if (!response.ok)
          return { ok: false, version: "", error: `HTTP ${response.status}` };
        const health = body.metadata?.health;
        if (body.success === false)
          return { ok: false, version: "", error: "ReMe reported an error" };
        // A generic HTTP server answering 200 with `{}` is not ReMe.
        if (typeof health !== "object" || health === null)
          return {
            ok: false,
            version: "",
            error: "The endpoint did not answer with a ReMe health report",
          };
        const version = health.version;
        return {
          ok: true,
          version: typeof version === "string" ? version : "",
          error: "",
        };
      } catch (error) {
        return { ok: false, version: "", error: safeError(error) };
      } finally {
        clearTimeout(timer);
      }
    },
    portOpen(host, port) {
      return new Promise((resolve) => {
        const socket = createConnection({ host, port });
        const finish = (value: boolean): void => {
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(800);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
      });
    },
    async spawnService({ exe, args, cwd, logPath, env }) {
      const fd = openSync(logPath, "a");
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(exe, args, {
          shell: false,
          windowsHide: true,
          detached: true,
          cwd,
          env,
          stdio: ["ignore", fd, fd],
        });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", () => resolve());
          child.once("error", (error: Error) => reject(error));
        });
      } finally {
        // The child owns its inherited handle; the parent copy is no longer
        // needed, and an unref'd child survives this Host exiting.
        closeSync(fd);
      }
      // A failed executable is reported here rather than as an unhandled
      // `error` event that would exit the Host.
      child.on("error", () => undefined);
      child.unref();
      return { pid: child.pid };
    },
    killTree(pid, force = false) {
      if (!isValidPid(pid)) return;
      if (process.platform === "win32") {
        const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        // A spawn failure is an async event; without a listener it would exit
        // the Host.
        child.on("error", () => undefined);
        child.unref();
        return;
      }
      // The service was spawned detached, so it leads its own process group;
      // signalling the group stops pip's children too.
      const signal = force ? "SIGKILL" : "SIGTERM";
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Not a group leader (e.g. a record from an older launch).
      }
      try {
        process.kill(pid, signal);
      } catch {
        // Already exited.
      }
    },
    probePid(pid) {
      if (!isValidPid(pid))
        throw new RangeError("Refusing to probe an invalid pid");
      process.kill(pid, 0);
    },
    processImage(pid) {
      return new Promise((resolve) => {
        if (!isValidPid(pid)) {
          resolve("");
          return;
        }
        if (process.platform === "win32") {
          execFile(
            "tasklist",
            ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
            { windowsHide: true, timeout: 3000 },
            (error, stdout) => {
              const match = /^"([^"]+)"/.exec(String(stdout ?? "").trim());
              resolve(error ? "" : match?.[1] ?? "");
            },
          );
          return;
        }
        execFile(
          "ps",
          ["-p", String(pid), "-o", "comm="],
          { timeout: 3000 },
          (error, stdout) => resolve(error ? "" : String(stdout ?? "").trim()),
        );
      });
    },
    exists: existsSync,
    platform: process.platform,
  };
}
