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
  },
  "remeEnv/installStatus": null,
  "remeEnv/readEnv": {
    exists: true,
    envPath: "C:\\Users\\test\\.reme\\.env",
    entries: [
      { key: "LLM_BACKEND", value: "dashscope", secret: false, set: true },
      {
        key: "LLM_MODEL_NAME",
        value: "qwen3.7-plus",
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

async function mount(overrides = {}) {
  const calls = { mutate: [], rpc: [] };
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
      return true;
    },
  };
  const rpc = {
    call: async (_path, method, payload) => {
      calls.rpc.push({ method, input: payload?.args?.input });
      return { ok: true, value: RESPONSES[method] ?? null };
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
    restore: () => listeners.clear(),
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
