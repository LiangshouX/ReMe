import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StatusRpc } from "../../client/status-page.js";
import { safeError } from "../../endpoint.js";
import { llmBackendOf } from "../llm-backend.js";
import type { EnvEntry, EnvSummary, LlmTestResult } from "../types.js";
import { fill, type EnvKey, type EnvTranslator } from "./locales.js";
import { EnvField } from "./presentation.js";
import { envCall, parseEnvSummary, parseLlmResult } from "./rpc.js";

const LLM_BACKENDS = [
  "openai",
  "dashscope",
  "deepseek",
  "anthropic",
  "gemini",
  "moonshot",
  "ollama",
  "xai",
] as const;
const EMBEDDING_BACKENDS = [
  "openai",
  "dashscope",
  "dashscope_multimodal",
  "gemini",
  "ollama",
] as const;

interface EnvFieldSpec {
  key: string;
  label: EnvKey;
  kind: "select" | "text" | "secret";
  options?: readonly string[];
  placeholder?: string;
  hint?: EnvKey;
}

interface EnvGroup {
  title: EnvKey;
  fields: EnvFieldSpec[];
}

/**
 * The `.env` parameters this tab renders. One table drives both groups, so a
 * new model knob is a row rather than a repeated block of controls.
 */
const ENV_GROUPS: EnvGroup[] = [
  {
    title: "llmGroup",
    fields: [
      {
        key: "LLM_BACKEND",
        label: "backendLabel",
        kind: "select",
        options: LLM_BACKENDS,
      },
      {
        key: "LLM_MODEL_NAME",
        label: "modelLabel",
        kind: "text",
        placeholder: "qwen3.7-plus",
      },
      { key: "LLM_API_KEY", label: "apiKeyLabel", kind: "secret" },
      {
        key: "LLM_BASE_URL",
        label: "baseUrlLabel",
        kind: "text",
        placeholder: "https://…/v1",
      },
    ],
  },
  {
    title: "embeddingGroup",
    fields: [
      {
        key: "EMBEDDING_BACKEND",
        label: "backendLabel",
        kind: "select",
        options: EMBEDDING_BACKENDS,
      },
      {
        key: "EMBEDDING_MODEL_NAME",
        label: "modelLabel",
        kind: "text",
        placeholder: "text-embedding-v4",
      },
      { key: "EMBEDDING_API_KEY", label: "apiKeyLabel", kind: "secret" },
      {
        key: "EMBEDDING_BASE_URL",
        label: "baseUrlLabel",
        kind: "text",
        placeholder: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        hint: "embeddingHint",
      },
    ],
  },
];

interface EnvState {
  phase: "loading" | "ready" | "error";
  data?: EnvSummary;
  error?: string;
  /** Workspace this summary was read for; a mismatch makes it stale. */
  entriesFor?: string;
}

interface SaveResult {
  kind: "" | "saved" | "failed";
  message?: string;
}

interface LlmTestState {
  phase: "idle" | "running" | "ok" | "fail";
  result?: LlmTestResult;
}

interface Draft {
  /** Workspace the drafts belong to; a mismatch means they are stale. */
  dir: string;
  /** Only keys the user touched, so an untouched file stays untouched. */
  values: Record<string, string>;
}

export interface WorkspaceState {
  env: EnvState;
  workspaceInput: string | undefined;
  workspaceDraft: string;
  editWorkspace(next: string): void;
  saveWorkspace(): Promise<void>;
  value(key: string): string;
  entry(key: string): EnvEntry | undefined;
  edit(key: string, next: string): void;
  saving: boolean;
  result: SaveResult;
  save(): Promise<void>;
  llmTest: LlmTestState;
  testLlm(pythonPath: string): Promise<void>;
}

/**
 * The workspace section's asynchronous state: one `.env` read per workspace,
 * and drafts bound to the workspace they were typed in.
 */
export function useWorkspace(
  rpc: StatusRpc,
  options: {
    workspaceDir: string;
    writable: boolean;
    /** False for a remote endpoint, whose local steps are hidden. */
    enabled?: boolean;
    onWorkspaceDir(dir: string): Promise<unknown>;
  },
): WorkspaceState {
  const { workspaceDir, writable, enabled = true, onWorkspaceDir } = options;
  const [env, setEnv] = useState<EnvState>({ phase: "loading" });
  const [draft, setDraft] = useState<Draft>({ dir: "", values: {} });
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>({ kind: "" });
  const [llmTest, setLlmTest] = useState<LlmTestState>({ phase: "idle" });
  const [tick, setTick] = useState(0);
  const [workspaceInput, setWorkspaceInput] = useState<string | undefined>();
  // Read by a save that resolves after a workspace switch, so the answer for
  // the previous workspace is dropped instead of shown against the new one.
  const latestDir = useRef(workspaceDir);
  const llmController = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    latestDir.current = workspaceDir;
    // A probe for the previous workspace must not land on the new one.
    llmController.current?.abort();
  }, [workspaceDir]);

  useEffect(() => () => llmController.current?.abort(), []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const value = await envCall(
          rpc,
          "readEnv",
          { workspaceDir },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setEnv({
          phase: "ready",
          data: parseEnvSummary(value),
          entriesFor: workspaceDir,
        });
      } catch (error) {
        if (!controller.signal.aborted)
          setEnv({
            phase: "error",
            error: safeError(error),
            entriesFor: workspaceDir,
          });
      }
    })();
    return () => controller.abort();
  }, [rpc, workspaceDir, tick, enabled]);

  // A workspace switch drops drafts typed for the previous workspace, so a key
  // typed for one workspace can never be written into another. The read is
  // scoped the same way: a summary for another workspace is not this view.
  const values = useMemo(
    () => (draft.dir === workspaceDir ? draft.values : {}),
    [draft, workspaceDir],
  );
  const view = useMemo(
    () =>
      env.entriesFor === workspaceDir
        ? env
        : { phase: "loading" as const, data: undefined, error: undefined },
    [env, workspaceDir],
  );
  const entry = useCallback(
    (key: string) => view.data?.entries.find((item) => item.key === key),
    [view.data],
  );
  const value = useCallback(
    (key: string) => {
      const typed = values[key];
      if (typed !== undefined) return typed;
      const stored = entry(key);
      return stored?.secret ? "" : stored?.value ?? "";
    },
    [entry, values],
  );
  const edit = useCallback(
    (key: string, next: string) => {
      setDraft({ dir: workspaceDir, values: { ...values, [key]: next } });
      setResult({ kind: "" });
    },
    [values, workspaceDir],
  );

  const save = useCallback(async () => {
    const dir = workspaceDir;
    const pending = values;
    if (!view.data || saving) return;
    // Only touched keys travel: an untouched key keeps its stored value, and an
    // empty touched value is an explicit clear rather than "no opinion".
    const payload: Record<string, string> = { ...pending };
    const embedding = view.data.entries.find(
      (item) => item.key === "EMBEDDING_API_KEY",
    );
    if (
      embedding &&
      !embedding.set &&
      pending["EMBEDDING_API_KEY"] === undefined
    )
      payload["EMBEDDING_API_KEY"] = "EMPTY";
    setSaving(true);
    setResult({ kind: "" });
    try {
      const summary = parseEnvSummary(
        await envCall(rpc, "writeEnv", { workspaceDir: dir, values: payload }),
      );
      if (latestDir.current !== dir) return;
      setEnv({ phase: "ready", data: summary, entriesFor: dir });
      setDraft({ dir, values: {} });
      setResult({ kind: "saved" });
    } catch (error) {
      if (latestDir.current !== dir) return;
      setResult({ kind: "failed", message: safeError(error) });
    } finally {
      setSaving(false);
    }
  }, [rpc, saving, values, view.data, workspaceDir]);

  const testLlm = useCallback(
    async (pythonPath: string) => {
      if (!pythonPath || llmTest.phase === "running") return;
      const dir = workspaceDir;
      llmController.current?.abort();
      const controller = new AbortController();
      llmController.current = controller;
      setLlmTest({ phase: "running" });
      try {
        const data = parseLlmResult(
          await envCall(
            rpc,
            "testLlm",
            { workspaceDir: dir, pythonPath },
            controller.signal,
          ),
        );
        if (controller.signal.aborted || latestDir.current !== dir) return;
        setLlmTest({ phase: data.ok ? "ok" : "fail", result: data });
      } catch (error) {
        if (controller.signal.aborted || latestDir.current !== dir) return;
        setLlmTest({
          phase: "fail",
          result: {
            ok: false,
            status: 0,
            latencyMs: 0,
            error: safeError(error),
          },
        });
      } finally {
        // An aborted probe never settles into a result; without this the
        // button would stay disabled on "Testing…" until the tab remounts.
        if (controller.signal.aborted) setLlmTest({ phase: "idle" });
      }
    },
    [llmTest.phase, rpc, workspaceDir],
  );

  const saveWorkspace = useCallback(async () => {
    if (!writable) return;
    const next = workspaceInput ?? workspaceDir;
    setWorkspaceInput(undefined);
    const saved = await onWorkspaceDir(next.trim()).catch(() => false);
    // A rejected save is reported by the settings writer; do not reload the
    // old directory as if the new one had been accepted.
    if (saved === false) return;
    setTick((current) => current + 1);
  }, [onWorkspaceDir, workspaceDir, workspaceInput, writable]);

  return {
    env: view,
    workspaceInput,
    workspaceDraft: workspaceInput ?? workspaceDir,
    editWorkspace: setWorkspaceInput,
    saveWorkspace,
    value,
    entry,
    edit,
    saving,
    result,
    save,
    llmTest,
    testLlm,
  };
}

/** One `.env` control generated from the field table. */ function EnvControl({
  t,
  spec,
  workspace,
}: {
  t: EnvTranslator;
  spec: EnvFieldSpec;
  workspace: WorkspaceState;
}): JSX.Element {
  const entry = workspace.entry(spec.key);
  const hint = spec.hint ? t(spec.hint) : undefined;
  if (spec.kind === "select")
    return (
      <EnvField label={t(spec.label)}>
        <select
          value={workspace.value(spec.key)}
          onChange={(event) => workspace.edit(spec.key, event.target.value)}
        >
          <option value="">—</option>
          {envChoices(spec.options ?? [], workspace.value(spec.key)).map(
            (name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ),
          )}
        </select>
      </EnvField>
    );
  if (spec.kind === "secret")
    return (
      <EnvField
        label={t(spec.label)}
        hint={
          entry?.set
            ? fill(t("secretSet"), { masked: entry.masked })
            : t("secretUnset")
        }
      >
        <input
          type="password"
          autoComplete="off"
          value={workspace.value(spec.key)}
          placeholder={
            entry?.masked ?? (spec.key === "EMBEDDING_API_KEY" ? "EMPTY" : "")
          }
          onChange={(event) => workspace.edit(spec.key, event.target.value)}
        />
      </EnvField>
    );
  return (
    <EnvField label={t(spec.label)} hint={hint}>
      <input
        value={workspace.value(spec.key)}
        placeholder={spec.placeholder}
        onChange={(event) => workspace.edit(spec.key, event.target.value)}
      />
    </EnvField>
  );
}

/** Keep a value that is no longer offered as an option visible and selected. */
function envChoices(list: readonly string[], current: string): string[] {
  return current && !list.includes(current) ? [...list, current] : [...list];
}

/** Step 3: the workspace `.env` ReMe reads when the service starts. */
export function WorkspaceSection({
  t,
  workspace,
  pythonPath,
  writable,
}: {
  t: EnvTranslator;
  workspace: WorkspaceState;
  pythonPath: string;
  writable: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const { env, llmTest, result } = workspace;
  // The probe reads the saved .env, so a configuration that is only picked in
  // the form would be tested against the one still on disk. The button waits
  // instead of quietly testing the old configuration.
  const savedValue = (key: string): string =>
    env.data?.entries.find((entry) => entry.key === key)?.value ?? "";
  // The backend falls back to the default on both sides, so picking the
  // default in the form is not a change at all.
  const backendChanged =
    llmBackendOf(workspace.value("LLM_BACKEND")) !==
    llmBackendOf(savedValue("LLM_BACKEND"));
  // The model and the base URL travel as plain text, so they compare by
  // value. The key is write-only: a typed one is the only sign that it
  // differs from the file, which still holds the stored key.
  const configChanged =
    backendChanged ||
    workspace.value("LLM_MODEL_NAME").trim() !==
      savedValue("LLM_MODEL_NAME").trim() ||
    workspace.value("LLM_BASE_URL").trim() !==
      savedValue("LLM_BASE_URL").trim() ||
    workspace.value("LLM_API_KEY") !== "";

  return (
    <section className={`reme-env-card${open ? "" : " collapsed"}`}>
      <header>
        <span className="reme-env-step" aria-hidden="true">
          3
        </span>
        <div>
          <h4>{t("configTitle")}</h4>
          <p className="reme-env-summary">
            {env.phase === "ready" && env.data
              ? `${env.data.exists ? env.data.envPath : t("envMissing")}${
                  workspace.value("LLM_MODEL_NAME").trim()
                    ? ` · ${workspace.value("LLM_MODEL_NAME").trim()}`
                    : ""
                }`
              : t("envLoading")}
          </p>
        </div>
        <aside>
          <button
            type="button"
            className="reme-settings-button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {t(open ? "collapse" : "expand")}
          </button>
        </aside>
      </header>
      {open ? (
        <div className="reme-env-card-body">
          <p className="reme-settings-muted">{t("configHint")}</p>
          <div className="reme-settings-grid">
            <EnvField label={t("workspaceDir")} hint={t("workspaceDirHint")}>
              <div className="reme-env-inline">
                <input
                  value={workspace.workspaceDraft}
                  placeholder="~/.reme"
                  onChange={(event) =>
                    workspace.editWorkspace(event.target.value)
                  }
                />
                <button
                  type="button"
                  className="reme-settings-button"
                  disabled={!writable || workspace.saving}
                  onClick={() => void workspace.saveWorkspace()}
                >
                  {t("saveWorkspace")}
                </button>
              </div>
            </EnvField>
          </div>
          {env.phase === "loading" ? (
            <p className="reme-settings-muted">{t("envLoading")}</p>
          ) : null}
          {env.phase === "error" ? (
            <p className="reme-settings-error">
              {t("saveEnvFailed")}
              {env.error ? `: ${env.error}` : ""}
            </p>
          ) : null}
          {env.phase === "ready" && env.data ? (
            <>
              <p className="reme-settings-muted">
                {env.data.exists
                  ? `${t("envPath")}: ${env.data.envPath}`
                  : t("envMissing")}
              </p>
              <div className="reme-settings-grid reme-env-config">
                {ENV_GROUPS.map((group) => (
                  <EnvGroupFields
                    key={group.title}
                    t={t}
                    group={group}
                    workspace={workspace}
                  />
                ))}
              </div>
              <div className="reme-env-actions">
                <button
                  type="button"
                  className="reme-settings-save"
                  disabled={workspace.saving || !writable}
                  onClick={() => void workspace.save()}
                >
                  {t(workspace.saving ? "savingEnv" : "saveEnv")}
                </button>
                <button
                  type="button"
                  className="reme-settings-button"
                  disabled={
                    !pythonPath || llmTest.phase === "running" || configChanged
                  }
                  onClick={() => void workspace.testLlm(pythonPath)}
                >
                  {t(
                    llmTest.phase === "running"
                      ? "testingLlm"
                      : "testLlmButton",
                  )}
                </button>
                {configChanged ? (
                  <span className="reme-settings-muted">
                    {t("testLlmSaveFirst")}
                  </span>
                ) : null}
                <span className="reme-settings-result" role="status">
                  {result.kind === "saved" ? (
                    <span className="reme-settings-success">
                      {fill(t("savedEnv"), { path: env.data.envPath })}
                    </span>
                  ) : null}
                  {result.kind === "failed" ? (
                    <span className="reme-settings-error">
                      {`${t("saveEnvFailed")}${
                        result.message ? `: ${result.message}` : ""
                      }`}
                    </span>
                  ) : null}
                  {llmTest.phase === "ok" && llmTest.result ? (
                    <span className="reme-settings-success">
                      {fill(t("llmOk"), { ms: llmTest.result.latencyMs })}
                    </span>
                  ) : null}
                  {llmTest.phase === "fail" && llmTest.result ? (
                    <span className="reme-settings-error">
                      {`${t("llmFailed")}${
                        llmTest.result.error ? `: ${llmTest.result.error}` : ""
                      }`}
                    </span>
                  ) : null}
                </span>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** One titled group of `.env` controls. */
function EnvGroupFields({
  t,
  group,
  workspace,
}: {
  t: EnvTranslator;
  group: EnvGroup;
  workspace: WorkspaceState;
}): JSX.Element {
  return (
    <>
      <h5 className="reme-env-group">{t(group.title)}</h5>
      {group.fields.map((spec) => (
        <EnvControl key={spec.key} t={t} spec={spec} workspace={workspace} />
      ))}
    </>
  );
}
