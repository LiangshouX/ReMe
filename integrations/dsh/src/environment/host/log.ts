import { mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Rotate a log once it grows past this size; only one backup is kept. */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/**
 * Open a log for appending, rotating an oversized one to `<path>.1` first.
 * Install and service logs otherwise grow without bound because both are
 * append-only and outlive many sessions.
 */
export function openAppendLog(
  path: string,
  maxBytes = LOG_ROTATE_BYTES,
): number {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
  } catch {
    // A missing log has nothing to rotate; a locked one (Windows, while the
    // service still writes it) is left alone rather than failing the launch.
  }
  return openSync(path, "a");
}
