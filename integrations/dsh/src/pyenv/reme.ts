import { dirname, isAbsolute, join } from "node:path";

import type { RunCommand } from "./runner.js";

/** Minimum reme-ai version this DSH integration is tested against. */
export const MINIMUM_REME = "0.4.0";

const REME_VERSION_SNIPPET =
  "import importlib.metadata as m;print(m.version('reme-ai'))";

export interface RemeIO {
  run: RunCommand;
  platform: string;
  exists(path: string): boolean;
}

export interface RemeProbe {
  installed: boolean;
  version: string;
  /** True when the version satisfies {@link MINIMUM_REME}. */
  versionOk: boolean;
}

export interface RemeCheck extends RemeProbe {
  /** True when the installed version satisfies {@link MINIMUM_REME}. */
  versionOk: boolean;
  /** True when the AgentScope `[core]` extras import (agentscope) works. */
  hasCore: boolean;
  /** Absolute reme CLI path, or "" when only the python wrapper is available. */
  cliPath: string;
  /** Non-empty when the interpreter itself could not be probed. */
  error: string;
}

/** Numeric dotted-version comparison; returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Strict numeric version gate; empty or prefixed versions never pass. */
export function remeVersionAtLeast(
  version: string,
  minimum: string = MINIMUM_REME,
): boolean {
  const normalized = version.trim();
  if (!/^\d+(?:\.\d+)+$/.test(normalized)) return false;
  return compareVersions(normalized, minimum) >= 0;
}

/** Read a bare version line out of pip/import noise. */
export function parseRemeVersion(text: string): string {
  const match = /^\s*(\d+(?:\.\d+)+)\s*$/m.exec(text);
  return match?.[1] ?? "";
}

/** Ask one interpreter for its installed reme-ai metadata version. */
export async function probeReme(
  io: RemeIO,
  pythonPath: string,
): Promise<RemeProbe> {
  try {
    const result = await io.run(pythonPath, ["-c", REME_VERSION_SNIPPET], {
      timeoutMs: 10_000,
    });
    if (result.error || result.code !== 0)
      return { installed: false, version: "", versionOk: false };
    const version = parseRemeVersion(result.stdout);
    return {
      installed: version !== "",
      version,
      versionOk: remeVersionAtLeast(version),
    };
  } catch {
    return { installed: false, version: "", versionOk: false };
  }
}

/** Locate the console script installed beside the interpreter. */
export function remeCliPath(io: RemeIO, pythonPath: string): string {
  const directory = dirname(pythonPath);
  // venv interpreters live inside the scripts/bin directory; conda ones do not.
  const scriptsDir =
    io.platform === "win32"
      ? /[\\/]scripts$/i.test(directory)
        ? directory
        : join(directory, "Scripts")
      : directory;
  const candidate =
    io.platform === "win32"
      ? join(scriptsDir, "reme.exe")
      : join(scriptsDir, "reme");
  return io.exists(candidate) ? candidate : "";
}

/**
 * Full dependency check for one interpreter: reme-ai presence/version, the
 * `[core]` AgentScope import, and the CLI entry used by service management.
 */
export async function checkReme(
  io: RemeIO,
  pythonPath: string,
): Promise<RemeCheck> {
  const path = pythonPath.trim();
  if (!path || !isAbsolute(path)) {
    return {
      installed: false,
      version: "",
      versionOk: false,
      hasCore: false,
      cliPath: "",
      error: "Python interpreter path must be absolute",
    };
  }
  const probe = await probeReme(io, path);
  if (!probe.installed) {
    return {
      ...probe,
      versionOk: false,
      hasCore: false,
      cliPath: "",
      error: "",
    };
  }
  let hasCore = false;
  try {
    const core = await io.run(path, ["-c", "import agentscope"], {
      timeoutMs: 10_000,
    });
    hasCore = !core.error && core.code === 0;
  } catch {
    hasCore = false;
  }
  return {
    ...probe,
    versionOk: remeVersionAtLeast(probe.version),
    hasCore,
    cliPath: remeCliPath(io, path),
    error: "",
  };
}
