import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  envSummary,
  maskSecret,
  mergeEnvFile,
  parseEnvFile,
  parseLlmTest,
  resolveWorkspaceDir,
  testLlm,
  validateEnvUpdate,
} from "../dist/environment/host/workspace.js";

test("resolves the workspace directory with ~/.reme defaults", () => {
  const home = process.platform === "win32" ? "C:\\Users\\u" : "/home/u";
  assert.equal(resolveWorkspaceDir("", home), join(home, ".reme"));
  assert.equal(resolveWorkspaceDir("~/.reme", home), join(home, ".reme"));
  assert.equal(resolveWorkspaceDir("~", home), home);
  assert.throws(() => resolveWorkspaceDir("relative/dir", home));
});

test("parses KEY=VALUE lines tolerating comments, blanks and quotes", () => {
  const parsed = parseEnvFile(
    [
      "# service credentials",
      "",
      "LLM_BACKEND=openai",
      'LLM_MODEL_NAME="qwen3.7-plus"',
      "LLM_API_KEY='sk-test'",
      "UNKNOWN_KEY=kept",
      "BROKEN LINE",
    ].join("\n"),
  );
  assert.deepEqual(parsed, {
    LLM_BACKEND: "openai",
    LLM_MODEL_NAME: "qwen3.7-plus",
    LLM_API_KEY: "sk-test",
    UNKNOWN_KEY: "kept",
  });
});

test("merges updates while preserving comments, order and unknown keys", () => {
  const existing = [
    "# managed by hand",
    "LLM_BACKEND=openai",
    "LLM_API_KEY=old-key",
    "",
    "EMBEDDING_API_KEY=EMPTY",
    "# keep me",
  ].join("\n");
  const merged = mergeEnvFile(existing, {
    LLM_API_KEY: "new-key",
    LLM_BASE_URL: "https://example.com/v1",
  });
  assert.match(merged, /^# managed by hand$/m);
  assert.match(merged, /^LLM_API_KEY=new-key$/m);
  assert.doesNotMatch(merged, /old-key/);
  assert.match(merged, /^EMBEDDING_API_KEY=EMPTY$/m);
  assert.match(merged, /^# keep me$/m);
  assert.match(merged, /^LLM_BASE_URL=https:\/\/example\.com\/v1$/m);
  assert.ok(merged.endsWith("\n"));
  // Idempotent updates do not duplicate keys.
  assert.equal(
    (
      mergeEnvFile(merged, { LLM_API_KEY: "new-key" }).match(
        /^LLM_API_KEY=/gm,
      ) ?? []
    ).length,
    1,
  );
});

test("a duplicated key is rewritten everywhere, so parsing agrees", () => {
  const existing = [
    "LLM_API_KEY=old-key",
    "LLM_MODEL_NAME=qwen3.7-plus",
    "LLM_API_KEY=older-key",
  ].join("\n");
  const merged = mergeEnvFile(existing, { LLM_API_KEY: "new-key" });
  assert.equal((merged.match(/^LLM_API_KEY=new-key$/gm) ?? []).length, 2);
  // Parsing keeps the last occurrence, and that occurrence is the new value.
  assert.equal(parseEnvFile(merged)["LLM_API_KEY"], "new-key");
  assert.equal((merged.match(/^LLM_API_KEY=/gm) ?? []).length, 2);
});

test("keeps the file's own line ending", () => {
  const merged = mergeEnvFile(
    "LLM_BACKEND=openai\r\nEMBEDDING_API_KEY=EMPTY\r\n",
    {
      LLM_BACKEND: "dashscope",
    },
  );
  assert.match(merged, /^LLM_BACKEND=dashscope\r$/m);
  assert.equal(merged.includes("\n\n"), false);
  assert.ok(merged.endsWith("\r\n"));
  assert.equal(mergeEnvFile("", { A: "1" }), "A=1\n");
});

test("masks secrets down to the last four characters", () => {
  assert.equal(maskSecret("sk-abcdefgh"), "••••efgh");
  assert.equal(maskSecret("abc"), "••••");
  assert.equal(maskSecret(""), "");
});

test("summaries expose masked secrets and plain non-secret values", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reme-env-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, ".env");
  writeFileSync(
    path,
    "LLM_MODEL_NAME=qwen3.7-plus\nLLM_API_KEY=sk-super-secret\n",
  );
  const summary = envSummary(path, directory);
  assert.equal(summary.exists, true);
  assert.equal(summary.envPath, path);
  const model = summary.entries.find((entry) => entry.key === "LLM_MODEL_NAME");
  assert.equal(model.value, "qwen3.7-plus");
  assert.equal(model.secret, false);
  const key = summary.entries.find((entry) => entry.key === "LLM_API_KEY");
  assert.equal(key.set, true);
  assert.equal(key.secret, true);
  assert.equal(key.value, "");
  assert.equal(key.masked, "••••cret");
  assert.doesNotMatch(JSON.stringify(summary), /super-secret/);
});

test("validates the embedding key that aborts ReMe 0.4.0.x startup", () => {
  assert.throws(() =>
    validateEnvUpdate({ LLM_API_KEY: "sk", EMBEDDING_API_KEY: "" }),
  );
  assert.throws(() =>
    validateEnvUpdate({ LLM_API_KEY: "", EMBEDDING_API_KEY: "EMPTY" }),
  );
  validateEnvUpdate({ LLM_API_KEY: "sk", EMBEDDING_API_KEY: "EMPTY" });
  validateEnvUpdate({ LLM_API_KEY: "sk", EMBEDDING_API_KEY: "real-key" });
});

test("parses LLM test results from noisy python output", () => {
  assert.deepEqual(
    parseLlmTest(
      'warn\n{"ok": true, "status": 200, "latencyMs": 321, "error": ""}\n',
    ),
    { ok: true, status: 200, latencyMs: 321, error: "" },
  );
  assert.deepEqual(parseLlmTest("no json"), {
    ok: false,
    status: 0,
    latencyMs: 0,
    error: "LLM test produced no result",
  });
});

test("runs the LLM probe inside the workspace and classifies failures", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reme-llm-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const io = {
    run: async (exe, args, options) => {
      calls.push({ exe, args, options });
      const stdout =
        calls.length === 1
          ? '{"ok": true, "status": 200, "latencyMs": 120, "error": ""}\n'
          : '{"ok": false, "status": 401, "latencyMs": 40, "error": "HTTP 401"}\n';
      return { code: 0, stdout, stderr: "" };
    },
  };
  const ok = await testLlm(io, {
    workspaceDir: directory,
    pythonPath: "C:\\env\\python.exe",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.latencyMs, 120);
  assert.equal(calls[0].options.cwd, directory);
  assert.equal(calls[0].exe, "C:\\env\\python.exe");

  const denied = await testLlm(io, {
    workspaceDir: directory,
    pythonPath: "C:\\env\\python.exe",
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /LLM_API_KEY/);

  const broken = await testLlm(
    {
      run: async () => ({
        code: null,
        stdout: "",
        stderr: "",
        error: "spawn ENOENT",
      }),
    },
    { workspaceDir: directory, pythonPath: "C:\\missing\\python.exe" },
  );
  assert.equal(broken.ok, false);
  assert.match(broken.error, /ENOENT/);
});
