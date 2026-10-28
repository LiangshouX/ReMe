import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { safeError } from "../../endpoint.js";
import type { EnvSummary, LlmTestResult } from "../types.js";
import type { RunCommand } from "./runner.js";

/** Keys the Environment tab manages; split for the two form groups. */
export const LLM_KEYS = [
  "LLM_BACKEND",
  "LLM_MODEL_NAME",
  "LLM_API_KEY",
  "LLM_BASE_URL",
] as const;
export const EMBEDDING_KEYS = [
  "EMBEDDING_BACKEND",
  "EMBEDDING_MODEL_NAME",
  "EMBEDDING_API_KEY",
  "EMBEDDING_BASE_URL",
] as const;
const MANAGED_KEYS: readonly string[] = [...LLM_KEYS, ...EMBEDDING_KEYS];
const SECRET_KEYS = new Set(["LLM_API_KEY", "EMBEDDING_API_KEY"]);

/** Empty means "~/.reme"; "~" expands against home; relative paths are rejected. */
export function resolveWorkspaceDir(raw: string, home: string): string {
  const trimmed = (raw ?? "").trim();
  const expanded = trimmed.startsWith("~")
    ? join(home, trimmed.slice(1).replace(/^[\\/]+/, ""))
    : trimmed;
  const value = expanded || join(home, ".reme");
  if (!isAbsolute(value))
    throw new TypeError("ReMe workspace directory must be an absolute path");
  return resolve(value);
}

/** Parse KEY=VALUE lines; comments, blanks, quotes and unknown keys are tolerated. */
export function parseEnvFile(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    entries[key] = value;
  }
  return entries;
}

/**
 * Rewrite only the lines whose keys appear in updates; every other line
 * (comments, unknown variables, ordering) is preserved byte-for-byte, and the
 * file keeps its own line ending.
 *
 * A key that appears more than once is rewritten in every position. Parsing
 * keeps the last occurrence, so rewriting only the first would leave an older
 * value in force: after this function every duplicate agrees.
 */
export function mergeEnvFile(
  existingText: string,
  updates: Record<string, string>,
): string {
  const pending = new Map(Object.entries(updates));
  const eol = /\r\n/.test(existingText) ? "\r\n" : "\n";
  const lines = existingText.length ? existingText.split(/\r?\n/) : [];
  const output: string[] = [];
  const written = new Set<string>();
  for (const line of lines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1] ?? "";
    if (key && pending.has(key)) {
      // Every occurrence takes the new value: parsing keeps the last one, so
      // rewriting only the first would leave an older value in force.
      output.push(`${key}=${pending.get(key) ?? ""}`);
      written.add(key);
      continue;
    }
    output.push(line);
  }
  // Normalize the trailing newline before appending new keys.
  while (output.length && output[output.length - 1] === "") output.pop();
  for (const [key, value] of pending)
    if (!written.has(key)) output.push(`${key}=${value}`);
  return `${output.join(eol)}${eol}`;
}

/** "••••" plus the last four characters; empty values stay empty. */
export function maskSecret(value: string): string {
  if (!value) return "";
  return value.length > 4 ? `••••${value.slice(-4)}` : "••••";
}

/** Read-only projection for the tab: secrets are never returned in clear. */
export function envSummary(path: string, workspaceDir: string): EnvSummary {
  let text = "";
  let exists = false;
  try {
    text = readFileSync(path, "utf8");
    exists = true;
  } catch {
    // A missing .env is the valid first-run state.
  }
  const parsed = parseEnvFile(text);
  const entries = MANAGED_KEYS.map((key) => {
    const value = parsed[key] ?? "";
    const secret = SECRET_KEYS.has(key);
    return {
      key,
      secret,
      set: value !== "",
      masked: secret ? maskSecret(value) : value,
      value: secret ? "" : value,
    };
  });
  return { workspaceDir, envPath: path, exists, entries };
}

/**
 * Reject a .env that cannot start ReMe. Version 0.4.0.x instantiates the
 * embedding component unconditionally, so an empty key aborts startup.
 */
export function validateEnvUpdate(values: Record<string, string>): void {
  if (!(values["LLM_API_KEY"] ?? "").trim())
    throw new TypeError("LLM_API_KEY is required");
  if (!(values["EMBEDDING_API_KEY"] ?? "").trim())
    throw new TypeError(
      "EMBEDDING_API_KEY must be non-empty (use EMPTY when vector search is disabled)",
    );
}

/**
 * Write a fully merged `.env`. The caller merges and validates first, so the
 * file on disk is exactly what was validated.
 */
export function writeEnvText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/**
 * Probe the configured LLM endpoint from inside the workspace directory, so
 * the snippet reads the same .env the service would discover.
 */
const LLM_TEST_SNIPPET = `
import json, time, urllib.request, urllib.error
env = {}
try:
    with open(".env", encoding="utf-8") as stream:
        for line in stream:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
except OSError:
    pass
base = env.get("LLM_BASE_URL", "").rstrip("/")
key = env.get("LLM_API_KEY", "")
model = env.get("LLM_MODEL_NAME", "")
if not base or not key or not model:
    print(json.dumps({"ok": False, "status": 0, "latencyMs": 0, "error": "LLM config incomplete (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL_NAME)"}))
    raise SystemExit(0)
body = json.dumps({"model": model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1}).encode()
request = urllib.request.Request(base + "/chat/completions", data=body, headers={"Content-Type": "application/json", "Authorization": "Bearer " + key}, method="POST")
started = time.time()
try:
    with urllib.request.urlopen(request, timeout=20) as response:
        response.read()
        print(json.dumps({"ok": 200 <= response.status < 300, "status": response.status, "latencyMs": int((time.time() - started) * 1000), "error": ""}))
except urllib.error.HTTPError as error:
    print(json.dumps({"ok": False, "status": error.code, "latencyMs": int((time.time() - started) * 1000), "error": "HTTP " + str(error.code)}))
except Exception as error:
    print(json.dumps({"ok": False, "status": 0, "latencyMs": int((time.time() - started) * 1000), "error": str(error)[:300]}))
`;

/** Parse the JSON line the LLM test snippet prints. */
export function parseLlmTest(text: string): LlmTestResult {
  for (const line of text.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      return {
        ok: value.ok === true,
        status: typeof value.status === "number" ? value.status : 0,
        latencyMs: typeof value.latencyMs === "number" ? value.latencyMs : 0,
        error: typeof value.error === "string" ? value.error : "",
      };
    } catch {
      // Try an earlier line.
    }
  }
  return {
    ok: false,
    status: 0,
    latencyMs: 0,
    error: "LLM test produced no result",
  };
}

/** Run the LLM probe with the selected interpreter inside the workspace. */
export async function testLlm(
  io: { run: RunCommand },
  options: { workspaceDir: string; pythonPath: string },
): Promise<LlmTestResult> {
  try {
    const result = await io.run(options.pythonPath, ["-c", LLM_TEST_SNIPPET], {
      cwd: options.workspaceDir,
      timeoutMs: 30_000,
    });
    if (result.error)
      return {
        ok: false,
        status: 0,
        latencyMs: 0,
        error: safeError(result.error),
      };
    const parsed = parseLlmTest(result.stdout);
    if (!parsed.ok && parsed.error) {
      const hint =
        parsed.status === 401 || parsed.status === 403
          ? "check LLM_API_KEY"
          : parsed.status === 404
          ? "check LLM_MODEL_NAME / LLM_BASE_URL"
          : /refused|timed out|getaddrinfo|Name or service/i.test(parsed.error)
          ? "check LLM_BASE_URL and network"
          : "";
      if (hint) parsed.error = `${parsed.error} (${hint})`;
    }
    return parsed;
  } catch (error) {
    return { ok: false, status: 0, latencyMs: 0, error: safeError(error) };
  }
}
