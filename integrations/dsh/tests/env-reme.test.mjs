import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkReme,
  compareVersions,
  parseRemeVersion,
  remeVersionAtLeast,
} from "../dist/environment/host/reme.js";
import {
  InstallJobs,
  pipArgs,
  tailLog,
} from "../dist/environment/host/install.js";

const SNIPPETS = {
  version: "importlib.metadata",
  core: "import agentscope",
};

function remeIO(handlers, platform = "win32") {
  return {
    run: async (exe, args) => {
      const handler = handlers[exe];
      if (!handler) return { code: 1, stdout: "", stderr: "no handler" };
      return handler(args);
    },
    platform,
    exists: (path) =>
      path.endsWith("Scripts\\reme.exe") || path.endsWith("bin\\reme"),
  };
}

test("compares dotted versions across ReMe's four-segment scheme", () => {
  assert.equal(compareVersions("0.4.0.9", "0.4.0"), 1);
  assert.equal(compareVersions("0.4.0", "0.4.0"), 0);
  assert.equal(compareVersions("0.3.9.9", "0.4.0"), -1);
  assert.equal(compareVersions("1.0", "0.4.0.9"), 1);
  assert.equal(remeVersionAtLeast("0.4.0.9"), true);
  assert.equal(remeVersionAtLeast("0.4.0"), true);
  assert.equal(remeVersionAtLeast("0.4.1.11"), true);
  assert.equal(remeVersionAtLeast("0.3.2"), false);
  assert.equal(remeVersionAtLeast(""), false);
  assert.equal(remeVersionAtLeast("v0.4.0"), false);
});

test("parses a version line out of noisy metadata output", () => {
  assert.equal(parseRemeVersion("0.4.0.9\n"), "0.4.0.9");
  assert.equal(parseRemeVersion("warning\n0.4.0.9\ntrailer"), "0.4.0.9");
  assert.equal(parseRemeVersion("PackageNotFoundError"), "");
  assert.equal(parseRemeVersion(""), "");
});

test("checks an installed interpreter including [core] and the CLI", async () => {
  const io = remeIO({
    "C:\\env\\python.exe": (args) =>
      String(args[1]).includes(SNIPPETS.version)
        ? { code: 0, stdout: "0.4.0.9\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
  });
  const check = await checkReme(io, "C:\\env\\python.exe");
  assert.equal(check.installed, true);
  assert.equal(check.version, "0.4.0.9");
  assert.equal(check.versionOk, true);
  assert.equal(check.hasCore, true);
  assert.equal(check.cliPath, "C:\\env\\Scripts\\reme.exe");
  assert.equal(check.error, "");
});

test("finds the CLI for venv interpreters that live inside Scripts", async () => {
  const io = remeIO({
    "C:\\venv\\Scripts\\python.exe": (args) =>
      String(args[1]).includes(SNIPPETS.version)
        ? { code: 0, stdout: "0.4.1.1\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
  });
  io.exists = (path) => path.toLowerCase() === "c:\\venv\\scripts\\reme.exe";
  const check = await checkReme(io, "C:\\venv\\Scripts\\python.exe");
  assert.equal(check.cliPath, "C:\\venv\\Scripts\\reme.exe");
});

test("flags old versions and missing [core] extras", async () => {
  const io = remeIO({
    "C:\\env\\python.exe": (args) =>
      String(args[1]).includes(SNIPPETS.version)
        ? { code: 0, stdout: "0.3.2\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "ModuleNotFoundError" },
  });
  const check = await checkReme(io, "C:\\env\\python.exe");
  assert.equal(check.installed, true);
  assert.equal(check.versionOk, false);
  assert.equal(check.hasCore, false);
});

test("reports a missing installation without core or CLI", async () => {
  const io = remeIO({
    "C:\\env\\python.exe": () => ({ code: 1, stdout: "", stderr: "not found" }),
  });
  const check = await checkReme(io, "C:\\env\\python.exe");
  assert.equal(check.installed, false);
  assert.equal(check.versionOk, false);
  assert.equal(check.hasCore, false);
  assert.equal(check.cliPath, "");
});

test("rejects relative interpreter paths", async () => {
  const check = await checkReme(remeIO({}), "python.exe");
  assert.equal(check.installed, false);
  assert.match(check.error, /absolute/);
});

test("composes pip arguments for install, upgrade and mirrors", () => {
  assert.deepEqual(pipArgs({ pythonPath: "C:\\env\\python.exe" }), [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--no-input",
    "reme-ai[core]",
  ]);
  assert.deepEqual(
    pipArgs({ pythonPath: "C:\\env\\python.exe", upgrade: true }),
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-input",
      "-U",
      "reme-ai[core]",
    ],
  );
  assert.deepEqual(
    pipArgs({
      pythonPath: "C:\\env\\python.exe",
      indexUrl: "https://pypi.tuna.tsinghua.edu.cn/simple",
    }).slice(-3),
    [
      "--index-url",
      "https://pypi.tuna.tsinghua.edu.cn/simple",
      "reme-ai[core]",
    ],
  );
  assert.throws(() =>
    pipArgs({ pythonPath: "C:\\env\\python.exe", indexUrl: "ftp://x" }),
  );
});

test("tails a log with CRLF and progress carriage returns", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reme-install-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "install.log");
  writeFileSync(path, "line1\r\nline2\r\nprogress 40%\rprogress 80%\rline3\n");
  const tail = tailLog(path);
  assert.ok(tail.includes("line1"));
  assert.ok(tail.includes("line3"));
  assert.ok(tail.includes("progress 80%"));
  assert.equal(tailLog(join(directory, "missing.log")), "");
});

function fakeSpawner() {
  const children = [];
  const spawner = {
    start() {
      const child = {
        pid: 4000 + children.length,
        killed: false,
        onExit(callback) {
          child.exit = callback;
        },
        kill() {
          child.killed = true;
        },
      };
      children.push(child);
      return child;
    },
  };
  return { spawner, children };
}

function makeJobs(t) {
  const directory = mkdtempSync(join(tmpdir(), "reme-jobs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { spawner, children } = fakeSpawner();
  const jobs = new InstallJobs({ spawner, logDir: directory });
  return { jobs, children, directory };
}

test("tracks a successful pip job through exit", (t) => {
  const { jobs, children, directory } = makeJobs(t);
  const started = jobs.start({ pythonPath: "C:\\env\\python.exe" });
  assert.equal(started.phase, "running");
  assert.ok(started.logPath.startsWith(directory));
  assert.match(started.command, /reme-ai\[core\]/);
  assert.equal(jobs.status()?.id, started.id);

  children[0].exit(0);
  const done = jobs.status(started.id);
  assert.equal(done?.phase, "succeeded");
  assert.equal(done?.exitCode, 0);
  assert.ok(done?.finishedAt);
});

test("tracks a failed pip job and keeps the log tail", (t) => {
  const { jobs, children } = makeJobs(t);
  const started = jobs.start({ pythonPath: "C:\\env\\python.exe" });
  writeFileSync(started.logPath, "ERROR: Could not find a version\n");
  children[0].exit(1);
  const done = jobs.status(started.id);
  assert.equal(done?.phase, "failed");
  assert.equal(done?.exitCode, 1);
  assert.match(done?.logTail ?? "", /Could not find a version/);
});

test("keeps the interpreter locked until a cancelled job exits", (t) => {
  const { jobs, children } = makeJobs(t);
  const started = jobs.start({ pythonPath: "C:\\env\\python.exe" });
  assert.equal(jobs.cancel(started.id), true);
  assert.equal(children[0].killed, true);
  // The process still owns the interpreter, so the job stays running until the
  // exit is observed and no second installation may start.
  const cancelling = jobs.status(started.id);
  assert.equal(cancelling?.phase, "running");
  assert.equal(cancelling?.cancelling, true);
  assert.equal(
    jobs.start({ pythonPath: "C:\\env\\python.exe" }).id,
    started.id,
  );
  assert.equal(jobs.cancel(started.id), false);
  children[0].exit(1); // A late exit settles the cancelled job, not a failure.
  assert.equal(jobs.status(started.id)?.phase, "cancelled");
  assert.equal(jobs.status(started.id)?.cancelling, undefined);
});

test("dispose stops the installations the manager still owns", (t) => {
  const { jobs, children } = makeJobs(t);
  const started = jobs.start({ pythonPath: "C:\\env\\python.exe" });
  jobs.dispose();
  assert.equal(children[0].killed, true);
  children[0].exit(null);
  assert.equal(jobs.status(started.id)?.phase, "cancelled");
});

test("reuses the running job for the same interpreter and validates paths", (t) => {
  const { jobs } = makeJobs(t);
  const first = jobs.start({ pythonPath: "C:\\env\\python.exe" });
  const second = jobs.start({ pythonPath: "C:\\env\\python.exe" });
  assert.equal(first.id, second.id);
  assert.throws(() => jobs.start({ pythonPath: "relative\\python.exe" }));
  assert.equal(jobs.status("unknown-job"), null);
});
