import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import type { PythonDetection } from "./pyenv/types.js";
import type { ReMeEnvManager } from "./env-manager.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Local environment manager mounted by the DSH adapter. */
    remeEnv: ReMeEnvManager;
  }
}

/** Read-only Host projection consumed by the environment management tab. */
export class ReMeEnvGateway extends TypertRemoteService {
  static inject = ["remeEnv"];

  constructor(ctx: Context) {
    super(ctx, "remeEnv");
  }

  /** Detect local Python interpreters; cached briefly unless refreshed. */
  @Remote("python")
  async python(input: { refresh?: boolean } = {}): Promise<PythonDetection> {
    return this.ctx.remeEnv.detectPython(input);
  }
}

export default ReMeEnvGateway;
