import { spawn } from "node:child_process";
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

import type { ServiceStartResult, ServiceState } from "../types.js";

export interface PersistedService {
  pid?: number;
  endpoint: string;
  workspaceDir: string;
  pythonPath: string;
  command: string;
  startedAt: string;
}

export interface ServiceIO {
  fetchHealth(endpoint: string): Promise<{ ok: boolean; version: string }>;
  portOpen(host: string, port: number): Promise<boolean>;
  spawnService(options: {
    exe: string;
    args: string[];
    cwd: string;
    logPath: string;
    env: NodeJS.ProcessEnv;
  }): { pid: number | undefined };
  killTree(pid: number): void;
  probePid(pid: number): void;
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

/** Running / conflict / stopped, with ownership of the running process. */
export async function serviceStatus(
  io: ServiceIO,
  options: { endpoint: string; statePath: string; logPath: string },
): Promise<ServiceState> {
  const health = await io.fetchHealth(options.endpoint);
  const persisted = readServiceState(options.statePath);
  if (health.ok)
    return {
      phase: "running",
      managed: alive(io, persisted?.pid),
      endpoint: options.endpoint,
      ...(persisted?.pid === undefined ? {} : { pid: persisted.pid }),
      ...(health.version ? { version: health.version } : {}),
      ...(persisted?.startedAt === undefined
        ? {}
        : { startedAt: persisted.startedAt }),
      logPath: options.logPath,
    };
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

/** Spawn a detached service; the caller polls status until it is healthy. */
export function startService(
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
): ServiceStartResult {
  mkdirSync(options.workspaceDir, { recursive: true });
  const command = buildStartCommand({
    cliPath: options.cliPath,
    pythonPath: options.pythonPath,
    workspaceDir: options.workspaceDir,
    endpoint: options.endpoint,
    disableDreamCron: options.disableDreamCron,
    exists: io.exists,
  });
  const child = io.spawnService({
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
  const startedAt = new Date().toISOString();
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

/** Stop the managed service (tree kill) and clear its state file. */
export function stopService(
  io: ServiceIO,
  options: { statePath: string },
): { stopped: boolean; pid?: number } {
  const persisted = readServiceState(options.statePath);
  if (!persisted || persisted.pid === undefined) return { stopped: false };
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
    async fetchHealth(endpoint) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`${endpoint}/health_check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => ({}))) as {
          success?: boolean;
          metadata?: { health?: { version?: unknown } };
        };
        const version = body.metadata?.health?.version;
        return {
          ok: response.ok && body.success !== false,
          version: typeof version === "string" ? version : "",
        };
      } catch {
        return { ok: false, version: "" };
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
    spawnService({ exe, args, cwd, logPath, env }) {
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
      } finally {
        closeSync(fd);
      }
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
    exists: existsSync,
    platform: process.platform,
  };
}
