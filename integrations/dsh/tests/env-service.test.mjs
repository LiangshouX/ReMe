import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildStartCommand,
  parseLocalEndpoint,
  readServiceState,
  serviceStatus,
  startService,
  stopService,
  writeServiceState,
} from "../dist/pyenv/service.js";

function fakeIO(overrides = {}) {
  const calls = { killTree: [], spawn: [] };
  const io = {
    fetchHealth: async () => ({ ok: false, version: "" }),
    portOpen: async () => false,
    spawnService(options) {
      calls.spawn.push(options);
      return { pid: 4321 };
    },
    killTree(pid) {
      calls.killTree.push(pid);
    },
    probePid() {},
    exists: () => true,
    platform: "win32",
    ...overrides,
  };
  return { io, calls };
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
  const directory = mkdtempSync(join(tmpdir(), "reme-service-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = join(directory, "service.json");
  const base = {
    endpoint: "http://127.0.0.1:2334",
    statePath,
    logPath: join(directory, "service.log"),
  };

  const runningIo = fakeIO({
    fetchHealth: async () => ({ ok: true, version: "0.4.0.9" }),
  });
  let status = await serviceStatus(runningIo.io, base);
  assert.equal(status.phase, "running");
  assert.equal(status.managed, false);
  assert.equal(status.version, "0.4.0.9");

  writeServiceState(statePath, {
    pid: 777,
    endpoint: base.endpoint,
    workspaceDir: directory,
    pythonPath: "D:\\env\\python.exe",
    command: "reme start",
    startedAt: "2026-10-27T00:00:00.000Z",
  });
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

test("starts detached with the GBK-safe environment and records state", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reme-start-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = join(directory, "service.json");
  const { io, calls } = fakeIO();
  const result = startService(io, {
    endpoint: "http://127.0.0.1:2334",
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

test("stops the managed pid and clears the state file", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reme-stop-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = join(directory, "service.json");
  writeServiceState(statePath, {
    pid: 999,
    endpoint: "http://127.0.0.1:2334",
    workspaceDir: directory,
    pythonPath: "D:\\env\\python.exe",
    command: "reme start",
    startedAt: "2026-10-27T00:00:00.000Z",
  });
  const { io, calls } = fakeIO();
  const stopped = stopService(io, { statePath });
  assert.deepEqual(stopped, { stopped: true, pid: 999 });
  assert.deepEqual(calls.killTree, [999]);
  assert.equal(readServiceState(statePath), undefined);
  assert.deepEqual(stopService(io, { statePath }), { stopped: false });
});
