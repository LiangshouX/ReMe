import { useCallback, useState, useSyncExternalStore } from "react";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";

import type { StatusRpc } from "../../client/status-page.js";
import { safeError } from "../../endpoint.js";
import type { RemeCheck } from "../types.js";
import type { ReMeSettings } from "../../types.js";
import { DependencySection, useDependency } from "./dependency.js";
import { fill, type EnvTranslator } from "./locales.js";
import { StatusBadge, type Badge } from "./presentation.js";
import { PythonSection, usePython, type PythonSelection } from "./python.js";
import {
  ServiceSection,
  useHealth,
  useService,
  type ConnectionState,
} from "./service.js";
import { WorkspaceSection, useWorkspace } from "./workspace.js";

export { envEn, envZh } from "./locales.js";
export type { EnvTranslator } from "./locales.js";

export interface ReMeEnvironmentTabProps {
  scope: ConfigForm<ReMeSettings>;
  rpc: StatusRpc;
  t: EnvTranslator;
}

/** Only a loopback HTTP endpoint can be managed as a local service. */
function isLocalEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Compare endpoints the way the Host does, so a default port or a trailing
 * slash cannot make the Host's answer look like it belongs to an older URL.
 */
function endpointKey(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    // Match the Host's loopback alias rule so `localhost` and `127.0.0.1`
    // answers compare equal.
    const host =
      url.hostname.toLowerCase() === "localhost"
        ? "127.0.0.1"
        : url.hostname.toLowerCase();
    return `${url.protocol}//${host}:${port}${url.pathname.replace(
      /\/+$/,
      "",
    )}`;
  } catch {
    return endpoint.trim();
  }
}

function connectionBadge(
  t: EnvTranslator,
  connection: ConnectionState,
  current: boolean,
): Badge {
  const label = (detail: string) => `${t("heroService")} · ${detail}`;
  if (!current || connection.phase === "loading")
    return { tone: "", text: label(t("checking")) };
  if (connection.phase === "ok")
    return {
      tone: "ok",
      text: label(
        connection.version ? `ReMe ${connection.version}` : t("connected"),
      ),
    };
  return { tone: "bad", text: label(t("disconnected")) };
}

function interpreterBadge(t: EnvTranslator, selection: PythonSelection): Badge {
  const env = selection.selectedEnv;
  if (!env)
    return {
      tone: "",
      text: `${t("heroPython")} · ${t(
        selection.detection.phase === "error" ? "noneDetected" : "noneSelected",
      )}`,
    };
  return {
    tone: env.ok ? "ok" : "progress",
    text: `${t("heroPython")} ${env.version || "?"}`,
  };
}

function remeSummaryBadge(
  t: EnvTranslator,
  check: RemeCheck | undefined,
  checking: boolean,
): Badge {
  if (!check)
    return {
      tone: "",
      text: `${t("heroReme")} · ${t(checking ? "checking" : "noneDetected")}`,
    };
  if (!check.installed)
    return {
      tone: "progress",
      text: `${t("heroReme")} · ${t("notInstalled")}`,
    };
  return {
    tone: check.versionOk && check.hasCore ? "ok" : "progress",
    text: `${t("heroReme")} ${check.version}`,
  };
}

/**
 * The Environment tab: one hero with the local-runtime summary, then the four
 * steps. Each step owns its own asynchronous state; this component only reads
 * the settings document and lays the sections out.
 */
export function ReMeEnvironmentTab({
  scope,
  rpc,
  t,
}: ReMeEnvironmentTabProps): JSX.Element | null {
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  );
  const value = snapshot.value;
  const endpoint = value?.endpoint ?? "";
  const local = isLocalEndpoint(endpoint);
  const workspaceDir = value?.remeWorkspaceDir ?? "";
  const authToken = value?.authToken ?? "";
  const [heroTick, setHeroTick] = useState(0);
  // Settings writes are invisible to the sections otherwise: a rejected
  // revision or a transport error would silently roll the control back. The
  // message carries its endpoint so a change of URL drops it without an effect.
  const [settingsError, setSettingsError] = useState<{
    endpoint: string;
    message: string;
  }>({ endpoint: "", message: "" });

  const writeSetting = useCallback(
    async (field: string, next: unknown): Promise<boolean> => {
      if (!snapshot.writable) return false;
      try {
        const applied = await scope.mutate(
          [{ op: "set", path: [field], value: next }],
          snapshot.revision,
        );
        if (applied === false) {
          setSettingsError({ endpoint, message: t("settingsWriteFailed") });
          return false;
        }
        setSettingsError({ endpoint, message: "" });
        return true;
      } catch (error) {
        setSettingsError({ endpoint, message: safeError(error) });
        return false;
      }
    },
    [endpoint, scope, snapshot.revision, snapshot.writable, t],
  );
  const settingsErrorText =
    settingsError.endpoint === endpoint ? settingsError.message : "";

  const python = usePython(rpc, {
    pythonPath: value?.pythonPath ?? "",
    writable: snapshot.writable,
    enabled: local,
    onSelect: (exe) => writeSetting("pythonPath", exe),
  });
  const dependency = useDependency(rpc, {
    pythonPath: python.selectedPath,
    enabled: local,
    onInstalled: () => {
      python.refresh();
    },
  });
  const workspace = useWorkspace(rpc, {
    workspaceDir,
    writable: snapshot.writable,
    enabled: local,
    onWorkspaceDir: (dir) => writeSetting("remeWorkspaceDir", dir),
  });
  const service = useService(rpc, {
    t,
    endpoint,
    local,
    pythonPath: python.selectedPath,
    workspaceDir,
    authToken,
  });
  // One health source per endpoint: the service probe already covers a local
  // endpoint, so only a remote URL needs its own check. Both run on the Host,
  // so the browser cannot disagree with it about what "local" means.
  const remote = useHealth({
    rpc,
    endpoint,
    enabled: !local,
    tick: heroTick,
    authToken,
  });
  // The Host names the endpoint its answer belongs to; comparing that with the
  // settings endpoint is what makes a stale answer fail the `current` test.
  const serviceEndpoint = service.state.data?.endpoint ?? endpoint;
  const serviceCurrent = endpointKey(serviceEndpoint) === endpointKey(endpoint);
  const connection: ConnectionState = local
    ? service.state.phase === "running"
      ? {
          phase: "ok",
          endpoint: serviceEndpoint,
          version: service.state.data?.version ?? "",
        }
      : service.state.phase === "checking" || service.state.phase === "starting"
      ? { phase: "loading", endpoint: serviceEndpoint }
      : {
          phase: "fail",
          endpoint: serviceEndpoint,
          error: service.state.error,
        }
    : remote;

  if (snapshot.status === "unavailable") return null;

  const current =
    connection.phase !== "loading" &&
    endpointKey(connection.endpoint) === endpointKey(endpoint);
  const ready =
    current &&
    connection.phase === "ok" &&
    (!local ||
      (dependency.checkData?.installed === true &&
        dependency.checkData.versionOk &&
        dependency.checkData.hasCore));
  const scannedAt = python.detection.data?.scannedAt
    ? Date.parse(python.detection.data.scannedAt)
    : Number.NaN;
  const scannedTime = Number.isFinite(scannedAt)
    ? new Date(scannedAt).toLocaleTimeString()
    : "";
  const { tone: healthTone, text: healthText } = connectionBadge(
    t,
    connection,
    current,
  );
  const { tone: pythonTone, text: pythonText } = interpreterBadge(t, python);
  const { tone: remeTone, text: remeText } = remeSummaryBadge(
    t,
    dependency.checkData,
    dependency.checking,
  );

  return (
    <div className="reme-env">
      <section className="reme-env-hero">
        <div className="reme-env-hero-brand">
          <span className="reme-env-hero-mark" aria-hidden="true">
            RE
          </span>
          <div className="reme-env-hero-copy">
            <span className="reme-env-eyebrow">{t("heroEyebrow")}</span>
            <h3>{t(ready ? "heroReady" : "heroSetup")}</h3>
            <p className="reme-env-hero-sub" title={endpoint}>
              {endpoint}
            </p>
          </div>
        </div>
        <div className="reme-env-hero-chips">
          <StatusBadge tone={healthTone}>{healthText}</StatusBadge>
          {local ? (
            <>
              <StatusBadge tone={pythonTone}>{pythonText}</StatusBadge>
              <StatusBadge tone={remeTone}>{remeText}</StatusBadge>
            </>
          ) : null}
        </div>
        <div className="reme-env-hero-actions">
          <button
            type="button"
            className="reme-settings-button"
            onClick={() => {
              setHeroTick((tick) => tick + 1);
              service.refresh();
            }}
          >
            {t("retest")}
          </button>
          {local ? (
            <button
              type="button"
              className="reme-settings-button"
              onClick={python.refresh}
            >
              {t("refresh")}
            </button>
          ) : null}
          {scannedTime ? (
            <span className="reme-env-hero-meta">
              {fill(t("scannedAt"), { time: scannedTime })}
            </span>
          ) : null}
        </div>
      </section>
      {current && connection.phase === "fail" && connection.error ? (
        <p className="reme-settings-error reme-env-hero-error">
          {connection.error}
        </p>
      ) : null}
      {settingsErrorText ? (
        <p className="reme-settings-error reme-env-hero-error" role="alert">
          {settingsErrorText}
        </p>
      ) : null}
      {!local ? (
        <p className="reme-settings-muted reme-env-notice">
          {t("remoteNotice")}
        </p>
      ) : (
        <>
          <PythonSection
            t={t}
            selection={python}
            writable={snapshot.writable}
          />
          <DependencySection
            t={t}
            pythonPath={python.selectedPath}
            dependency={dependency}
          />
          <WorkspaceSection
            t={t}
            workspace={workspace}
            pythonPath={python.selectedPath}
            writable={snapshot.writable}
          />
          <ServiceSection
            t={t}
            endpoint={endpoint}
            pythonPath={python.selectedPath}
            control={service}
            remeInstalled={dependency.checkData?.installed === true}
            autoStart={value?.autoStart === true}
            writable={snapshot.writable}
            current={serviceCurrent}
            onAutoStart={(checked) => {
              void writeSetting("autoStart", checked);
            }}
          />
        </>
      )}
    </div>
  );
}
