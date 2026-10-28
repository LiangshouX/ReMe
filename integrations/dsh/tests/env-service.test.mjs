import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildStartCommand,
  ownsService,
  parseLocalEndpoint,
  readServiceState,
  serviceStatus,
  startService,
  stopService,
  writeServiceState,
} from "../dist/environment/host/service.js";

const ENDPOINT = "http://127.0.0.1:2334";

function fakeIO(overrides = {}) {
  const calls = { killTree: [], spawn: [] };
  const io = {
    fetchHealth: async () => ({ ok: false, version: "", error: "" }),
    portOpen: async () => false,
    async spawnService(options) {
      calls.spawn.push(options);
      return { pid: 4321 };
    },
    killTree(pid) {
      calls.killTree.push(pid);
    },
    probePid() {},
    processImage: async () => "python.exe",
    exists: () => true,
    platform: "win32",
    ...overrides,
  };
  return { io, calls };
}

function tempState(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, statePath: join(directory, "service.json") };
}

function record(statePath, overrides = {}) {
  writeServiceState(statePath, {
    pid: 777,
    endpoint: ENDPOINT,
    workspaceDir: join(statePath, ".."),
    pythonPath: "D:\\env\\python.exe",
    command: "reme start",
    startedAt: "2026-10-27T00:00:00.000Z",
    ...overrides,
  });
}

test("accepts only loopback endpoints and validates the port", () => {
  assert.deepEqual(parseLocalEndpoint("http://127.0.0.1:2334"), {
    host: "127.0.0.1",
    port: 2334,
  });
  assert.deepEqual(parseLocalEndpoint("http://localhost:2333"), {
    host: "127.0.0.1",
    port: 2333,
  });
  assert.throws(() => parseLocalEndpoint("http://10.0.0.5:2333"));
  assert.throws(() => parseLocalEndpoint("not-a-url"));
  assert.throws(() => parseLocalEndpoint("http://127.0.0.1:0"));
});

test("builds reme start with the workspace cwd contract", () => {
  const command = buildStartCommand({
    cliPath: "D:\\env\\Scripts\\reme.exe",
    pythonPath: "D:\\env\\python.exe",
    workspaceDir: "C:\\Users\\u\\.reme",
    endpoint: "http://127.0.0.1:2334",
    disableDreamCron: false,
    exists: () => true,
  });
  assert.equal(command.exe, "D:\\env\\Scripts\\reme.exe");
  assert.ok(command.args.includes("start"));
  assert.ok(command.args.includes("workspace_dir=C:\\Users\\u\\.reme"));
  assert.ok(command.args.includes("service.host=127.0.0.1"));
  assert.ok(command.args.includes("service.port=2334"));
  assert.ok(command.args.includes("enable_logo=false"));
  assert.ok(!command.args.includes("jobs.dream_cron.enabled=false"));

  const newer = buildStartCommand({
    cliPath: "D:\\env\\Scripts\\reme.exe",
    pythonPath: "D:\\env\\python.exe",
    workspaceDir: "C:\\Users\\u\\.reme",
    endpoint: "http://127.0.0.1:2334",
    disableDreamCron: true,
    exists: () => true,
  });
  assert.ok(newer.args.includes("jobs.dream_cron.enabled=false"));
});

test("falls back to the interpreter wrapper when the CLI is missing", () => {
  const command = buildStartCommand({
    cliPath: "",
    pythonPath: "D:\\env\\python.exe",
    workspaceDir: "C:\\Users\\u\\.reme",
    endpoint: "http://127.0.0.1:2334",
    disableDreamCron: false,
    exists: () => false,
  });
  assert.equal(command.exe, "D:\\env\\python.exe");
  assert.equal(command.args[0], "-c");
  assert.match(String(command.args[1]), /sys\.argv/);
  assert.match(String(command.args[1]), /from reme\.reme import main/);
  assert.match(String(command.args[1]), /service\.port=2334/);
});

test("derives running, conflict and stopped phases", async (t) => {
  const { directory, statePath } = tempState(t, "reme-service-");
  const base = {
    endpoint: ENDPOINT,
    statePath,
    logPath: join(directory, "service.log"),
  };

  const runningIo = fakeIO({
    fetchHealth: async () => ({ ok: true, version: "0.4.0.9", error: "" }),
  });
  let status = await serviceStatus(runningIo.io, base);
  assert.equal(status.phase, "running");
  assert.equal(status.managed, false);
  assert.equal(status.version, "0.4.0.9");

  record(statePath);
  status = await serviceStatus(runningIo.io, base);
  assert.equal(status.phase, "running");
  assert.equal(status.managed, true);
  assert.equal(status.pid, 777);

  const conflict = await serviceStatus(
    fakeIO({ portOpen: async () => true }).io,
    base,
  );
  assert.equal(conflict.phase, "conflict");

  const stopped = await serviceStatus(fakeIO().io, base);
  assert.equal(stopped.phase, "stopped");
});

test("a service on another endpoint is not reported as managed", async (t) => {
  const { directory, statePath } = tempState(t, "reme-own-");
  record(statePath, { endpoint: "http://127.0.0.1:2333" });
  const { io } = fakeIO({
    fetchHealth: async () => ({ ok: true, version: "0.4.0.9", error: "" }),
  });
  const status = await serviceStatus(io, {
    endpoint: ENDPOINT,
    statePath,
    logPath: join(directory, "service.log"),
  });
  assert.equal(status.phase, "running");
  assert.equal(status.managed, false);
  assert.equal(status.pid, undefined);
});

test("a recycled pid that is no longer the service is not managed", async (t) => {
  const { statePath } = tempState(t, "reme-pid-");
  record(statePath);
  const { io } = fakeIO({
    fetchHealth: async () => ({ ok: true, version: "0.4.0.9", error: "" }),
    processImage: async () => "node.exe",
  });
  assert.equal(
    await ownsService(io, readServiceState(statePath), ENDPOINT),
    false,
  );
  const { io: gone } = fakeIO({
    probePid() {
      throw new Error("ESRCH");
    },
  });
  assert.equal(
    await ownsService(gone, readServiceState(statePath), ENDPOINT),
    false,
  );
});

test("starts detached with the GBK-safe environment and records state", async (t) => {
  const { directory, statePath } = tempState(t, "reme-start-");
  const { io, calls } = fakeIO();
  const result = await startService(io, {
    endpoint: ENDPOINT,
    workspaceDir: directory,
    pythonPath: "D:\\env\\python.exe",
    cliPath: "D:\\env\\Scripts\\reme.exe",
    disableDreamCron: true,
    statePath,
    logPath: join(directory, "service.log"),
    env: { PATH: "x" },
  });
  assert.equal(result.started, true);
  assert.equal(result.pid, 4321);
  const spawned = calls.spawn[0];
  assert.equal(spawned.cwd, directory);
  assert.equal(spawned.env.PYTHONUTF8, "1");
  assert.equal(spawned.env.NO_PROXY, "localhost,127.0.0.1,::1");
  const persisted = readServiceState(statePath);
  assert.equal(persisted?.pid, 4321);
  assert.equal(persisted?.workspaceDir, directory);
});

test("records nothing when the spawn fails", async (t) => {
  const { directory, statePath } = tempState(t, "reme-spawn-");
  const { io } = fakeIO({
    async spawnService() {
      throw new Error("spawn ENOENT");
    },
  });
  const result = await startService(io, {
    endpoint: ENDPOINT,
    workspaceDir: directory,
    pythonPath: "D:\\env\\python.exe",
    cliPath: "D:\\missing\\reme.exe",
    disableDreamCron: false,
    statePath,
    logPath: join(directory, "service.log"),
    env: {},
  });
  assert.equal(result.started, false);
  assert.match(result.error, /ENOENT/);
  assert.equal(readServiceState(statePath), undefined);
});

test("stops the managed pid and clears the state file", async (t) => {
  const { directory, statePath } = tempState(t, "reme-stop-");
  record(statePath, { pid: 999, workspaceDir: directory });
  const { io, calls } = fakeIO();
  const stopped = await stopService(io, { statePath, endpoint: ENDPOINT });
  assert.deepEqual(stopped, { stopped: true, pid: 999 });
  assert.deepEqual(calls.killTree, [999]);
  assert.equal(readServiceState(statePath), undefined);
  assert.deepEqual(await stopService(io, { statePath, endpoint: ENDPOINT }), {
    stopped: false,
    reason: "No service started by this plugin",
  });
});

test("refuses to stop a service recorded for another endpoint", async (t) => {
  const { statePath } = tempState(t, "reme-refuse-");
  record(statePath, { endpoint: "http://127.0.0.1:2333" });
  const { io, calls } = fakeIO();
  const stopped = await stopService(io, { statePath, endpoint: ENDPOINT });
  assert.equal(stopped.stopped, false);
  assert.match(stopped.reason, /does not belong/);
  assert.deepEqual(calls.killTree, []);
  assert.ok(readServiceState(statePath), "the foreign record is left in place");
});
