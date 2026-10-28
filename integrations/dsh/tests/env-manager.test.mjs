import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReMeEnvManager } from "../dist/environment/host/manager.js";
import { writeServiceState } from "../dist/environment/host/service.js";

/** A service adapter that records launches instead of starting processes. */
function fakeServiceIO() {
  const calls = { killTree: [], spawn: [] };
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
  return { manager, calls, directory, io };
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

test("a failed spawn can be retried immediately", async (t) => {
  const { manager, calls, directory, io } = managerIn(t);
  io.spawnService = async (options) => {
    calls.spawn.push(options);
    if (calls.spawn.length === 1) throw new Error("spawn ENOENT");
    return { pid: 7000 };
  };
  const options = [
    "http://127.0.0.1:2334",
    "D:\\env\\python.exe",
    join(directory, "workspace"),
  ];
  const first = await manager.serviceStart(...options);
  assert.equal(first.started, false);
  assert.match(first.error, /ENOENT/);

  // The start marker was cleared with the failure; a retry must really spawn
  // instead of being reported as "already starting".
  const second = await manager.serviceStart(...options);
  assert.equal(second.started, true);
  assert.equal(calls.spawn.length, 2);
});

test("refuses to spawn while another process owns the port", async (t) => {
  const { manager, calls, directory } = managerIn(t);
  manager.serviceStatus = async (endpoint) => ({
    phase: "conflict",
    managed: false,
    endpoint,
    logPath: join(directory, "service.log"),
  });
  const result = await manager.serviceStart(
    "http://127.0.0.1:2334",
    "D:\\env\\python.exe",
    join(directory, "workspace"),
  );
  assert.equal(result.started, false);
  assert.match(result.error, /already listening/);
  assert.equal(calls.spawn.length, 0);
});

test("stops a previous launch that never became healthy before replacing it", async (t) => {
  const { manager, calls, directory, io } = managerIn(t);
  manager.serviceStatus = async (endpoint) => ({
    phase: "stopped",
    managed: false,
    endpoint,
    // A live record for this endpoint means a launch that is still booting.
    pid: 6000,
    logPath: join(directory, "service.log"),
  });
  writeServiceState(join(directory, "reme-memory", "service.json"), {
    pid: 6000,
    endpoint: "http://127.0.0.1:2334",
    workspaceDir: directory,
    pythonPath: "D:\\env\\python.exe",
    command: "reme start",
    startedAt: "2026-10-27T00:00:00.000Z",
  });
  let running = true;
  io.probePid = () => {
    if (!running) throw new Error("ESRCH");
  };
  io.killTree = (pid) => {
    calls.killTree.push(pid);
    running = false;
  };

  const result = await manager.serviceStart(
    "http://127.0.0.1:2334",
    "D:\\env\\python.exe",
    join(directory, "workspace"),
  );
  assert.equal(result.started, true);
  assert.deepEqual(calls.killTree, [6000]);
  assert.equal(calls.spawn.length, 1);
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
