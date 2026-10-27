import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { detectPythonEnvs } from "./pyenv/detect.js";
import {
  createInstallSpawner,
  InstallJobs,
  type InstallRequest,
  type InstallStatus,
} from "./pyenv/install.js";
import { checkReme, type RemeCheck } from "./pyenv/reme.js";
import { createNodeRunner } from "./pyenv/runner.js";
import type { PythonDetection } from "./pyenv/types.js";

const CACHE_MS = 60_000;

/**
 * Host-side local environment manager: read-only Python detection plus the
 * reme-ai dependency check and the one-click pip install job.
 */
export class ReMeEnvManager {
  private cache?: { at: number; detection: PythonDetection };
  private readonly installs: InstallJobs;
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    const home = env.DSH_HOME?.trim() || join(homedir(), ".dsh");
    this.installs = new InstallJobs({
      spawner: createInstallSpawner(env),
      logDir: join(home, "reme-memory"),
    });
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
}
