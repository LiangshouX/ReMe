import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import type { InstallStatus } from "./pyenv/install.js";
import type { RemeCheck } from "./pyenv/reme.js";
import type {
  ServiceLog,
  ServiceStartResult,
  ServiceState,
} from "./pyenv/service.js";
import type { PythonDetection } from "./pyenv/types.js";
import type { EnvSummary, LlmTestResult } from "./pyenv/workspace.js";
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

  /** Masked .env values for the workspace; secrets are never returned. */
  @Remote("readEnv")
  async readEnv(
    input: { workspaceDir?: string } | undefined,
  ): Promise<EnvSummary> {
    return this.ctx.remeEnv.readEnv(input?.workspaceDir ?? "");
  }

  /** Merge edited values into the workspace .env and return fresh state. */
  @Remote("writeEnv")
  async writeEnv(
    input:
      | { workspaceDir?: string; values?: Record<string, string> }
      | undefined,
  ): Promise<EnvSummary> {
    return this.ctx.remeEnv.writeEnv(
      input?.workspaceDir ?? "",
      input?.values ?? {},
    );
  }

  /** Probe the configured LLM endpoint with the selected interpreter. */
  @Remote("testLlm")
  async testLlm(
    input: { workspaceDir?: string; pythonPath?: string } | undefined,
  ): Promise<LlmTestResult> {
    return this.ctx.remeEnv.testLlm(
      input?.workspaceDir ?? "",
      input?.pythonPath ?? "",
    );
  }

  /** Phase of the local ReMe service: running, conflict or stopped. */
  @Remote("serviceStatus")
  async serviceStatus(
    input: { endpoint?: string } | undefined,
  ): Promise<ServiceState> {
    return this.ctx.remeEnv.serviceStatus(input?.endpoint ?? "");
  }

  /** Spawn a detached `reme start`; poll serviceStatus until healthy. */
  @Remote("serviceStart")
  async serviceStart(
    input:
      | { endpoint?: string; pythonPath?: string; workspaceDir?: string }
      | undefined,
  ): Promise<ServiceStartResult> {
    return this.ctx.remeEnv.serviceStart(
      input?.endpoint ?? "",
      input?.pythonPath ?? "",
      input?.workspaceDir ?? "",
    );
  }

  /** Stop the plugin-managed service; foreign instances are untouched. */
  @Remote("serviceStop")
  async serviceStop(
    input: { endpoint?: string } | undefined,
  ): Promise<{ stopped: boolean; pid?: number }> {
    return this.ctx.remeEnv.serviceStop(input?.endpoint ?? "");
  }

  /** Tail of the workspace service log for start-failure diagnosis. */
  @Remote("serviceLog")
  async serviceLog(
    input: { workspaceDir?: string } | undefined,
  ): Promise<ServiceLog> {
    return this.ctx.remeEnv.serviceLog(input?.workspaceDir ?? "");
  }
}

export default ReMeEnvGateway;
