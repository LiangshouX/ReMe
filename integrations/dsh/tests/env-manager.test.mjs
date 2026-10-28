import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReMeEnvManager } from "../dist/environment/host/manager.js";

/** A service adapter that records launches instead of starting processes. */
function fakeServiceIO() {
  const calls = { spawn: [] };
  return {
    calls,
    io: {
      fetchHealth: async () => ({ ok: false, version: "", error: "" }),
      portOpen: async () => false,
      async spawnService(options) {
        calls.spawn.push(options);
        // A launch is only visible once the OS acknowledged it.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { pid: 5000 + calls.spawn.length };
      },
      killTree() {},
      probePid() {},
      processImage: async () => "python.exe",
      exists: () => true,
      platform: "win32",
    },
  };
}

function managerIn(t) {
  const directory = mkdtempSync(join(tmpdir(), "reme-manager-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { io, calls } = fakeServiceIO();
  const manager = new ReMeEnvManager({ DSH_HOME: directory }, io);
  // Both probes are Host process work; the test replaces them with facts.
  manager.checkReme = async () => ({
    installed: true,
    version: "0.4.2.1",
    versionOk: true,
    hasCore: true,
    cliPath: "",
    error: "",
  });
  manager.serviceStatus = async (endpoint) => ({
    phase: "stopped",
    managed: false,
    endpoint: endpoint || "http://127.0.0.1:2333",
    logPath: join(directory, "service.log"),
  });
  return { manager, calls, directory };
}

test("serializes concurrent starts into one service launch", async (t) => {
  const { manager, calls, directory } = managerIn(t);
  const options = [
    "http://127.0.0.1:2334",
    "D:\\env\\python.exe",
    join(directory, "workspace"),
  ];
  const [first, second] = await Promise.all([
    manager.serviceStart(...options),
    manager.serviceStart(...options),
  ]);
  assert.equal(calls.spawn.length, 1, "the second request joins the first");
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(second.alreadyRunning, true);
});

test("probes health from the Host and rejects a non-http endpoint", async (t) => {
  const { manager } = managerIn(t);
  const health = await manager.health("http://127.0.0.1:2334");
  assert.equal(health.endpoint, "http://127.0.0.1:2334");
  assert.equal(health.ok, false);
  assert.equal(typeof health.checkedAt, "string");
  await assert.rejects(() => manager.health("file:///etc/passwd"), /http/);
});

test("validates the merged .env, not just the submitted values", async (t) => {
  const { manager, directory } = managerIn(t);
  const envPath = join(directory, ".env");
  writeFileSync(
    envPath,
    "LLM_MODEL_NAME=qwen3.7-plus\nLLM_API_KEY=sk-keep\nEMBEDDING_API_KEY=EMPTY\n",
  );

  // An untouched required key still satisfies the requirement.
  const summary = manager.writeEnv(directory, {
    LLM_MODEL_NAME: "qwen3.8-plus",
  });
  assert.equal(
    summary.entries.find((entry) => entry.key === "LLM_MODEL_NAME").value,
    "qwen3.8-plus",
  );
  assert.match(readFileSync(envPath, "utf8"), /^LLM_API_KEY=sk-keep$/m);

  // An explicit clear leaves the file alone and reports why.
  assert.throws(
    () => manager.writeEnv(directory, { LLM_API_KEY: "" }),
    /LLM_API_KEY is required/,
  );
  assert.match(readFileSync(envPath, "utf8"), /^LLM_API_KEY=sk-keep$/m);
});
