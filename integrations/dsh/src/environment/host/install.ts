import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { InstallPhase, InstallRequest, InstallStatus } from "../types.js";
import { pathOf } from "./paths.js";

export interface InstallChild {
  pid: number | undefined;
  onExit(callback: (code: number | null) => void): void;
  kill(): void;
}

export interface InstallSpawner {
  start(options: {
    exe: string;
    args: string[];
    logPath: string;
  }): InstallChild;
}

/** Compose the pip invocation for `reme-ai[core]`. */
export function pipArgs(request: InstallRequest): string[] {
  const args = [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--no-input",
  ];
  if (request.upgrade) args.push("-U");
  const indexUrl = (request.indexUrl ?? "").trim();
  if (indexUrl) {
    if (!/^https?:\/\/\S+$/i.test(indexUrl))
      throw new TypeError("Package index must be an http(s) URL");
    args.push("--index-url", indexUrl);
  }
  args.push("reme-ai[core]");
  return args;
}

/** Last `maxLines` non-empty lines of a log file, normalized to "\n". */
export function tailLog(path: string, maxLines = 30, maxBytes = 8192): string {
  try {
    const buffer = readFileSync(path);
    const text = buffer
      .subarray(Math.max(0, buffer.length - maxBytes))
      .toString("utf8")
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(-maxLines)
      .join("\n");
  } catch {
    return "";
  }
}

/** Spawn pip with stdout/stderr appended to a per-job log file. */
export function createInstallSpawner(
  base: NodeJS.ProcessEnv = process.env,
): InstallSpawner {
  return {
    start({ exe, args, logPath }) {
      const fd = openSync(logPath, "a");
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(exe, args, {
          shell: false,
          windowsHide: true,
          env: {
            ...base,
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1",
            PYTHONUNBUFFERED: "1",
          },
          stdio: ["ignore", fd, fd],
        });
      } finally {
        // The child owns its inherited handle; the parent copy is no longer needed.
        closeSync(fd);
      }
      return {
        pid: child.pid,
        onExit(callback) {
          let settled = false;
          const finish = (code: number | null): void => {
            if (settled) return;
            settled = true;
            callback(code);
          };
          child.on("close", finish);
          child.on("error", () => finish(null));
        },
        kill() {
          if (child.pid !== undefined && process.platform === "win32") {
            // Tree-kill: pip's build backends are child processes.
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
            return;
          }
          try {
            child.kill("SIGTERM");
          } catch {
            // Already gone.
          }
        },
      };
    },
  };
}

interface Job {
  id: string;
  phase: InstallPhase;
  pythonPath: string;
  command: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  logPath: string;
  child: InstallChild;
  /** Set between a cancel request and the pip process actually exiting. */
  cancelling: boolean;
  /** Fallback that settles the job if the process ignores the kill. */
  cancelTimer?: ReturnType<typeof setTimeout>;
}

/**
 * One long-running pip install at a time per interpreter. Jobs live in Host
 * memory and write a log file, so closing the browser keeps them running and
 * a running job can be restored by polling the latest status.
 */
export class InstallJobs {
  private readonly jobs = new Map<string, Job>();
  private latest: string | undefined;
  private sequence = 0;

  constructor(
    private readonly options: { spawner: InstallSpawner; logDir: string },
  ) {}

  start(request: InstallRequest): InstallStatus {
    const pythonPath = (request.pythonPath ?? "").trim();
    // The interpreter may be written for another platform than the host, so its
    // own flavor decides whether the path is absolute.
    if (!pythonPath || !pathOf(pythonPath).isAbsolute(pythonPath))
      throw new TypeError(
        "Install requires an absolute Python interpreter path",
      );
    const running = [...this.jobs.values()].find(
      (job) => job.phase === "running" && job.pythonPath === pythonPath,
    );
    if (running) return this.snapshot(running);
    const args = pipArgs(request);
    const id = `install-${Date.now().toString(
      36,
    )}-${(this.sequence += 1).toString(36)}`;
    mkdirSync(this.options.logDir, { recursive: true });
    const logPath = join(this.options.logDir, `${id}.log`);
    const child = this.options.spawner.start({
      exe: pythonPath,
      args,
      logPath,
    });
    const job: Job = {
      id,
      phase: "running",
      pythonPath,
      command: [pythonPath, ...args].join(" "),
      startedAt: new Date().toISOString(),
      logPath,
      child,
      cancelling: false,
    };
    this.jobs.set(id, job);
    this.latest = id;
    child.onExit((code) => this.finish(job, code));
    return this.snapshot(job);
  }

  /** Status of one job, defaulting to the most recent; null when unknown. */
  status(jobId?: string): InstallStatus | null {
    const job = this.jobs.get(this.key(jobId));
    return job ? this.snapshot(job) : null;
  }

  /**
   * Ask pip to stop. The job keeps the interpreter locked (phase stays
   * `running`, `cancelling` set) until the process has actually exited, so a
   * second installation cannot start while the first is still dying.
   */
  cancel(jobId?: string): boolean {
    const job = this.jobs.get(this.key(jobId));
    if (!job || job.phase !== "running" || job.cancelling) return false;
    job.cancelling = true;
    job.child.kill();
    // A process that ignores the kill must not lock the interpreter forever.
    job.cancelTimer = setTimeout(() => this.finish(job, null), 15_000);
    job.cancelTimer.unref();
    return true;
  }

  /** Stop every running installation; called when the plugin unloads. */
  dispose(): void {
    for (const job of this.jobs.values()) {
      if (job.phase !== "running") continue;
      job.cancelling = true;
      job.child.kill();
    }
  }

  private key(jobId?: string): string {
    const trimmed = (jobId ?? "").trim();
    return trimmed || this.latest || "";
  }

  /** Settle a running job exactly once, from an exit or the cancel fallback. */
  private finish(job: Job, code: number | null): void {
    if (job.phase !== "running") return;
    if (job.cancelTimer) clearTimeout(job.cancelTimer);
    job.cancelTimer = undefined;
    job.phase = job.cancelling
      ? "cancelled"
      : code === 0
      ? "succeeded"
      : "failed";
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.cancelling = false;
  }

  /** Serialize only JSON-safe values; optional fields are omitted when unset. */
  private snapshot(job: Job): InstallStatus {
    return {
      id: job.id,
      phase: job.phase,
      pythonPath: job.pythonPath,
      command: job.command,
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
      ...(job.cancelling ? { cancelling: true } : {}),
      logPath: job.logPath,
      logTail: tailLog(job.logPath),
    };
  }
}
