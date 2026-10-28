import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { act, create } from "react-test-renderer";

import { ReMeEnvironmentTab, envZh } from "../dist/environment/client/tab.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CONDA = "D:\\ProgramFils\\Miniconda";
const SUGGESTED = `${CONDA}\\envs\\reme-serve\\python.exe`;

function env(name, version, reme) {
  const root = name === "base" ? CONDA : `${CONDA}\\envs\\${name}`;
  return {
    exe: `${root}\\python.exe`,
    version,
    ok: true,
    origin: { kind: "conda", envName: name, root },
    source: "conda env list",
    ...(reme ? { reme: { installed: true, version: reme } } : {}),
  };
}

const ENVS = [
  env("base", "3.12.3", "0.4.0.9"),
  env("com_env", "3.12.9"),
  env("copaw", "3.12.0", "0.3.1.8"),
  env("drama", "3.12.13"),
  env("mochi", "3.12.13"),
  env("mochi_test", "3.12.13"),
  env("nl_agent", "3.12.0"),
  env("reme-serve", "3.12.13", "0.4.0.9"),
];

const RESPONSES = {
  "remeEnv/python": {
    platform: "win32",
    scannedAt: new Date().toISOString(),
    envs: ENVS,
    suggested: SUGGESTED,
    condaRoot: CONDA,
    errors: [],
  },
  "remeEnv/checkReme": {
    installed: true,
    version: "0.4.0.9",
    versionOk: true,
    hasCore: true,
    cliPath: `${CONDA}\\envs\\reme-serve\\Scripts\\reme.exe`,
    error: "",
  },
  "remeEnv/installStatus": null,
  "remeEnv/readEnv": {
    workspaceDir: "C:\\Users\\test\\.reme",
    exists: true,
    envPath: "C:\\Users\\test\\.reme\\.env",
    entries: [
      {
        key: "LLM_BACKEND",
        value: "dashscope",
        masked: "dashscope",
        secret: false,
        set: true,
      },
      {
        key: "LLM_MODEL_NAME",
        value: "qwen3.7-plus",
        masked: "qwen3.7-plus",
        secret: false,
        set: true,
      },
    ],
  },
  "remeEnv/serviceStatus": {
    phase: "running",
    version: "0.4.0.9",
    managed: false,
    pid: 98820,
    endpoint: "http://127.0.0.1:2333",
    logPath: "C:\\Users\\test\\.reme\\service.log",
  },
};

const t = (key) => envZh[key];

function textOf(value) {
  if (Array.isArray(value)) return value.map(textOf).join("");
  return typeof value === "string" ? value : "";
}

function classesOf(node, found = new Map()) {
  if (!node || typeof node === "string") return found;
  if (Array.isArray(node)) {
    node.forEach((child) => classesOf(child, found));
    return found;
  }
  for (const name of String(node.props.className ?? "").split(" ")) {
    if (name) found.set(name, (found.get(name) ?? 0) + 1);
  }
  (node.children ?? []).forEach((child) => classesOf(child, found));
  return found;
}

function texts(node, found = []) {
  if (!node) return found;
  if (typeof node === "string") {
    found.push(node);
    return found;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => texts(child, found));
    return found;
  }
  (node.children ?? []).forEach((child) => texts(child, found));
  return found;
}

async function mount(overrides = {}, options = {}) {
  const calls = { mutate: [], rpc: [] };
  const responses = { ...RESPONSES, ...(options.responses ?? {}) };
  const listeners = new Set();
  // A new object per change, the way the Host-backed form publishes a snapshot.
  let snapshot = {
    status: "ready",
    writable: true,
    revision: 3,
    value: {
      endpoint: "http://127.0.0.1:2333",
      pythonPath: "",
      remeWorkspaceDir: "",
      autoStart: false,
      requestTimeoutMs: 10000,
      backgroundTimeoutMs: 3600000,
      ...overrides,
    },
  };
  const scope = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    mutate: async (ops, revision) => {
      calls.mutate.push({ ops, revision });
      return options.mutate ? options.mutate() : true;
    },
  };
  const rpc = {
    call: async (_path, method, payload, signal) => {
      calls.rpc.push({ method, input: payload?.args?.input });
      if (options.pending?.includes(method))
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      const value = responses[method];
      return {
        ok: true,
        value:
          typeof value === "function"
            ? value(payload?.args?.input, signal)
            : value ?? null,
      };
    },
  };

  let renderer;
  await act(async () => {
    renderer = create(
      React.createElement(ReMeEnvironmentTab, { scope, rpc, t }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return {
    renderer,
    calls,
    setValue(patch) {
      snapshot = {
        ...snapshot,
        value: { ...snapshot.value, ...patch },
      };
      for (const listener of listeners) listener();
    },
    restore: () => {
      // Unmount so the effect cleanup paths (aborts, timers) actually run.
      act(() => {
        renderer.unmount();
      });
      listeners.clear();
    },
  };
}

function buttonByText(renderer, label) {
  const found = renderer.root.findAll(
    (node) => node.type === "button" && textOf(node.props.children) === label,
  );
  assert.ok(found.length > 0, `button not found: ${label}`);
  return found[0];
}

test("renders the status hero and the four setup steps", async (t) => {
  const { renderer, restore } = await mount();
  t.after(restore);
  const json = renderer.toJSON();
  const classes = classesOf(json);
  const copy = texts(json).join(" ");

  assert.equal(classes.get("reme-env-hero"), 1);
  assert.equal(classes.get("reme-env-card"), 4);
  assert.equal(classes.get("reme-env-picked"), 1);
  assert.equal(classes.get("reme-env-metrics"), 1);
  assert.equal(classes.get("reme-env-autostart"), 1);

  assert.match(copy, /ReMe 本地运行时/);
  assert.match(copy, /已就绪，记忆保存在本地/);
  assert.match(copy, /http:\/\/127\.0\.0\.1:2333/);
  assert.match(copy, /8 个环境/);
  assert.match(copy, /服务 · ReMe 0\.4\.0\.9/);
  assert.match(copy, /Python 3\.12\.13/);
  assert.match(copy, /reme-ai 0\.4\.0\.9/);
  assert.match(copy, /C:\\Users\\test\\\.reme\\\.env/);
});

test("keeps the interpreter list collapsed until asked, then paginates", async (t) => {
  const { renderer, restore } = await mount();
  t.after(restore);
  assert.equal(classesOf(renderer.toJSON()).get("reme-env-option"), undefined);

  await act(async () => {
    buttonByText(renderer, envZh.changeInterpreter).props.onClick();
  });
  const expanded = classesOf(renderer.toJSON());
  assert.equal(expanded.get("reme-env-option"), 6);
  assert.equal(expanded.get("reme-env-search"), 1);
  assert.equal(expanded.get("reme-env-more"), 1);

  await act(async () => {
    renderer.root
      .findAll(
        (node) =>
          node.type === "button" && textOf(node.props.children).includes("7"),
      )[0]
      .props.onClick();
  });
  assert.equal(classesOf(renderer.toJSON()).get("reme-env-option"), 7);
});

test("marks the suggested interpreter and explains why", async (t) => {
  const { renderer, calls, restore } = await mount();
  t.after(restore);
  const json = renderer.toJSON();
  const recommended = renderer.root.findAll(
    (node) =>
      String(node.props.className ?? "").includes("reme-env-tag brand") &&
      textOf(node.props.children) === envZh.recommended,
  );
  assert.ok(recommended.length >= 1);
  assert.equal(recommended[0].props.title, envZh.recommendWhyReme);
  assert.ok(texts(json).join(" ").includes(SUGGESTED));

  await act(async () => {
    buttonByText(renderer, envZh.changeInterpreter).props.onClick();
  });
  const radios = renderer.root.findAll(
    (node) => node.type === "input" && node.props.type === "radio",
  );
  const target = radios.find((node) => node.props.disabled === false);
  assert.ok(target);
  await act(async () => {
    target.props.onChange();
  });
  assert.deepEqual(calls.mutate.at(-1)?.ops, [
    { op: "set", path: ["pythonPath"], value: ENVS[0].exe },
  ]);
});

test("sends the chosen package mirror with the install request", async (t) => {
  const { renderer, calls, restore } = await mount();
  t.after(restore);

  const select = renderer.root.findAll((node) => node.type === "select")[0];
  await act(async () => {
    select.props.onChange({
      target: { value: "https://pypi.tuna.tsinghua.edu.cn/simple" },
    });
  });
  await act(async () => {
    buttonByText(renderer, envZh.reinstall).props.onClick();
  });
  await act(async () => {
    buttonByText(renderer, envZh.confirmInstall).props.onClick();
  });

  const install = calls.rpc.filter((call) => call.method === "remeEnv/install");
  assert.ok(install.length > 0, "the install request must be sent");
  assert.deepEqual(install.at(-1).input, {
    pythonPath: SUGGESTED,
    upgrade: false,
    indexUrl: "https://pypi.tuna.tsinghua.edu.cn/simple",
    forceReinstall: true,
  });
});

test("drops .env drafts when the workspace changes", async (t) => {
  const { renderer, calls, setValue, restore } = await mount();
  t.after(restore);

  await act(async () => {
    buttonByText(renderer, envZh.expand).props.onClick();
  });
  const apiKey = () =>
    renderer.root.findAll(
      (node) => node.type === "input" && node.props.type === "password",
    )[0];
  await act(async () => {
    apiKey().props.onChange({
      target: { value: "sk-typed-for-first-workspace" },
    });
  });
  assert.equal(apiKey().props.value, "sk-typed-for-first-workspace");

  await act(async () => {
    setValue({ remeWorkspaceDir: "/tmp/second-workspace" });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  // The draft belonged to the first workspace and is gone with it, so a save
  // cannot carry a key typed for one workspace into another.
  assert.equal(apiKey().props.value, "");

  await act(async () => {
    buttonByText(renderer, envZh.saveEnv).props.onClick();
  });
  const write = calls.rpc
    .filter((call) => call.method === "remeEnv/writeEnv")
    .at(-1);
  assert.ok(write);
  assert.equal(write.input.workspaceDir, "/tmp/second-workspace");
  assert.deepEqual(write.input.values, {});
});

test("probes the service from the Host, never from the browser", async (t) => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    throw new Error("the tab must not fetch the service URL itself");
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const { renderer, calls, restore } = await mount();
  t.after(restore);
  assert.equal(fetched, 0);
  assert.match(
    texts(renderer.toJSON()).join(" "),
    /服务 · ReMe 0\.4\.0\.9/,
    "the hero reports the version the Host service probe returned",
  );
  assert.ok(
    calls.rpc.some((call) => call.method === "remeEnv/serviceStatus"),
    "the hero reads its connection from the Host service probe",
  );
  assert.equal(
    calls.rpc.some((call) => call.method === "remeEnv/health"),
    false,
    "a local endpoint is covered by the service probe already",
  );
});

test("a remote endpoint never runs the local setup steps", async (t) => {
  const { calls, restore } = await mount(
    { endpoint: "http://10.0.0.5:2333" },
    {
      responses: {
        "remeEnv/health": {
          endpoint: "http://10.0.0.5:2333",
          ok: false,
          version: "",
          error: "unreachable",
          checkedAt: new Date().toISOString(),
        },
      },
    },
  );
  t.after(restore);
  const methods = calls.rpc.map((call) => call.method);
  assert.ok(
    methods.includes("remeEnv/health"),
    "a remote endpoint is only health-checked",
  );
  for (const local of [
    "remeEnv/python",
    "remeEnv/checkReme",
    "remeEnv/readEnv",
    "remeEnv/serviceStatus",
  ])
    assert.equal(methods.includes(local), false, `${local} must not run`);
});

test("shows why Stop left the service alone", async (t) => {
  const { renderer, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/serviceStatus": {
          phase: "running",
          managed: true,
          pid: 98820,
          version: "0.4.0.9",
          endpoint: "http://127.0.0.1:2333",
          logPath: "C:\\Users\\test\\.reme\\service.log",
        },
        "remeEnv/serviceStop": {
          stopped: false,
          reason: "The recorded process identity could not be verified",
          code: "unverified",
        },
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.stopService).props.onClick();
  });
  await act(async () => {
    buttonByText(renderer, envZh.stopService).props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  // The Host code is localized in the UI instead of leaking its English text.
  assert.ok(
    texts(renderer.toJSON()).join(" ").includes(envZh.stopUnknownIdentity),
  );
});

test("surfaces a rejected settings write", async (t) => {
  const { renderer, restore } = await mount({}, { mutate: async () => false });
  t.after(restore);
  const checkbox = renderer.root.findAll(
    (node) => node.type === "input" && node.props.type === "checkbox",
  )[0];
  assert.ok(checkbox);
  await act(async () => {
    checkbox.props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.match(texts(renderer.toJSON()).join(" "), /设置未保存/);
});

test("an aborted LLM test releases its button", async (t) => {
  const { renderer, setValue, restore } = await mount(
    {},
    { pending: ["remeEnv/testLlm"] },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.expand).props.onClick();
  });
  await act(async () => {
    buttonByText(renderer, envZh.testLlmButton).props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.ok(texts(renderer.toJSON()).join(" ").includes(envZh.testingLlm));

  await act(async () => {
    setValue({ remeWorkspaceDir: "/tmp/second-workspace" });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const copy = texts(renderer.toJSON()).join(" ");
  assert.equal(copy.includes(envZh.testingLlm), false);
  assert.ok(copy.includes(envZh.testLlmButton), "the button is usable again");
});

test("a start that died before listening reports immediately", async (t) => {
  const stopped = {
    phase: "stopped",
    managed: false,
    endpoint: "http://127.0.0.1:2333",
    logPath: "C:\\Users\\test\\.reme\\service.log",
  };
  const { renderer, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/serviceStatus": stopped,
        "remeEnv/serviceStart": {
          started: true,
          alreadyRunning: false,
          command: "",
          logPath: stopped.logPath,
          startedAt: new Date().toISOString(),
        },
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.startService).props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  });
  const copy = texts(renderer.toJSON()).join(" ");
  assert.ok(copy.includes(envZh.startFailedStopped));
  // The message is already a complete sentence; prefixing it would read
  // "Service operation failed: The service exited…".
  assert.equal(copy.includes(`${envZh.serviceError}:`), false);
  // Ready to retry without waiting out the 120 s deadline.
  assert.ok(buttonByText(renderer, envZh.startService));
});

test("a start that lands on a foreign conflict shows the conflict state", async (t) => {
  let calls = 0;
  const states = [
    {
      phase: "stopped",
      managed: false,
      endpoint: "http://127.0.0.1:2333",
      logPath: "C:\\Users\\test\\.reme\\service.log",
    },
    {
      phase: "conflict",
      managed: false,
      endpoint: "http://127.0.0.1:2333",
      logPath: "C:\\Users\\test\\.reme\\service.log",
    },
  ];
  const { renderer, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/serviceStatus": () =>
          states[Math.min(calls++, states.length - 1)],
        "remeEnv/serviceStart": {
          started: true,
          alreadyRunning: false,
          command: "",
          logPath: states[0].logPath,
          startedAt: new Date().toISOString(),
        },
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.startService).props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  });
  assert.ok(texts(renderer.toJSON()).join(" ").includes(envZh.conflictNote));
});

test("Reinstall forces a reinstall while install and upgrade use the right flags", async () => {
  const upgrade = await mount(
    {},
    {
      responses: {
        "remeEnv/checkReme": {
          installed: true,
          version: "0.3.1.8",
          versionOk: false,
          hasCore: false,
          cliPath: "",
          error: "",
        },
      },
    },
  );
  await act(async () => {
    buttonByText(upgrade.renderer, envZh.upgradeButton).props.onClick();
  });
  await act(async () => {
    buttonByText(upgrade.renderer, envZh.confirmInstall).props.onClick();
  });
  const upgradeCall = upgrade.calls.rpc
    .filter((call) => call.method === "remeEnv/install")
    .at(-1);
  assert.deepEqual(upgradeCall.input, {
    pythonPath: SUGGESTED,
    upgrade: true,
  });
  upgrade.restore();

  const fresh = await mount(
    {},
    {
      responses: {
        "remeEnv/checkReme": {
          installed: false,
          version: "",
          versionOk: false,
          hasCore: false,
          cliPath: "",
          error: "",
        },
      },
    },
  );
  await act(async () => {
    buttonByText(fresh.renderer, envZh.installButton).props.onClick();
  });
  await act(async () => {
    buttonByText(fresh.renderer, envZh.confirmInstall).props.onClick();
  });
  const freshCall = fresh.calls.rpc
    .filter((call) => call.method === "remeEnv/install")
    .at(-1);
  assert.deepEqual(freshCall.input, {
    pythonPath: SUGGESTED,
    upgrade: false,
  });
  fresh.restore();

  const reinstall = await mount();
  await act(async () => {
    buttonByText(reinstall.renderer, envZh.reinstall).props.onClick();
  });
  // The confirmation copy follows the Reinstall CTA, not the first-install one.
  assert.ok(
    texts(reinstall.renderer.toJSON())
      .join(" ")
      .includes(envZh.reinstallConfirm.split("{path}")[0]),
  );
  await act(async () => {
    buttonByText(reinstall.renderer, envZh.confirmInstall).props.onClick();
  });
  const reinstallCall = reinstall.calls.rpc
    .filter((call) => call.method === "remeEnv/install")
    .at(-1);
  assert.deepEqual(reinstallCall.input, {
    pythonPath: SUGGESTED,
    upgrade: false,
    forceReinstall: true,
  });
  reinstall.restore();
});

test("localizes a coded start error instead of showing Host English", async (t) => {
  const stopped = {
    phase: "stopped",
    managed: false,
    endpoint: "http://127.0.0.1:2333",
    logPath: "C:\\Users\\test\\.reme\\service.log",
  };
  const { renderer, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/serviceStatus": stopped,
        "remeEnv/serviceStart": {
          started: false,
          alreadyRunning: false,
          error: "Another process is already listening on this endpoint",
          code: "conflict",
          command: "",
          logPath: stopped.logPath,
          startedAt: new Date().toISOString(),
        },
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.startService).props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const copy = texts(renderer.toJSON()).join(" ");
  assert.ok(copy.includes(envZh.startErrorConflict));
  assert.equal(copy.includes("Another process is already listening"), false);
});

test("switching the endpoint aborts the previous start poll", async (t) => {
  const OLD = "http://127.0.0.1:2333";
  const NEW = "http://127.0.0.1:2444";
  const stopped = {
    phase: "stopped",
    managed: false,
    endpoint: OLD,
    logPath: "C:\\Users\\test\\.reme\\service.log",
  };
  const newRunning = {
    phase: "running",
    managed: true,
    pid: 1111,
    endpoint: NEW,
    version: "9.9.9",
    logPath: "C:\\Users\\test\\.reme\\service.log",
  };
  const oldRunning = {
    ...newRunning,
    pid: 5000,
    endpoint: OLD,
    version: "0.4.0.9",
  };
  let statusCalls = 0;
  const { renderer, setValue, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/serviceStatus": (input) => {
          if (input?.endpoint === NEW) return newRunning;
          statusCalls += 1;
          return statusCalls === 1 ? stopped : oldRunning;
        },
        "remeEnv/serviceStart": {
          started: true,
          alreadyRunning: false,
          command: "",
          logPath: stopped.logPath,
          startedAt: new Date().toISOString(),
        },
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.startService).props.onClick();
  });
  // Switch before the poll's 1 s tick: it must not paint the old endpoint's
  // running data under the new URL.
  await act(async () => {
    setValue({ endpoint: NEW });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  });
  const copy = texts(renderer.toJSON()).join(" ");
  assert.ok(copy.includes("PID 1111"), "the new endpoint's pid is shown");
  assert.equal(copy.includes("PID 5000"), false);
});

test("a live record that never listened offers Stop instead of 'Starting'", async (t) => {
  // The Host reports a recorded launch that is still alive but not listening
  // as `stopped` + pid. Mapping that to `starting` on every read used to lock
  // the card: Start disabled, no Stop, and Recheck repeated the same answer.
  const stale = {
    phase: "stopped",
    managed: false,
    pid: 6000,
    endpoint: "http://127.0.0.1:2333",
    logPath: "C:\\Users\\test\\.reme\\service.log",
  };
  const { renderer, restore } = await mount(
    {},
    { responses: { "remeEnv/serviceStatus": stale } },
  );
  t.after(restore);
  const copy = texts(renderer.toJSON()).join(" ");
  assert.equal(copy.includes(envZh.serviceBadgeStarting), false);
  assert.ok(copy.includes(envZh.serviceBadgeStale));
  assert.ok(copy.includes(envZh.staleNote));
  // Stop is the way out for a provably owned leftover...
  const stop = buttonByText(renderer, envZh.stopService);
  assert.equal(stop.props.disabled, false, "the recorded pid can be stopped");
  // ...and Start must stay available too: the pid may have been recycled by a
  // foreign process, where Stop refuses and only a restart self-heals.
  const start = buttonByText(renderer, envZh.startService);
  assert.equal(start.props.disabled, false, "Start can replace the record");
});

test("Start replaces a stale record that belongs to a foreign pid", async (t) => {
  // The pid is alive but no longer our service, so Stop answers `foreign` and
  // keeps the record. Start must still be offered: the Host discards a foreign
  // record and launches a fresh service.
  const stale = {
    phase: "stopped",
    managed: false,
    pid: 6000,
    endpoint: "http://127.0.0.1:2333",
    logPath: "C:\\Users\\test\\.reme\\service.log",
  };
  const running = {
    phase: "running",
    managed: true,
    pid: 7000,
    version: "0.4.0.9",
    endpoint: "http://127.0.0.1:2333",
    logPath: stale.logPath,
  };
  let statusCalls = 0;
  const { renderer, calls, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/serviceStatus": () => {
          statusCalls += 1;
          return statusCalls === 1 ? stale : running;
        },
        "remeEnv/serviceStart": {
          started: true,
          alreadyRunning: false,
          command: "",
          logPath: stale.logPath,
          startedAt: new Date().toISOString(),
        },
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.startService).props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  });
  assert.ok(
    calls.rpc.some((call) => call.method === "remeEnv/serviceStart"),
    "the restart really reached the Host",
  );
  const copy = texts(renderer.toJSON()).join(" ");
  assert.ok(copy.includes("ReMe 0.4.0.9"));
  assert.ok(copy.includes("PID 7000"));
});

test("an owned conflict during a start keeps polling until healthy", async (t) => {
  const stop = (pid) => ({
    phase: "stopped",
    managed: false,
    ...(pid === undefined ? {} : { pid }),
    endpoint: "http://127.0.0.1:2333",
    logPath: "C:\\Users\\test\\.reme\\service.log",
  });
  const conflict = {
    phase: "conflict",
    managed: true,
    pid: 6000,
    endpoint: "http://127.0.0.1:2333",
    logPath: "C:\\Users\\test\\.reme\\service.log",
  };
  const running = {
    phase: "running",
    managed: true,
    pid: 6000,
    version: "0.4.0.9",
    endpoint: "http://127.0.0.1:2333",
    logPath: "C:\\Users\\test\\.reme\\service.log",
  };
  let statusCalls = 0;
  const { renderer, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/serviceStatus": () => {
          statusCalls += 1;
          if (statusCalls === 1) return stop();
          if (statusCalls === 2) return conflict;
          return running;
        },
        "remeEnv/serviceStart": {
          started: true,
          alreadyRunning: false,
          command: "",
          logPath: running.logPath,
          startedAt: new Date().toISOString(),
        },
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.startService).props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  });
  // One owned conflict is our own launch booting; it must not become a Stop
  // offer that would kill a service which is about to answer.
  assert.ok(
    texts(renderer.toJSON()).join(" ").includes(envZh.serviceBadgeStarting),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  });
  const copy = texts(renderer.toJSON()).join(" ");
  assert.ok(copy.includes("ReMe 0.4.0.9"));
  assert.equal(copy.includes(envZh.conflictManagedNote), false);
});

test("a Host conflict refusal shows the conflict card, not an error", async (t) => {
  const stopped = {
    phase: "stopped",
    managed: false,
    endpoint: "http://127.0.0.1:2333",
    logPath: "C:\\Users\\test\\.reme\\service.log",
  };
  const conflict = {
    phase: "conflict",
    managed: false,
    endpoint: "http://127.0.0.1:2333",
    logPath: stopped.logPath,
  };
  let statusCalls = 0;
  const { renderer, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/serviceStatus": () => {
          statusCalls += 1;
          return statusCalls === 1 ? stopped : conflict;
        },
        "remeEnv/serviceStart": {
          started: false,
          alreadyRunning: false,
          error: "Another process is already listening on this endpoint",
          code: "conflict",
          command: "",
          logPath: stopped.logPath,
          startedAt: new Date().toISOString(),
        },
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.startService).props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const copy = texts(renderer.toJSON()).join(" ");
  assert.ok(copy.includes(envZh.conflictNote));
  assert.equal(copy.includes(envZh.startErrorConflict), false);
});

test("a slow status answer does not overwrite a finished start", async (t) => {
  const stopped = {
    phase: "stopped",
    managed: false,
    endpoint: "http://127.0.0.1:2333",
    logPath: "C:\\Users\\test\\.reme\\service.log",
  };
  const running = {
    phase: "running",
    managed: true,
    pid: 7000,
    version: "0.4.0.9",
    endpoint: "http://127.0.0.1:2333",
    logPath: stopped.logPath,
  };
  let statusCalls = 0;
  const { renderer, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/serviceStatus": () => {
          statusCalls += 1;
          if (statusCalls === 1) return stopped;
          // The manual Recheck answers late, after the start poll has settled.
          if (statusCalls === 2)
            return new Promise((resolve) =>
              setTimeout(() => resolve(stopped), 1_500),
            );
          return running;
        },
        "remeEnv/serviceStart": {
          started: true,
          alreadyRunning: false,
          command: "",
          logPath: stopped.logPath,
          startedAt: new Date().toISOString(),
        },
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.startService).props.onClick();
  });
  const rechecks = renderer.root.findAll(
    (node) =>
      node.type === "button" && textOf(node.props.children) === envZh.recheck,
  );
  await act(async () => {
    rechecks.at(-1).props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_300));
  });
  const copy = texts(renderer.toJSON()).join(" ");
  assert.ok(copy.includes("ReMe 0.4.0.9"));
  assert.equal(copy.includes(envZh.serviceBadgeStopped), false);
});

test("a Stop result for the previous endpoint is dropped", async (t) => {
  const OLD = "http://127.0.0.1:2333";
  const NEW = "http://127.0.0.1:2444";
  const oldRunning = {
    phase: "running",
    managed: true,
    pid: 5000,
    version: "0.4.0.9",
    endpoint: OLD,
    logPath: "C:\\Users\\test\\.reme\\service.log",
  };
  const newRunning = {
    ...oldRunning,
    pid: 1111,
    version: "9.9.9",
    endpoint: NEW,
  };
  let release;
  const stopResult = new Promise((resolve) => {
    release = resolve;
  });
  const { renderer, setValue, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/serviceStatus": (input) =>
          input?.endpoint === NEW ? newRunning : oldRunning,
        "remeEnv/serviceStop": () => stopResult,
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.stopService).props.onClick();
  });
  await act(async () => {
    buttonByText(renderer, envZh.stopService).props.onClick();
  });
  await act(async () => {
    setValue({ endpoint: NEW });
  });
  await act(async () => {
    release({
      stopped: false,
      reason: "could not be verified",
      code: "unverified",
    });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const copy = texts(renderer.toJSON()).join(" ");
  assert.equal(copy.includes(envZh.stopUnknownIdentity), false);
  const stops = renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      textOf(node.props.children) === envZh.stopService,
  );
  assert.ok(stops.length > 0);
  assert.equal(stops[0].props.disabled, false);
});

test("localizes a Host health failure code", async (t) => {
  const { renderer, restore } = await mount(
    { endpoint: "http://10.0.0.5:2333" },
    {
      responses: {
        "remeEnv/health": {
          endpoint: "http://10.0.0.5:2333",
          ok: false,
          version: "",
          error: "The endpoint did not answer with a ReMe health report",
          code: "not-reme",
          checkedAt: new Date().toISOString(),
        },
      },
    },
  );
  t.after(restore);
  const copy = texts(renderer.toJSON()).join(" ");
  assert.ok(copy.includes(envZh.healthErrorNotReme));
  assert.equal(
    copy.includes("did not answer with a ReMe health report"),
    false,
  );
});

test("a Python refresh keeps the previous interpreter list on screen", async (t) => {
  let pythonCalls = 0;
  const { renderer, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/python": () => {
          pythonCalls += 1;
          // The refresh never answers; the previous detection must stay.
          return pythonCalls === 1
            ? RESPONSES["remeEnv/python"]
            : new Promise(() => {});
        },
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.changeInterpreter).props.onClick();
  });
  assert.equal(classesOf(renderer.toJSON()).get("reme-env-option"), 6);
  await act(async () => {
    buttonByText(renderer, envZh.refresh).props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const copy = texts(renderer.toJSON()).join(" ");
  assert.equal(copy.includes(envZh.emptyTitle), false);
  assert.equal(classesOf(renderer.toJSON()).get("reme-env-option"), 6);
});

test("a failed Python refresh keeps the working list without the empty state", async (t) => {
  let pythonCalls = 0;
  const { renderer, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/python": () => {
          pythonCalls += 1;
          if (pythonCalls === 1) return RESPONSES["remeEnv/python"];
          throw new Error("probe exploded");
        },
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.changeInterpreter).props.onClick();
  });
  assert.equal(classesOf(renderer.toJSON()).get("reme-env-option"), 6);
  await act(async () => {
    buttonByText(renderer, envZh.refresh).props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const copy = texts(renderer.toJSON()).join(" ");
  assert.ok(copy.includes(envZh.detectFailed));
  // A failed probe that still has the previous result must not claim that no
  // Python exists, nor offer Miniconda next to a valid interpreter list.
  assert.equal(copy.includes(envZh.emptyTitle), false);
  assert.equal(classesOf(renderer.toJSON()).get("reme-env-option"), 6);
});

test("the conflict fallback of a start does not paint an aborted request", async (t) => {
  const OLD = "http://127.0.0.1:2333";
  const NEW = "http://127.0.0.1:2444";
  const stopped = {
    phase: "stopped",
    managed: false,
    endpoint: OLD,
    logPath: "C:\\Users\\test\\.reme\\service.log",
  };
  const newRunning = {
    phase: "running",
    managed: true,
    pid: 1111,
    version: "9.9.9",
    endpoint: NEW,
    logPath: stopped.logPath,
  };
  let statusCalls = 0;
  const { renderer, setValue, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/serviceStatus": (input, signal) => {
          if (input?.endpoint === NEW) return newRunning;
          statusCalls += 1;
          if (statusCalls === 1) return stopped;
          // The R3 re-query hangs until the endpoint switch aborts it.
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          });
        },
        "remeEnv/serviceStart": {
          started: false,
          alreadyRunning: false,
          error: "Another process is already listening on this endpoint",
          code: "conflict",
          command: "",
          logPath: stopped.logPath,
          startedAt: new Date().toISOString(),
        },
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.startService).props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => {
    setValue({ endpoint: NEW });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const copy = texts(renderer.toJSON()).join(" ");
  assert.ok(copy.includes("ReMe 9.9.9"), "the new endpoint state is shown");
  // The old endpoint's conflict error must not land on the new card.
  assert.equal(copy.includes(envZh.startErrorConflict), false);
});

test("an unverified record reports the pid it refused to touch", async (t) => {
  const stopped = {
    phase: "stopped",
    managed: false,
    endpoint: "http://127.0.0.1:2333",
    logPath: "C:\\Users\\test\\.reme\\service.log",
  };
  const { renderer, restore } = await mount(
    {},
    {
      responses: {
        "remeEnv/serviceStatus": stopped,
        "remeEnv/serviceStart": {
          started: false,
          alreadyRunning: false,
          error: "The recorded service identity could not be verified",
          code: "unverified-record",
          pid: 6000,
          command: "",
          logPath: stopped.logPath,
          startedAt: new Date().toISOString(),
        },
      },
    },
  );
  t.after(restore);
  await act(async () => {
    buttonByText(renderer, envZh.startService).props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const copy = texts(renderer.toJSON()).join(" ");
  assert.ok(copy.includes("PID 6000"));
  assert.ok(copy.includes("6000"));
  assert.equal(copy.includes("The recorded service identity"), false);
});
