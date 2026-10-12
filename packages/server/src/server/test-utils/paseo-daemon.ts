import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";

import pino from "pino";
import {
  createPaseoDaemon,
  type PaseoDaemonConfig,
  type PaseoOpenAIConfig,
  type PaseoSpeechConfig,
} from "../bootstrap.js";
import type { AgentClient, AgentProvider } from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "./fake-agent-client.js";
import type { PushNotificationSender } from "../push/index.js";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { OmpAgentClient } from "../agent/providers/omp/agent.js";
import { OmpCliRuntime } from "../agent/providers/omp/cli-runtime.js";
import {
  OMP_HOST_ACCOUNT_ROUTING_ENV,
  type OmpRpcAdmitDecision,
} from "../agent/providers/omp/rpc-types.js";
import type { OmpRoutingAuthority } from "../agent/providers/omp/account-routing-bridge.js";
import {
  FakeOmpChild,
  type FakeOmpChildOptions,
} from "../agent/providers/omp/test-utils/fake-omp.js";
import type { AccountRoutingAuthority } from "../account-routing/authority.js";
import type { RoutingCatalog } from "../account-routing/types.js";
import type { OmpRoutingBlock } from "@getpaseo/protocol/messages";

interface TestPaseoDaemonOptions {
  daemonVersion?: string;
  desktopManaged?: boolean;
  downloadTokenTtlMs?: number;
  corsAllowedOrigins?: string[];
  listen?: string;
  listenPort?: number;
  logger?: Parameters<typeof createPaseoDaemon>[1];
  mcpEnabled?: boolean;
  mcpDebug?: boolean;
  isDev?: boolean;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  daemonStatusRpcCapability?: boolean;
  relayConfigCapability?: boolean;
  agentClients?: Partial<Record<AgentProvider, AgentClient>>;
  providerOverrides?: PaseoDaemonConfig["providerOverrides"];
  paseoHomeRoot?: string;
  staticDir?: string;
  cleanup?: boolean;
  openai?: PaseoOpenAIConfig;
  speech?: PaseoSpeechConfig;
  voiceLlmProvider?: PaseoDaemonConfig["voiceLlmProvider"];
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  auth?: PaseoDaemonConfig["auth"];
  pushNotificationSender?: PushNotificationSender;
  serviceProxy?: PaseoDaemonConfig["serviceProxy"];
  webUi?: PaseoDaemonConfig["webUi"];
  trustedProxies?: PaseoDaemonConfig["trustedProxies"];
  agentProfiles?: AgentProfile[];
  autoArchiveAfterMerge?: boolean;
  pluginsEnabled?: PaseoDaemonConfig["pluginsEnabled"];
  builtinPlugins?: BuiltinPluginLoader;
  plugins?: PaseoDaemonConfig["plugins"];
  /**
   * Replaces the OMP client with the real one over a scripted JSONL child, bound to the daemon's own
   * routing authority. Synthetic data only; no process is spawned.
   */
  ompRouting?: FakeOmpChildOptions;
}

/** Test-only control of the fake native peer. Drives the real JSONL frames; never the store. */
export interface OmpRoutingFixture {
  /** The first scripted child; every opened agent gets its own, listed in `children`. */
  child: FakeOmpChild;
  children: FakeOmpChild[];
  authority: AccountRoutingAuthority;
  /** Opens an OMP agent through the daemon so its runtime registers with the authority. */
  openAgent(
    cwd: string,
  ): Promise<{ agentId: string; runtimeInstanceId: string; child: FakeOmpChild }>;
  /** Replaces the catalogs native reports from now on (configure, refresh and default admit). */
  updateCatalog(next: (runtimeInstanceId: string) => RoutingCatalog[]): void;
  /** Replaces the answer native gives to the next `account.routing.configure`. */
  setRuntimeCapability(configure: FakeOmpChildOptions["configure"]): void;
  /** Native outcome frame for an admitted request, with optional confirmed quota blocks. */
  outcome(input: {
    runtimeInstanceId: string;
    admission: Extract<OmpRpcAdmitDecision, { kind: "admit" }>;
    operationId: string;
    sessionId: string;
    modelId: string;
    quotaBlocks?: OmpRoutingBlock[];
    code?: string;
  }): void;
  /** Native withdraws a request or wait. */
  cancel(input: {
    runtimeInstanceId: string;
    operationId: string;
    waitId?: string;
    admissionId?: string;
  }): void;
  /** Native admit.request; resolves with the host's `decision` once the response frame lands. */
  requestAdmission(input: {
    runtimeInstanceId: string;
    operationId: string;
    sessionId: string;
    modelId: string;
    /** Defaults to the first catalog the fixture currently reports. */
    catalog?: Record<string, unknown>;
    purpose?: string;
    previousWaitId?: string;
  }): Promise<OmpRpcAdmitDecision>;
  started(input: {
    runtimeInstanceId: string;
    admission: Extract<OmpRpcAdmitDecision, { kind: "admit" }>;
    operationId: string;
    sessionId: string;
    modelId: string;
  }): void;
}

export interface TestPaseoDaemon {
  config: PaseoDaemonConfig;
  daemon: Awaited<ReturnType<typeof createPaseoDaemon>>;
  port: number;
  paseoHome: string;
  staticDir: string;
  routingFixture?: OmpRoutingFixture;
  close: () => Promise<void>;
}

const TEST_DAEMON_START_TIMEOUT_MS = 20_000;

async function startDaemonWithTimeout(
  daemon: Awaited<ReturnType<typeof createPaseoDaemon>>,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      const timeoutError = new Error(
        `Timed out starting test daemon after ${timeoutMs}ms`,
      ) as Error & { code?: string };
      timeoutError.code = "TEST_DAEMON_START_TIMEOUT";
      reject(timeoutError);
    }, timeoutMs);

    daemon.start().then(
      () => {
        clearTimeout(timeoutHandle);
        resolve();
        return;
      },
      (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      },
    );
  });
}

export async function createTestPaseoDaemon(
  options: TestPaseoDaemonOptions = {},
): Promise<TestPaseoDaemon> {
  const maxAttempts = 8;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { config, paseoHomeRoot, paseoHome, staticDir, createdDirs } =
      await prepareTestDaemonConfig(options);
    const logger = options.logger ?? pino({ level: "silent" });
    const routing = options.ompRouting ? createOmpRoutingClient(options.ompRouting, logger) : null;
    if (routing) {
      config.agentClients = { ...config.agentClients, omp: routing.client };
      config.providerOverrides = { ...config.providerOverrides, omp: { enabled: true } };
    }
    const daemon = await createPaseoDaemon(config, logger, {
      builtinPlugins: options.builtinPlugins ?? new BuiltinPluginLoader(undefined, []),
      serverFeatureOverrides: {
        daemonStatusRpc: options.daemonStatusRpcCapability,
        relayConfig: options.relayConfigCapability,
      },
    });
    try {
      await startDaemonWithTimeout(daemon, TEST_DAEMON_START_TIMEOUT_MS);
      const listenTarget = daemon.getListenTarget();
      if (!listenTarget || listenTarget.type !== "tcp") {
        throw new Error("Test daemon did not expose a bound TCP listen target");
      }

      const close = async (): Promise<void> => {
        await daemon.stop().catch(() => undefined);
        await daemon.agentManager.flush().catch(() => undefined);
        if (options.cleanup ?? true) {
          await new Promise((r) => setTimeout(r, 50));
          await removeDirs([paseoHomeRoot, staticDir]);
        }
      };

      return {
        config,
        daemon,
        port: listenTarget.port,
        paseoHome,
        staticDir,
        routingFixture: routing?.fixture(daemon),
        close,
      };
    } catch (error) {
      lastError = error;
      await daemon.stop().catch(() => undefined);
      // A failed attempt removes only what it created: a caller-supplied home keeps its serverId.
      await removeDirs(createdDirs);

      if (
        (!isAddressInUseError(error) && !isStartupTimeoutError(error)) ||
        attempt === maxAttempts - 1
      ) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("Failed to start test daemon");
}

/** The client is built before the daemon exists; the authority is resolved when a launch needs it. */
function createOmpRoutingClient(options: FakeOmpChildOptions, logger: pino.Logger) {
  // One shared options object: the fixture swaps catalogs and capability on it between scenarios.
  const children: FakeOmpChild[] = [];
  const byRuntime = new Map<string, FakeOmpChild>();
  const childFor = (runtimeInstanceId: string) => {
    const found = byRuntime.get(runtimeInstanceId);
    if (!found) throw new Error(`No scripted child for ${runtimeInstanceId}`);
    return found;
  };
  let authority: AccountRoutingAuthority | undefined;
  const lazy = (): AccountRoutingAuthority => {
    if (!authority) throw new Error("Routing authority is not available yet");
    return authority;
  };
  const delegate: OmpRoutingAuthority = {
    get hostEpoch() {
      return lazy().hostEpoch;
    },
    attachRuntime: (...args) => lazy().attachRuntime(...args),
    admit: (...args) => lazy().admit(...args),
    started: (...args) => lazy().started(...args),
    outcome: (...args) => lazy().outcome(...args),
    cancel: (...args) => lazy().cancel(...args),
  };
  const client = new OmpAgentClient({
    logger,
    runtime: new OmpCliRuntime({
      logger,
      command: ["omp"],
      // Only the marked launch is the scripted peer; catalog and model listing spawn throwaways.
      spawnProcess: (launch) => {
        if (launch.env?.[OMP_HOST_ACCOUNT_ROUTING_ENV] !== "1") return new FakeOmpChild().process;
        const child = new FakeOmpChild(options);
        children.push(child);
        return child.process;
      },
      probeCapabilities: async () => ({ complete: true, version: 1 }),
    }),
    accountRouting: delegate,
  });
  return {
    client,
    fixture(daemon: TestPaseoDaemon["daemon"]): OmpRoutingFixture {
      if (!daemon.accountRouting) throw new Error("Daemon has no routing authority");
      authority = daemon.accountRouting;
      return {
        get child() {
          return children[0];
        },
        children,
        authority,
        async openAgent(cwd) {
          const before = children.length;
          const agent = await daemon.agentManager.createAgent({ provider: "omp", cwd }, undefined, {
            workspaceId: undefined,
          });
          const child = children[before];
          if (!child) throw new Error("Launch did not spawn a scripted routing child");
          const configure = await child.waitForFrame("account.routing.configure");
          const runtimeInstanceId = String(configure.runtimeInstanceId);
          byRuntime.set(runtimeInstanceId, child);
          return { agentId: agent.id, runtimeInstanceId, child };
        },
        updateCatalog(next) {
          options.catalogs = next;
          options.refresh = (command) => ({
            catalog: next(String(command.runtimeInstanceId))[0],
          });
        },
        setRuntimeCapability(configure) {
          options.configure = configure;
        },
        outcome(input) {
          childFor(input.runtimeInstanceId).emit({
            type: "account.routing.outcome",
            hostEpoch: lazy().hostEpoch,
            runtimeInstanceId: input.runtimeInstanceId,
            admissionId: input.admission.admissionId,
            operationId: input.operationId,
            attemptId: "attempt-1",
            sessionId: input.sessionId,
            modelId: input.modelId,
            accountRef: input.admission.accountRef,
            selectionGeneration: input.admission.selectionGeneration,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            code: input.code ?? (input.quotaBlocks?.length ? "quota_exhausted" : "ok"),
            dispatch: "dispatched",
            replaySafe: false,
            refusalReason: null,
            retryAfterMs: null,
            quotaBlocks: input.quotaBlocks ?? [],
            windows: [],
          });
        },
        cancel(input) {
          childFor(input.runtimeInstanceId).emit({
            type: "account.routing.cancel",
            id: `ar-${input.operationId}`,
            sessionId: "native-1",
            hostEpoch: lazy().hostEpoch,
            runtimeInstanceId: input.runtimeInstanceId,
            operationId: input.operationId,
            attemptId: "attempt-1",
            ...(input.waitId ? { waitId: input.waitId } : {}),
            ...(input.admissionId ? { admissionId: input.admissionId } : {}),
          });
        },
        async requestAdmission(input) {
          const id = `ar-${input.operationId}`;
          const child = childFor(input.runtimeInstanceId);
          child.emit({
            type: "account.routing.admit.request",
            id,
            hostEpoch: lazy().hostEpoch,
            runtimeInstanceId: input.runtimeInstanceId,
            operationId: input.operationId,
            attemptId: "attempt-1",
            sessionId: input.sessionId,
            purpose: input.purpose ?? "main",
            provider: "anthropic",
            modelId: input.modelId,
            requestGeneration: 1,
            ...(input.previousWaitId ? { previousWaitId: input.previousWaitId } : {}),
            catalog: input.catalog ?? options.catalogs?.(input.runtimeInstanceId)[0],
          });
          const response = await child.waitForFrame(
            "account.routing.admit.response",
            (frame) => frame.id === id,
          );
          return response.decision as OmpRpcAdmitDecision;
        },
        started(input) {
          childFor(input.runtimeInstanceId).emit({
            type: "account.routing.started",
            hostEpoch: lazy().hostEpoch,
            runtimeInstanceId: input.runtimeInstanceId,
            admissionId: input.admission.admissionId,
            operationId: input.operationId,
            attemptId: "attempt-1",
            sessionId: input.sessionId,
            modelId: input.modelId,
            accountRef: input.admission.accountRef,
            selectionGeneration: input.admission.selectionGeneration,
            startedAt: Date.now(),
          });
        },
      };
    },
  };
}

interface PreparedTestDaemonConfig {
  config: PaseoDaemonConfig;
  paseoHomeRoot: string;
  paseoHome: string;
  staticDir: string;
  createdDirs: string[];
}

async function removeDirs(dirs: string[]): Promise<void> {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
}

async function createTempDir(prefix: string, createdDirs: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

async function prepareTestDaemonConfig(
  options: TestPaseoDaemonOptions,
): Promise<PreparedTestDaemonConfig> {
  const createdDirs: string[] = [];
  const paseoHomeRoot = options.paseoHomeRoot ?? (await createTempDir("paseo-home-", createdDirs));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  const staticDir = options.staticDir ?? (await createTempDir("paseo-static-", createdDirs));
  const listenHost = options.listen ?? "127.0.0.1";
  const listenPort = options.listenPort ?? 0;
  const config: PaseoDaemonConfig = {
    listen: `${listenHost}:${listenPort}`,
    paseoHome,
    daemonVersion: options.daemonVersion,
    desktopManaged: options.desktopManaged,
    corsAllowedOrigins: options.corsAllowedOrigins ?? [],
    hostnames: true,
    mcpEnabled: options.mcpEnabled ?? true,
    staticDir,
    mcpDebug: options.mcpDebug ?? false,
    isDev: options.isDev,
    agentClients: options.agentClients ?? createTestAgentClients(),
    providerOverrides: options.providerOverrides,
    agentStoragePath: path.join(paseoHome, "agents"),
    relayEnabled: options.relayEnabled ?? false,
    relayEndpoint: options.relayEndpoint ?? "relay.paseo.sh:443",
    relayUseTls: options.relayUseTls,
    relayPublicUseTls: options.relayPublicUseTls,
    appBaseUrl: "https://app.paseo.sh",
    auth: options.auth,
    pushNotificationSender: options.pushNotificationSender,
    serviceProxy: options.serviceProxy,
    webUi: options.webUi,
    trustedProxies: options.trustedProxies,
    openai: options.openai,
    speech: options.speech,
    voiceLlmProvider: options.voiceLlmProvider ?? null,
    voiceLlmProviderExplicit: options.voiceLlmProviderExplicit ?? false,
    voiceLlmModel: options.voiceLlmModel ?? null,
    dictationFinalTimeoutMs: options.dictationFinalTimeoutMs,
    downloadTokenTtlMs: options.downloadTokenTtlMs,
    agentProfiles: options.agentProfiles,
    autoArchiveAfterMerge: options.autoArchiveAfterMerge,
    pluginsEnabled: options.pluginsEnabled,
    plugins: options.plugins,
  };
  return { config, paseoHomeRoot, paseoHome, staticDir, createdDirs };
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: string };
  return record.code === "EADDRINUSE";
}

function isStartupTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: string };
  return record.code === "TEST_DAEMON_START_TIMEOUT";
}
