/** A local Python interpreter discovered on this machine. */
export type PythonOrigin =
  | { kind: "conda"; envName: string; root: string }
  | { kind: "python.org" }
  | { kind: "windows-store" }
  | { kind: "venv"; baseExe: string }
  | { kind: "system" }
  | { kind: "unknown" };

export interface PythonEnv {
  /** Verified interpreter executable (absolute, host-native separators). */
  exe: string;
  /** "major.minor.patch" reported by the interpreter; empty when unusable. */
  version: string;
  /** True when the interpreter answered and satisfies ReMe (Python >= 3.11). */
  ok: boolean;
  origin: PythonOrigin;
  /** Human-readable discovery channels, e.g. "conda env list; PATH". */
  source: string;
  /** reme-ai installation facts, probed for the interpreter recommendation. */
  reme?: { installed: boolean; version: string };
}

export interface PythonDetection {
  platform: string;
  scannedAt: string;
  envs: PythonEnv[];
  /** Preferred interpreter for a local service, or "" when none is usable. */
  suggested: string;
  /** Conda installation root, or "" when conda was not found. */
  condaRoot: string;
  /** Non-fatal probe failures worth showing for transparency. */
  errors: string[];
}
