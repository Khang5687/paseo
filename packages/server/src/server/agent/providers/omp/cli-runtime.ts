import { createExternalProcessEnv } from "../../../paseo-env.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";

import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import {
  JSONL_RPC_NO_TIMEOUT,
  JsonlRpcProcess,
  type JsonlRpcLaunch,
} from "../jsonl-rpc-process.js";
import { execCommand } from "../../../../utils/spawn.js";
import {
  inertRoutingAdapter,
  memoizeProbe,
  OmpAccountRoutingBridge,
  parseOmpCapabilityProbe,
  type OmpCapabilityProbe,
} from "./account-routing-bridge.js";
import { writeOmpConfigOverlay } from "./config-overlay.js";
import { establishOmpProtocol } from "./protocol-session.js";
import {
  buildOmpLaunch,
  type OmpRuntime,
  type OmpRuntimeLaunch,
  type OmpRuntimeSession,
  type OmpStartSessionInput,
} from "./runtime.js";
import {
  OmpBranchMessagesResultSchema,
  OmpBranchResultSchema,
  OmpCommandsResultSchema,
  OmpHostToolsResultSchema,
  OmpMessagesResultSchema,
  OmpModelSchema,
  OmpModelsResultSchema,
  OmpPromptAckSchema,
  OmpRpcCommandSchema,
  parseOmpRuntimeEvent,
  OMP_HOST_ACCOUNT_ROUTING_ENV,
  OmpGoalCommandResultSchema,
  OmpSessionStateSchema,
  OmpSessionStatsSchema,
  type OmpThinkingLevel,
  type OmpGoalAction,
  type OmpGoalModeState,
  type OmpAgentMessage,
  type OmpModel,
  type OmpPromptAck,
  type OmpRpcCommand,
  type OmpRpcHostToolDefinition,
  type OmpRpcHostToolResult,
  type OmpRpcHostToolUpdate,
  type OmpRpcSlashCommand,
  type OmpRuntimeEvent,
  type OmpSessionState,
  type OmpSessionStats,
  type OmpSubagentSubscriptionLevel,
} from "./rpc-types.js";

const DEFAULT_OMP_COMMAND: [string, ...string[]] = [process.env.OMP_COMMAND ?? "omp"];
const DEFAULT_COMMANDS_RPC_NAME = "get_available_commands";
const CAPABILITY_PROBE_TIMEOUT_MS = 10_000;

export interface OmpCliRuntimeOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  command?: [string, ...string[]];
  commandsRpcName?: "get_available_commands";
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  spawnProcess?: (launch: OmpRuntimeLaunch) => ChildProcessWithoutNullStreams;
  /** Test seam: replaces `omp account-routing-capabilities`. Receives the launch the probe vets. */
  probeCapabilities?: (launch: OmpRuntimeLaunch) => Promise<OmpCapabilityProbe>;
}

/** What a routed launch resolved to before any child exists. */
type RoutingPlan =
  | { kind: "none" }
  | { kind: "metadata" }
  | { kind: "managed"; runtimeInstanceId: string; agentId: string }
  | { kind: "incomplete"; runtimeInstanceId: string; agentId: string; version: number };

export class OmpCliRuntime implements OmpRuntime {
  private readonly command: [string, ...string[]];
  private readonly commandsRpcName: "get_available_commands";
  private readonly spawnProcess?: (launch: OmpRuntimeLaunch) => ChildProcessWithoutNullStreams;

  constructor(private readonly options: OmpCliRuntimeOptions) {
    this.command = options.command ?? DEFAULT_OMP_COMMAND;
    this.commandsRpcName = options.commandsRpcName ?? DEFAULT_COMMANDS_RPC_NAME;
    this.spawnProcess = options.spawnProcess;
  }

  async startSession(input: OmpStartSessionInput): Promise<OmpRuntimeSession> {
    const launch = buildOmpLaunch({
      command: this.command,
      runtimeSettings: this.options.runtimeSettings,
      session: input,
    });
    launch.argv.push("--config", writeOmpConfigOverlay());
    // No await on the independent path: the child must be wired in the same tick it was spawned.
    const plan: RoutingPlan = input.routing
      ? await this.planRouting(input.routing, launch)
      : { kind: "none" };
    launch.env = createExternalProcessEnv(
      globalThis.process.env,
      withRoutingMarker(launch.env ?? {}, plan),
    );
    const [command, ...args] = launch.argv;
    const processLaunch: JsonlRpcLaunch = {
      command,
      args,
      cwd: launch.cwd,
      env: launch.env,
    };
    const spawn = this.spawnProcess;
    const processOptions = {
      launch: processLaunch,
      logger: this.options.logger,
      diagnosticName: "OMP RPC",
      defaultRequestTimeoutMs: this.options.requestTimeoutMs,
      ...(spawn ? { spawn: () => spawn(launch) } : {}),
    };
    const process = new JsonlRpcProcess(processOptions);
    const handleAbort = () => void process.close(input.signal?.reason).catch(() => undefined);
    input.signal?.addEventListener("abort", handleAbort, { once: true });
    // The bridge listens before the readiness handshake, so nothing the child writes during
    // startup is missed, and the pending-configure latch is in place before any model call.
    const routing = input.routing;
    const bridge =
      plan.kind === "managed" && routing
        ? new OmpAccountRoutingBridge({
            authority: routing.authority,
            transport: process,
            logger: this.options.logger,
            runtimeInstanceId: plan.runtimeInstanceId,
            agentId: plan.agentId,
          })
        : undefined;
    // An unmarked binary that cannot cover every caller registers as incomplete, so the host reports
    // the capability as unsupported instead of guessing. It has no control channel to bridge.
    const incomplete =
      plan.kind === "incomplete" && routing
        ? routing.authority.attachRuntime(
            {
              runtimeInstanceId: plan.runtimeInstanceId,
              agentId: plan.agentId,
              accessibleNamespaces: [],
              capabilityVersion: plan.version,
              completeCoverage: false,
            },
            inertRoutingAdapter(),
          )
        : undefined;
    const detachRouting = () => {
      bridge?.close();
      incomplete?.dispose();
    };
    try {
      await establishOmpProtocol(process, this.options.logger, {
        readyTimeoutMs: this.options.readyTimeoutMs,
        requestTimeoutMs: this.options.requestTimeoutMs,
      });
      input.signal?.throwIfAborted();
      await bridge?.configure();
      return new OmpCliRuntimeSession(process, this.commandsRpcName, launch.env, detachRouting);
    } catch (error) {
      const startupError = error instanceof Error ? error : new Error(String(error));
      await process.close(startupError);
      detachRouting();
      throw startupError;
    } finally {
      input.signal?.removeEventListener("abort", handleAbort);
    }
  }

  /**
   * Decides, before spawning, how this launch relates to host routing. A managed launch needs a
   * trusted agent and a binary whose probe reports complete coverage; anything less is never marked.
   */
  private async planRouting(
    routing: NonNullable<OmpStartSessionInput["routing"]>,
    launch: OmpRuntimeLaunch,
  ): Promise<RoutingPlan> {
    if (!routing.agentId) return { kind: "metadata" };
    const probe = await this.probe(launch);
    const runtimeInstanceId = randomUUID();
    return probe.complete
      ? { kind: "managed", runtimeInstanceId, agentId: routing.agentId }
      : { kind: "incomplete", runtimeInstanceId, agentId: routing.agentId, version: probe.version };
  }

  private async probe(launch: OmpRuntimeLaunch): Promise<OmpCapabilityProbe> {
    if (this.options.probeCapabilities) return this.options.probeCapabilities(launch);
    const settings = this.options.runtimeSettings?.command;
    const base = settings?.mode === "replace" && settings.argv[0] ? settings.argv : this.command;
    const [command, ...args] = base;
    const env = launch.env;
    const key = JSON.stringify([command, ...args, env ?? {}]);
    return memoizeProbe(key, async () => {
      try {
        const { stdout } = await execCommand(
          command,
          [...args, "account-routing-capabilities", "--mode", "model"],
          { envOverlay: env, timeout: CAPABILITY_PROBE_TIMEOUT_MS },
        );
        return parseOmpCapabilityProbe(stdout);
      } catch {
        // An older binary rejects the subcommand: that is an incomplete runtime, not an error.
        return { complete: false, version: 0 };
      }
    });
  }
}

function withRoutingMarker(env: Record<string, string>, plan: RoutingPlan): Record<string, string> {
  if (plan.kind === "managed") return { ...env, [OMP_HOST_ACCOUNT_ROUTING_ENV]: "1" };
  if (plan.kind === "metadata") return { ...env, [OMP_HOST_ACCOUNT_ROUTING_ENV]: "metadata" };
  return env;
}

class OmpCliRuntimeSession implements OmpRuntimeSession {
  private readonly subscribers = new Set<(event: OmpRuntimeEvent) => void>();
  private refreshCommandsUnsupported = false;
  activeBranchEntryId?: string;

  constructor(
    private readonly process: JsonlRpcProcess,
    private readonly commandsRpcName: "get_available_commands",
    private readonly launchEnvironment: Record<string, string>,
    private readonly detachRouting: () => void = () => undefined,
  ) {
    process.onMessage((message) => {
      const event = parseOmpRuntimeEvent(message);
      if (event) {
        this.emit(event);
      }
    });
    process.onExit(({ error }) => {
      this.detachRouting();
      this.emit({ type: "process_exit", error: error.message });
    });
  }

  get environment(): Record<string, string> {
    return this.launchEnvironment;
  }

  onEvent(callback: (event: OmpRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<OmpPromptAck> {
    const { id: requestId, promise } = this.process.startRequest({
      type: "prompt",
      message,
      ...(images?.length ? { images } : {}),
    });
    const ack = OmpPromptAckSchema.parse(await promise) ?? {};
    return { requestId, ...ack };
  }

  async compact(customInstructions?: string): Promise<void> {
    await this.request(
      {
        type: "compact",
        ...(customInstructions ? { customInstructions } : {}),
      },
      JSONL_RPC_NO_TIMEOUT,
    );
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.request({ type: "set_auto_compaction", enabled });
  }

  async goal(action: OmpGoalAction): Promise<OmpGoalModeState | null> {
    const result = await this.request({ type: "goal", ...action });
    return OmpGoalCommandResultSchema.parse(result).state;
  }

  async abort(): Promise<void> {
    await this.requestStopWork({ type: "abort" });
  }

  async getState(): Promise<OmpSessionState> {
    return OmpSessionStateSchema.parse(await this.request({ type: "get_state" }));
  }

  async setFastMode(enabled: boolean): Promise<{ enabled: boolean; active: boolean }> {
    const result = await this.request({ type: "set_fast_mode", enabled });
    return z.object({ enabled: z.boolean(), active: z.boolean() }).parse(result);
  }

  async getMessages(): Promise<OmpAgentMessage[]> {
    const data = OmpMessagesResultSchema.parse(await this.request({ type: "get_messages" }));
    return data.messages ?? [];
  }

  async getAvailableModels(timeoutMs?: number | null): Promise<OmpModel[]> {
    const data = OmpModelsResultSchema.parse(
      await this.request({ type: "get_available_models" }, timeoutMs),
    );
    return data.models ?? [];
  }

  async setModel(provider: string, modelId: string): Promise<OmpModel> {
    return OmpModelSchema.parse(await this.request({ type: "set_model", provider, modelId }));
  }

  async setThinkingLevel(level: OmpThinkingLevel): Promise<void> {
    await this.request({ type: "set_thinking_level", level });
  }

  async getSessionStats(): Promise<OmpSessionStats> {
    // COMPAT(ompGetStateFallback): added in v0.1.105 — older OMP binaries
    // lack the `get_session_stats` RPC command; fall back to extracting
    // context window usage from `get_state`. Remove after 2027-01-10 once the
    // supported OMP floor includes `get_session_stats`.
    let stats: OmpSessionStats | undefined;
    try {
      stats = OmpSessionStatsSchema.parse(await this.request({ type: "get_session_stats" }));
    } catch {
      // get_session_stats not supported by this binary — will try get_state below
    }
    if (stats?.tokens == null && stats?.cost == null && stats?.contextUsage == null) {
      try {
        const state = OmpSessionStateSchema.parse(await this.request({ type: "get_state" }));
        const ctx = state.contextUsage;
        if (ctx) {
          return {
            contextUsage: {
              tokens: typeof ctx.tokens === "number" ? ctx.tokens : undefined,
              contextWindow: typeof ctx.contextWindow === "number" ? ctx.contextWindow : undefined,
            },
          };
        }
      } catch {
        // get_state also failed — nothing we can do
      }
    }
    return stats ?? {};
  }

  async getCommands(): Promise<OmpRpcSlashCommand[]> {
    const data = OmpCommandsResultSchema.parse(await this.request({ type: this.commandsRpcName }));
    return data.commands ?? [];
  }

  async refreshCommands(): Promise<OmpRpcSlashCommand[]> {
    if (this.refreshCommandsUnsupported) {
      return await this.getCommands();
    }
    try {
      const data = OmpCommandsResultSchema.parse(await this.request({ type: "refresh_commands" }));
      return data.commands ?? [];
    } catch (error) {
      // COMPAT(ompRefreshCommands): added in v0.11.0, remove after 2027-04-07 once the
      // minimum supported OMP version answers `refresh_commands`. Older binaries reject it
      // as an unknown command; list the commands they already know instead.
      if (!(error instanceof Error) || error.message !== "Unknown command: refresh_commands") {
        throw error;
      }
      this.refreshCommandsUnsupported = true;
      return await this.getCommands();
    }
  }

  async setSubagentSubscription(level: OmpSubagentSubscriptionLevel): Promise<void> {
    await this.request({ type: "set_subagent_subscription", level });
  }

  async setHostTools(tools: OmpRpcHostToolDefinition[]): Promise<string[]> {
    const data = OmpHostToolsResultSchema.parse(
      await this.request({ type: "set_host_tools", tools }),
    );
    return data.toolNames ?? [];
  }

  sendHostToolResult(result: OmpRpcHostToolResult): void {
    this.process.send({ ...result });
  }

  sendHostToolUpdate(update: OmpRpcHostToolUpdate): void {
    this.process.send({ ...update });
  }

  async branch(entryId: string): Promise<{ text: string }> {
    const data = OmpBranchResultSchema.parse(await this.request({ type: "branch", entryId }));
    if (data.cancelled === true) {
      throw new Error("OMP branch was cancelled");
    }
    if (typeof data.text !== "string") {
      throw new Error("OMP branch response did not include restored prompt text");
    }
    this.activeBranchEntryId = entryId;
    return { text: data.text };
  }

  async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
    const data = OmpBranchMessagesResultSchema.parse(
      await this.request({ type: "get_branch_messages" }),
    );
    return data.messages ?? [];
  }

  async steer(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void> {
    await this.request({ type: "steer", message, ...(images?.length ? { images } : {}) });
  }

  followUp(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): void {
    this.process.send({ type: "follow_up", message, ...(images?.length ? { images } : {}) });
  }

  async handoff(customInstructions?: string): Promise<void> {
    await this.request({
      type: "handoff",
      ...(customInstructions ? { customInstructions } : {}),
    });
  }

  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void {
    this.process.send({ type: "extension_ui_response", id, ...response });
  }

  cancelExtensionUiRequest(id: string): void {
    this.respondToExtensionUiRequest(id, { cancelled: true });
  }

  async close(): Promise<void> {
    // Detach after the child exits: closing stdin makes it report its final outcomes and cancels.
    await this.process.close(new Error("OMP RPC session is closed"));
    this.detachRouting();
  }

  private request(command: OmpRpcCommand, timeoutMs?: number | null): Promise<unknown> {
    return this.process.request(OmpRpcCommandSchema.parse(command), timeoutMs);
  }

  private requestStopWork(command: OmpRpcCommand): Promise<void> {
    return this.process.requestStopWork(OmpRpcCommandSchema.parse(command));
  }

  private emit(event: OmpRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}
