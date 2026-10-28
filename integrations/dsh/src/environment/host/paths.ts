import { posix, win32, type PlatformPath } from "node:path";

/** True when a path is written the Windows way: drive letter, UNC or backslash. */
export function isWindowsPath(value: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\") ||
    value.includes("\\")
  );
}

/**
 * The path flavor a value is written in.
 *
 * Interpreter discovery and the probes around it see paths that may belong to
 * the simulated platform, so they must not fall back to the host's
 * `node:path`: the same fixtures then resolve identically on Windows, macOS and
 * Linux instead of only on the machine that wrote them.
 */
export function pathOf(value: string): PlatformPath {
  return isWindowsPath(value) ? win32 : posix;
}

/**
 * Whether a path is absolute in its own platform's semantics.
 *
 * `win32.isAbsolute("\\python.exe")` is true, but such a path is relative to
 * the current drive, which is not what the interpreter and install checks must
 * accept. Windows therefore needs a drive letter or a UNC prefix.
 */
export function isAbsolutePath(value: string): boolean {
  if (isWindowsPath(value))
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  return value.startsWith("/");
}
