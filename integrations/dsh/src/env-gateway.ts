import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import type { InstallStatus } from "./pyenv/install.js";
import type { RemeCheck } from "./pyenv/reme.js";
import type { PythonDetection } from "./pyenv/types.js";
import type { ReMeEnvManager } from "./env-manager.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Local environment manager mounted by the DSH adapter. */
    remeEnv: ReMeEnvManager;
  }
}

/**
 * Host projection for the environment management tab.
 *
 * DSH exposes these methods in SRC mode (no generated typert artifact), which
 * parses the method source: every method takes exactly one plain identifier
 * parameter named `input`, with no destructuring, defaults, or rest, and the
 * client sends `{ args: { input: ... } }`.
 */
export class ReMeEnvGateway extends TypertRemoteService {
  static inject = ["remeEnv"];

  constructor(ctx: Context) {
    super(ctx, "remeEnv");
  }

  /** Detect local Python interpreters; cached briefly unless refreshed. */
  @Remote("python")
  async python(
    input: { refresh?: boolean } | undefined,
  ): Promise<PythonDetection> {
    return this.ctx.remeEnv.detectPython(input ?? {});
  }

  /** Inspect reme-ai, the [core] extras and the CLI for one interpreter. */
  @Remote("checkReme")
  async checkReme(
    input: { pythonPath?: string } | undefined,
  ): Promise<RemeCheck> {
    return this.ctx.remeEnv.checkReme(input?.pythonPath ?? "");
  }

  /** Start the one-click pip install and return the running job. */
  @Remote("install")
  async install(
    input:
      | { pythonPath?: string; upgrade?: boolean; indexUrl?: string }
      | undefined,
  ): Promise<InstallStatus> {
    return this.ctx.remeEnv.install({
      pythonPath: input?.pythonPath ?? "",
      upgrade: input?.upgrade === true,
      indexUrl: typeof input?.indexUrl === "string" ? input.indexUrl : "",
    });
  }

  /** Latest (or named) install job progress, including the log tail. */
  @Remote("installStatus")
  async installStatus(
    input: { jobId?: string } | undefined,
  ): Promise<InstallStatus | null> {
    return this.ctx.remeEnv.installStatus(input?.jobId ?? "");
  }

  /** Ask a running install to stop; polling observes the cancelled phase. */
  @Remote("installCancel")
  async installCancel(input: { jobId?: string } | undefined): Promise<boolean> {
    return this.ctx.remeEnv.installCancel(input?.jobId ?? "");
  }
}

export default ReMeEnvGateway;
