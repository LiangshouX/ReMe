import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";

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
  killTree(pid: number): void;
  probePid(pid: number): void;
  /** OS image name of a pid, or "" when it cannot be read. */
  processImage(pid: number): Promise<string>;
  exists(path: string): boolean;
  platform: string;
}

/** Only loopback endpoints may be managed as a local service. */
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
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new TypeError("ReMe endpoint must be an http(s) URL");
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname))
    throw new TypeError(
      "Local service management requires a loopback endpoint",
    );
  const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
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

export function readServiceState(path: string): PersistedService | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PersistedService;
  } catch {
    return undefined;
  }
}

export function writeServiceState(path: string, state: PersistedService): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

function alive(io: ServiceIO, pid?: number): boolean {
  if (pid === undefined) return false;
  try {
    io.probePid(pid);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the recorded process is the service this plugin started for the
 * endpoint on screen. The saved endpoint must match the requested one, the pid
 * must still be alive, and its image must still be a Python (or `reme`)
 * executable, which is what a recycled pid would rarely be.
 */
export async function ownsService(
  io: ServiceIO,
  persisted: PersistedService | undefined,
  endpoint: string,
): Promise<boolean> {
  if (!persisted || persisted.pid === undefined) return false;
  if (persisted.endpoint.trim() !== endpoint.trim()) return false;
  if (!alive(io, persisted.pid)) return false;
  const image = (await io.processImage(persisted.pid)).toLowerCase();
  if (image === "") return true;
  return /^(reme|python|py)/.test(image);
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
  if (health.ok) {
    const managed = await ownsService(io, persisted, options.endpoint);
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
  const { host, port } = parseLocalEndpoint(options.endpoint);
  if (await io.portOpen(host, port))
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
    ...(persisted?.pid === undefined ? {} : { pid: persisted.pid }),
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
  mkdirSync(options.workspaceDir, { recursive: true });
  const command = buildStartCommand({
    cliPath: options.cliPath,
    pythonPath: options.pythonPath,
    workspaceDir: options.workspaceDir,
    endpoint: options.endpoint,
    disableDreamCron: options.disableDreamCron,
    exists: io.exists,
  });
  const startedAt = new Date().toISOString();
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
  writeServiceState(options.statePath, {
    pid: child.pid,
    endpoint: options.endpoint,
    workspaceDir: options.workspaceDir,
    pythonPath: options.pythonPath,
    command: command.display,
    startedAt,
  });
  return {
    started: true,
    alreadyRunning: false,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    command: command.display,
    logPath: options.logPath,
    startedAt,
  };
}

/**
 * Stop the service this plugin started for the endpoint, and only that one: a
 * service on another port, or a foreign process, is left running.
 */
export async function stopService(
  io: ServiceIO,
  options: { statePath: string; endpoint: string },
): Promise<ServiceStopResult> {
  const persisted = readServiceState(options.statePath);
  if (!persisted || persisted.pid === undefined)
    return { stopped: false, reason: "No service started by this plugin" };
  if (!(await ownsService(io, persisted, options.endpoint)))
    return {
      stopped: false,
      reason: "The recorded service does not belong to this endpoint",
    };
  const pid = persisted.pid;
  try {
    io.killTree(pid);
  } catch {
    // Already exited.
  }
  try {
    rmSync(options.statePath, { force: true });
  } catch {
    // A stale state file is harmless; the next start overwrites it.
  }
  return { stopped: true, pid };
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
    killTree(pid) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        return;
      }
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already exited.
      }
    },
    probePid(pid) {
      process.kill(pid, 0);
    },
    processImage(pid) {
      return new Promise((resolve) => {
        if (process.platform === "win32") {
          execFile(
            "tasklist",
            ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
            { windowsHide: true },
            (error, stdout) => {
              const match = /^"([^"]+)"/.exec(String(stdout ?? "").trim());
              resolve(error ? "" : match?.[1] ?? "");
            },
          );
          return;
        }
        execFile("ps", ["-p", String(pid), "-o", "comm="], (error, stdout) =>
          resolve(error ? "" : String(stdout ?? "").trim()),
        );
      });
    },
    exists: existsSync,
    platform: process.platform,
  };
}
