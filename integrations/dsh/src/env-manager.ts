import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { detectPythonEnvs } from "./pyenv/detect.js";
import { createNodeRunner } from "./pyenv/runner.js";
import type { PythonDetection } from "./pyenv/types.js";

const CACHE_MS = 60_000;

/**
 * Host-side local environment manager. Read-only in this milestone: it
 * discovers Python interpreters and caches the answer briefly so opening
 * the environment tab does not re-run probes on every render.
 */
export class ReMeEnvManager {
  private cache?: { at: number; detection: PythonDetection };

  async detectPython(
    options: { refresh?: boolean } = {},
  ): Promise<PythonDetection> {
    if (!options.refresh && this.cache && Date.now() - this.cache.at < CACHE_MS)
      return this.cache.detection;
    const detection = await detectPythonEnvs({
      run: createNodeRunner(process.env),
      platform: process.platform,
      env: process.env,
      homedir: homedir(),
      exists: existsSync,
    });
    this.cache = { at: Date.now(), detection };
    return detection;
  }
}
