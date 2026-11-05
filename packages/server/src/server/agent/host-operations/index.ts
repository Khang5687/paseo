import type { AgentStreamEvent } from "../agent-sdk-types.js";
import {
  PARENT_AGENT_ID_LABEL,
  PARENT_SERVER_ID_LABEL,
  parentAddressLabels,
} from "@getpaseo/protocol/agent-labels";
import type { ActiveTurnBehavior, AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DaemonClient,
  DaemonConnectionError,
  type FetchWorkspacesEntry,
  type WaitForFinishResult,
} from "@getpaseo/client/internal/daemon-client";
import type { DaemonTransportFactory } from "@getpaseo/client/internal/daemon-client-transport-types";
import type { HostDirectory } from "@getpaseo/protocol/hosts";
import { OWNER_PERMISSIONS } from "../../authorization/index.js";
import type { ConnectedHosts } from "../../connected-hosts/index.js";
import { resolveRequiredProviderModel } from "../mcp-shared.js";
import { selectAgentListPage } from "../agent-projections.js";
import { moreNote, selectWorkspaceSummaries } from "../tools/paseo-tool-compaction.js";
import { summarizeAgentActivity } from "../activity-curator.js";
import { formatAskOutput, resolveAskAction } from "../ask-agent.js";
import { expandUserPath } from "../../path-utils.js";
import {
  PaseoToolInputError,
  type PaseoToolExecutionContext,
  type PaseoToolResult,
} from "../tools/types.js";
import { buildForkTaskPrompt } from "../fork-agent.js";
import type { AgentPermissionResponse } from "../agent-sdk-types.js";
import { resolvePermissionResponse } from "../permission-answers.js";

export class HostOperationRejectedError extends Error {
  readonly code: unknown;
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "HostOperationRejectedError";
    this.code = error instanceof Error && "code" in error ? error.code : undefined;
  }
}
function isAmbiguousPromptFailure(error: unknown): boolean {
  if (error instanceof DaemonConnectionError) return true;
  return error instanceof Error && error.message.startsWith("Timeout waiting for message");
}
export type HostOperation = (
  input: Record<string, unknown>,
  context: PaseoToolExecutionContext,
) => Promise<PaseoToolResult>;
export interface HostOperations {
  createAgent: HostOperation;
  createWorkspace: HostOperation;
  listWorkspaces: HostOperation;
  sendPrompt: HostOperation;
  getStatus: HostOperation;
  getActivity: HostOperation;
  listAgents: HostOperation;
  forkAgent: HostOperation;
  askAgent: HostOperation;
  listPermissions: HostOperation;
  respondToPermission: HostOperation;
}
/** Connection authority at the host boundary, independent of child lifecycle. */
export class HostObservationError extends Error {
  constructor(
    readonly reason: "connecting" | "unreachable" | "removed",
    cause?: unknown,
  ) {
    super(`Host observation ${reason}`, { cause });
    this.name = "HostObservationError";
  }
}
export interface HostObservation {
  wait(agentId: string, signal: AbortSignal): Promise<WaitForFinishResult>;
  observe(
    agentId: string,
    handler: (
      snapshot: AgentSnapshotPayload | null,
      event?: AgentStreamEvent,
      lastMessage?: string | null,
    ) => void,
    signal: AbortSignal,
    onError: (error: unknown) => void,
  ): Promise<() => Promise<void>>;
}
export interface ToolHosts {
  directory(): Promise<HostDirectory>;
  use<T>(
    serverId: string,
    action: (client: DaemonClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

/** Daemon MCP has the daemon's authority, bounded by the destination's admission of its link. */
export function createToolHosts(hosts: ConnectedHosts): ToolHosts {
  return {
    directory: () => hosts.list(),
    async use(serverId, action, signal) {
      const lifetime = new AbortController();
      let routeFailure: unknown;
      const transportFactory: DaemonTransportFactory = () => {
        const opens = new Set<() => void>();
        const closes = new Set<(event?: unknown) => void>();
        const errors = new Set<(event: unknown) => void>();
        const messages = new Set<(data: unknown, binary: boolean) => void>();
        let closed = false;
        let route: Awaited<ReturnType<ConnectedHosts["openRoute"]>> | undefined;
        void hosts
          .openRoute({
            serverId,
            scopeId: randomUUID(),
            sourceId: "mcp",
            originSessionId: "mcp",
            permissions: OWNER_PERMISSIONS,
            signal: signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal,
            frame: (data) => {
              for (const listener of messages) listener(data, typeof data !== "string");
            },
            ended: (code, message) => {
              for (const listener of errors)
                listener(Object.assign(new Error(message), { code, serverId }));
              for (const listener of closes) listener();
            },
          })
          .then((opened) => {
            route = opened;
            if (closed) opened.close();
            else for (const listener of opens) listener();
            return undefined;
          })
          .catch((error) => {
            routeFailure = error;
            for (const listener of errors) listener(error);
            for (const listener of closes) listener(error);
          });
        return {
          send: (data) => {
            if (!route) throw new Error("Host route is not open");
            route.send(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
          },
          close: () => {
            closed = true;
            route?.close();
          },
          onOpen: (listener) => {
            opens.add(listener);
            return () => opens.delete(listener);
          },
          onClose: (listener) => {
            closes.add(listener);
            return () => closes.delete(listener);
          },
          onError: (listener) => {
            errors.add(listener);
            return () => errors.delete(listener);
          },
          onMessage: (listener) => {
            messages.add(listener);
            return () => messages.delete(listener);
          },
        };
      };
      const client = new DaemonClient({
        url: "ws://host-route/ws",
        clientId: randomUUID(),
        transportFactory,
        reconnect: { enabled: false },
      });
      const stop = () => void client.close();
      signal?.addEventListener("abort", stop, { once: true });
      try {
        signal?.throwIfAborted();
        await client.connect().catch((error) => {
          // The action has not run; no application request could have been transmitted.
          throw new HostOperationRejectedError(routeFailure ?? error);
        });
        return await action(client);
      } finally {
        signal?.removeEventListener("abort", stop);
        lifetime.abort();
        await client.close();
      }
    },
  };
}

const remoteCreate = z
  .object({
    provider: z.string().min(1),
    title: z.string().trim().min(1).max(60),
    initialPrompt: z.string().min(1),
    workspaceId: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
    notifyOnFinish: z.boolean().optional(),
    detached: z.boolean().optional(),
    idempotencyKey: z.string().optional(),
    settings: z
      .object({
        modeId: z.string().optional(),
        thinkingOptionId: z.string().optional(),
        features: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .strict();
const result = (structuredContent: unknown): PaseoToolResult => ({
  content: [],
  structuredContent,
});

export function createHostResolver(input: {
  serverId: string;
  local: HostOperations;
  hosts: () => ToolHosts;
  callerAgentId?: string;
  lockedCwd?: string;
  /** Title of the calling agent, shown to an agent it asks. */
  callerTitle?: () => string | undefined;
}) {
  return {
    directory: () => input.hosts().directory(),
    async use<T>(
      serverId: string | undefined,
      action: (host: HostOperations) => Promise<T>,
    ): Promise<T> {
      const destination = serverId ?? input.serverId;
      if (destination === input.serverId) return action(input.local);
      if (input.lockedCwd)
        throw new Error("This caller is restricted to its local working directory");
      return input.hosts().use(destination, async (client) =>
        action({
          async createAgent(args) {
            const parsed = remoteCreate.parse(args);
            const { provider, model } = resolveRequiredProviderModel(parsed.provider);
            const workspace = (await client.fetchWorkspaces({})).entries.find(
              (row) => row.id === parsed.workspaceId,
            );
            if (!workspace) throw new Error(`Workspace ${parsed.workspaceId} not found`);
            // A detached create is a root agent on the host: no parent link, so it is neither
            // listed as the caller's subagent nor archived with it.
            const {
              [PARENT_AGENT_ID_LABEL]: _parent,
              [PARENT_SERVER_ID_LABEL]: _parentServer,
              ...callerLabels
            } = parsed.labels ?? {};
            const labels = parsed.detached
              ? callerLabels
              : {
                  ...parsed.labels,
                  ...(input.callerAgentId
                    ? parentAddressLabels({
                        agentId: input.callerAgentId,
                        serverId: input.serverId,
                      })
                    : {}),
                };
            const snapshot = await client.createAgent({
              config: {
                provider,
                model,
                cwd: workspace.workspaceDirectory,
                title: parsed.title,
                modeId: parsed.settings?.modeId,
                thinkingOptionId: parsed.settings?.thinkingOptionId,
                featureValues: parsed.settings?.features,
              },
              workspaceId: parsed.workspaceId,
              labels,
              initialPrompt: parsed.initialPrompt,
              idempotencyKey: parsed.idempotencyKey,
            });
            return result({
              agentId: snapshot.id,
              type: snapshot.provider,
              status: snapshot.status,
              cwd: snapshot.cwd,
              workspaceId: snapshot.workspaceId,
              currentModeId: snapshot.currentModeId,
              availableModes: snapshot.availableModes,
            });
          },
          async forkAgent(args) {
            const agentId = args.agentId as string | undefined;
            if (!agentId) {
              throw new PaseoToolInputError(
                `A fork needs the source session on the same host. The calling agent runs on ${input.serverId}, not ${destination}; pass agentId of an agent on ${destination}.`,
              );
            }
            const source = (await client.fetchAgent(agentId))?.agent;
            if (!source) throw new PaseoToolInputError(`Agent ${agentId} not found`);
            if (args.workspaceId && args.workspaceId !== source.workspaceId) {
              throw new PaseoToolInputError(
                `A fork stays in the source agent's workspace ${source.workspaceId}.`,
              );
            }
            const forked = await client.forkAgent(agentId);
            if (args.title)
              await client.updateAgent(forked.forkedAgentId, { name: args.title as string });
            if (args.prompt) {
              await client.sendMessage(
                forked.forkedAgentId,
                buildForkTaskPrompt(args.prompt as string),
                {
                  activeTurnBehavior: "steer",
                },
              );
            }
            return result({
              forkedAgentId: forked.forkedAgentId,
              method: forked.method,
              sourceAgentId: agentId,
              workspaceId: source.workspaceId,
            });
          },
          async sendPrompt(args) {
            const agentId = args.agentId as string;
            // Human sends retain the established mode RPC on older connected hosts.
            // Agent sends apply their requested mode when the recipient dispatches the batch.
            if (!input.callerAgentId && args.sessionMode !== undefined) {
              await client.setAgentMode(agentId, args.sessionMode as string);
            }
            const agent = (
              await client.fetchAgent(agentId).catch((error) => {
                // Snapshot preflight precedes sendMessage, so failure is definitely unsent.
                throw new HostOperationRejectedError(error);
              })
            )?.agent;
            if (!agent)
              throw new HostOperationRejectedError(new Error(`Agent ${agentId} not found`));
            const receipt = await client
              .sendMessage(agentId, args.prompt as string, {
                sessionMode: input.callerAgentId
                  ? (args.sessionMode as string | undefined)
                  : undefined,
                sourceAgentId: input.callerAgentId,
                sourceAgentServerId: input.callerAgentId ? input.serverId : undefined,
                activeTurnBehavior:
                  (args.activeTurnBehavior as ActiveTurnBehavior | undefined) ??
                  (input.callerAgentId ? "steer" : "interrupt"),
              })
              .catch((error) => {
                if (isAmbiguousPromptFailure(error)) throw error;
                throw new HostOperationRejectedError(error);
              });
            return result({
              success: true,
              ...receipt,
              status: agent.status,
              guidance:
                receipt.deliveryStatus === "queued"
                  ? "Queued for delivery after two quiet seconds. You will get notified when the prompted agent finishes, errors, or needs permission unless notifyOnFinish is false."
                  : "Dispatch acknowledged. Observe completion using get_agent_status/get_agent_activity or SDK/RPC subscriptions and wait APIs.",
            });
          },
          async getStatus(args) {
            const agent = (await client.fetchAgent(args.agentId as string))?.agent;
            if (!agent) throw new Error(`Agent ${args.agentId} not found`);
            return result({ status: agent.status, snapshot: agent });
          },
          async getActivity(args) {
            const agentId = args.agentId as string;
            const limit = args.limit as number | undefined;
            const timeline = await client.fetchAgentTimeline(agentId, {
              direction: "tail",
              limit: limit ?? 0,
            });
            const agent = (await client.fetchAgent(agentId))?.agent;
            if (!agent) throw new Error(`Agent ${agentId} not found`);
            return result({
              agentId,
              ...summarizeAgentActivity(
                timeline.entries.map((entry) => entry.item),
                limit,
              ),
              currentModeId: agent.currentModeId,
            });
          },
          async askAgent(args) {
            const agentId = args.agentId as string;
            const askAction = resolveAskAction({
              question: args.question as string | undefined,
              cursor: args.cursor as string | undefined,
              status: args.status,
              close: args.close,
            });
            const reply = await client.askAgent(
              agentId,
              (args.question as string | undefined) ?? "",
              {
                askedBy: input.callerTitle?.(),
                askerAgentId: input.callerAgentId,
                threadId: args.threadId as string | undefined,
                ...(askAction === "ask" ? {} : { threadAction: askAction }),
                ...(askAction === "read" ? { readCursor: args.cursor as string } : {}),
              },
            );
            return result(formatAskOutput(agentId, reply));
          },
          async listPermissions(args) {
            const agentId = args.agentId as string | undefined;
            const agents = agentId
              ? [(await client.fetchAgent(agentId))?.agent].filter((agent) => agent !== undefined)
              : (await client.fetchAgents({ includeBackground: true })).entries.map(
                  (entry) => entry.agent,
                );
            return result({
              permissions: agents.flatMap((agent) =>
                agent.pendingPermissions.map((request) => ({
                  agentId: agent.id,
                  status: agent.status,
                  request,
                })),
              ),
            });
          },
          async respondToPermission(args) {
            const agentId = args.agentId as string;
            const requestId = args.requestId as string;
            const response = await resolvePermissionResponse({
              agentId,
              requestId,
              response: args.response as AgentPermissionResponse | undefined,
              answers: args.answers as Record<string, string[]> | undefined,
              loadRequest: async () =>
                (await client.fetchAgent(agentId))?.agent.pendingPermissions.find(
                  (pending) => pending.id === requestId,
                ),
            });
            await client.respondToPermissionAndWait(agentId, requestId, response);
            return result({ success: true });
          },
          async listAgents(args) {
            const { entries } = await client.fetchAgents({
              includeBackground: args.includeBackground === true,
              filter: { includeArchived: args.includeArchived === true },
            });
            const page = selectAgentListPage(
              entries.map((entry) => entry.agent),
              {
                cwd: (args.cwd as string | undefined)?.trim()
                  ? expandUserPath(args.cwd as string)
                  : undefined,
                statuses: args.statuses as AgentSnapshotPayload["status"][] | undefined,
                sinceHours: args.sinceHours as number | undefined,
                limit: args.limit as number | undefined,
                query: args.query as string | undefined,
              },
            );
            return result({
              agents: page.agents,
              ...(page.more > 0
                ? moreNote(page.more, "narrow with query, cwd, or statuses, or raise limit")
                : {}),
            });
          },
          async listWorkspaces(args) {
            const { entries } = await client.fetchWorkspaces({
              includeBackground: args.includeBackground === true,
            });
            const newestFirst = entries.toSorted(
              (a, b) =>
                Date.parse(b.activityAt ?? b.createdAt ?? "") -
                Date.parse(a.activityAt ?? a.createdAt ?? ""),
            );
            const page = selectWorkspaceSummaries(newestFirst.map(workspaceSummary), {
              query: args.query as string | undefined,
              projectId: args.projectId as string | undefined,
              cwd: args.cwd as string | undefined,
              limit: args.limit as number | undefined,
            });
            return result({
              workspaces: page.items,
              ...(page.more > 0
                ? moreNote(page.more, "narrow with query, projectId, or cwd, or raise limit")
                : {}),
            });
          },
          async createWorkspace(args) {
            const isolation = z.enum(["local", "worktree"]).parse(args.isolation);
            const path = z.string().min(1).parse(args.path);
            const response = await client.createWorkspace({
              source:
                isolation === "local"
                  ? { kind: "directory", path, projectId: args.projectId as string | undefined }
                  : {
                      kind: "worktree",
                      cwd: path,
                      projectId: args.projectId as string | undefined,
                      action:
                        args.mode === "checkout-branch" || args.mode === "checkout-pr"
                          ? "checkout"
                          : "branch-off",
                      baseBranch: args.baseBranch as string | undefined,
                      branchName: args.branchName as string | undefined,
                      refName: args.branch as string | undefined,
                      githubPrNumber: args.prNumber as number | undefined,
                      worktreeSlug: args.worktreeSlug as string | undefined,
                    },
              title: args.title as string | undefined,
              background: args.background as boolean | undefined,
            });
            if (response.error || !response.workspace)
              throw new Error(response.error ?? "Workspace creation failed");
            return result(workspaceSummary(response.workspace));
          },
        }),
      );
    },
  };
}
function workspaceSummary(workspace: FetchWorkspacesEntry) {
  return {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    cwd: workspace.workspaceDirectory,
    isolation: workspace.workspaceKind === "worktree" ? "worktree" : "local",
    kind: workspace.workspaceKind === "checkout" ? "local_checkout" : workspace.workspaceKind,
    title: workspace.title,
    background: workspace.background,
  };
}

function remoteObservation(client: DaemonClient): HostObservation {
  return {
    async observe(agentId, handler, signal, onError) {
      const observation = client.observeTimeline([agentId], { signal });
      const refresh = async (event?: AgentStreamEvent) => {
        let snapshot = (await client.fetchAgent(agentId))?.agent ?? null;
        let lastMessage: string | null = null;
        if (
          snapshot &&
          (snapshot.status === "idle" ||
            snapshot.status === "closed" ||
            snapshot.status === "error" ||
            snapshot.pendingPermissions.length > 0)
        ) {
          // A new turn may start between the snapshot and the current-response read.
          // Bound that wait and refresh state instead of attributing the old event to it.
          const current = await client.waitForFinish(agentId, 100);
          if (current.status === "timeout") {
            // Queued delivery can leave a closed/error snapshot visible before the new turn.
            // A timed-out wait has not established an outcome for that queued work.
            if (event?.type === "permission_resolved") handler(snapshot, event);
            return;
          }
          if (!current.final && current.error && current.error !== `Agent not found: ${agentId}`)
            throw new Error(current.error);
          snapshot = current.final;
          lastMessage = current.lastMessage;
        }
        handler(snapshot, event, lastMessage);
      };
      let updates = Promise.resolve();
      const unsubscribe = observation.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type !== "agent_stream" || message.payload.agentId !== agentId) return;
          const event = message.payload.event;
          if (
            event.type === "permission_requested" ||
            event.type === "permission_resolved" ||
            event.type === "turn_started" ||
            event.type === "turn_completed" ||
            event.type === "turn_canceled" ||
            event.type === "turn_failed"
          )
            updates = updates.then(() => refresh(event)).catch(onError);
        },
        error: onError,
      });
      try {
        await observation.ready;
        await refresh();
      } catch (error) {
        unsubscribe();
        await observation.release();
        throw error;
      }
      return async () => {
        unsubscribe();
        await observation.release();
      };
    },
    wait: (agentId, signal) => {
      const close = () => void client.close();
      signal.addEventListener("abort", close, { once: true });
      return client
        .waitForFinish(agentId, 0)
        .then((outcome) => {
          if (!outcome.final && outcome.error && outcome.error !== `Agent not found: ${agentId}`)
            throw new Error(outcome.error);
          return outcome;
        })
        .finally(() => signal.removeEventListener("abort", close));
    },
  };
}

/** Shares routed status observation with daemon services independently of MCP execution. */
export function createHostObservationResolver(input: {
  serverId: string;
  local: HostObservation;
  hosts(): ToolHosts;
}) {
  return {
    async use<T>(
      serverId: string | undefined,
      action: (host: HostObservation) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      if (!serverId || serverId === input.serverId) return action(input.local);
      const hosts = input.hosts();
      async function classify(error: unknown): Promise<HostObservationError> {
        // This is the origin's authoritative registration directory, not a destination RPC error.
        const row = (await hosts.directory()).hosts.find((host) => host.serverId === serverId);
        if (!row) return new HostObservationError("removed", error);
        if (row.status === "connecting") return new HostObservationError("connecting", error);
        return new HostObservationError("unreachable", error);
      }
      async function fail(error: unknown): Promise<never> {
        throw await classify(error);
      }
      try {
        return await hosts.use(
          serverId,
          (client) => {
            const remote = remoteObservation(client);
            return action({
              wait: (agentId, lifetime) => remote.wait(agentId, lifetime).catch(fail),
              observe(agentId, handler, lifetime, onError) {
                async function report(error: unknown): Promise<void> {
                  try {
                    onError(await classify(error));
                  } catch (failure) {
                    onError(failure);
                  }
                }
                return remote.observe(agentId, handler, lifetime, report).catch(fail);
              },
            });
          },
          signal,
        );
      } catch (error) {
        if (error instanceof HostObservationError) throw error;
        return fail(error);
      }
    },
  };
}
