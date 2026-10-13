import type { Logger } from "pino";

import type { AccountRoutingAuthority } from "../../../account-routing/authority.js";
import type {
  AdmissionDecision,
  RankCandidatesInput,
  RankCandidatesResult,
  RoutingCatalog,
  RoutingMetadataAdapter,
} from "../../../account-routing/types.js";
import {
  OmpAccountRoutingCapabilityDocumentSchema,
  OmpRpcAccountRoutingFrameSchema,
  OmpRpcRoutingConfigureDataSchema,
  OmpRpcRoutingRankDataSchema,
  OmpRpcRoutingRefreshDataSchema,
  type OmpRpcAccountRoutingFrame,
  type OmpRpcAdmitDecision,
  type OmpRpcRoutingBillingState,
  type OmpRpcRoutingCatalog,
} from "./rpc-types.js";

/** The slice of the host authority the native bridge may call. Nothing else crosses the boundary. */
export type OmpRoutingAuthority = Pick<
  AccountRoutingAuthority,
  "hostEpoch" | "attachRuntime" | "admit" | "started" | "outcome" | "cancel"
>;

/**
 * Managed launch request carried by `OmpStartSessionInput`. `agentId` is the trusted host agent from
 * `AgentLaunchContext`; without it the launch is metadata-only and cannot dispatch models.
 */
export interface OmpHostRouting {
  authority: OmpRoutingAuthority;
  agentId?: string;
}

export interface OmpRoutingTransport {
  onMessage(callback: (message: Record<string, unknown>) => void): () => void;
  request(
    command: { type: string; [key: string]: unknown },
    timeoutMs?: number | null,
  ): Promise<unknown>;
  send(message: Record<string, unknown>): void;
}

/** Native refused or could not honor managed routing. Carries only an allowlisted code. */
export class OmpAccountRoutingRefusedError extends Error {
  constructor(readonly code: string) {
    super(`OMP account routing refused: ${code}`);
    this.name = "OmpAccountRoutingRefusedError";
  }
}

const CODE = /^[a-z_]{1,48}$/;

const BILLING_REASON = {
  no_evidence: null,
  malformed: "malformed",
  conflict: "conflicting",
  untrusted_source: "untrusted_source",
  identity_mismatch: "identity_mismatch",
  invalid_observation: "malformed",
  expired: "expired",
} as const satisfies Record<NonNullable<OmpRpcRoutingBillingState["reason"]>, string | null>;

/** Native catalogs name billing reasons in OMP's vocabulary and omit an absent one. */
function toHostCatalog(catalog: OmpRpcRoutingCatalog): RoutingCatalog {
  return {
    ...catalog,
    accounts: catalog.accounts.map((account) => ({
      ...account,
      billing: {
        ...account.billing,
        reason: account.billing.reason ? BILLING_REASON[account.billing.reason] : null,
      },
    })),
  };
}

function refusedFrom(error: unknown): OmpAccountRoutingRefusedError {
  if (error instanceof OmpAccountRoutingRefusedError) return error;
  const message = error instanceof Error ? error.message : "";
  return new OmpAccountRoutingRefusedError(CODE.test(message) ? message : "host_unavailable");
}

// ---------------------------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------------------------

export interface OmpCapabilityProbe {
  /** True only when the binary reports complete model-dispatch coverage. */
  complete: boolean;
  /** Document version, or 0 when the binary printed nothing this host understands. */
  version: number;
  /** The probe could not run the binary at all (missing, not executable, timed out), so nothing was learned. */
  unavailable?: boolean;
  /** `login` accepts `existing` and refuses to overwrite a stored account (add-only guard). */
  loginExisting?: boolean;
}

const REQUIRED_PURPOSES = ["model-dispatch", "metadata", "usage-refresh"];

/** Old binaries, bad JSON, missing fields and `completeCoverage:false` all read as incomplete. */
export function parseOmpCapabilityProbe(stdout: string): OmpCapabilityProbe {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { complete: false, version: 0 };
  }
  const parsed = OmpAccountRoutingCapabilityDocumentSchema.safeParse(raw);
  if (!parsed.success) return { complete: false, version: 0 };
  const caps = parsed.data.managedAccountRouting;
  return {
    version: parsed.data.version,
    complete:
      caps.completeCoverage &&
      caps.modelDispatch === "allowed" &&
      REQUIRED_PURPOSES.every((purpose) => caps.purposes.includes(purpose)),
    ...(parsed.data.login?.existing === true ? { loginExisting: true } : {}),
  };
}

// ponytail: per-binary memo with a TTL; a binary upgraded mid-run is re-probed within a minute.
const PROBE_TTL_MS = 60_000;
const probeMemo = new Map<string, { at: number; result: Promise<OmpCapabilityProbe> }>();

export function memoizeProbe(
  key: string,
  run: () => Promise<OmpCapabilityProbe>,
  now: () => number = Date.now,
): Promise<OmpCapabilityProbe> {
  const held = probeMemo.get(key);
  if (held && now() - held.at < PROBE_TTL_MS) return held.result;
  const result = run();
  probeMemo.set(key, { at: now(), result });
  // A probe that threw is not remembered; the next launch asks again.
  result.catch(() => probeMemo.delete(key));
  return result;
}

// ---------------------------------------------------------------------------------------------
// Inert adapter for a runtime that registers as incomplete (unmarked launch, no JSONL control)
// ---------------------------------------------------------------------------------------------

export function inertRoutingAdapter(): RoutingMetadataAdapter {
  const unavailable = () =>
    Promise.reject(new OmpAccountRoutingRefusedError("unsupported_runtime"));
  return {
    catalogSnapshot: () => [],
    refreshMetadata: unavailable,
    rankCandidates: unavailable,
    send: () => undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------------------------

export interface OmpAccountRoutingBridgeOptions {
  authority: OmpRoutingAuthority;
  transport: OmpRoutingTransport;
  logger: Logger;
  runtimeInstanceId: string;
  /** Trusted host agent. Never read from a native frame. */
  agentId: string;
}

type Phase = "configuring" | "managed" | "closed";

const QUEUE_LIMIT = 256;

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new OmpAccountRoutingRefusedError("cancelled");
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new OmpAccountRoutingRefusedError("cancelled"));
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Bridges one owned OMP child's `account.routing.*` JSONL frames to the host routing authority.
 *
 * Construct it before the child's readiness handshake: the frame listener and the pending-configure
 * latch must exist before anything the child does during startup. Frames that arrive before
 * `configure()` finishes attaching the runtime are queued in order and replayed after it.
 *
 * The bridge holds no policy. Every decision is the authority's; the bridge validates frames,
 * enforces epoch and instance identity, and maps authority results onto the native wire.
 */
export class OmpAccountRoutingBridge {
  private phase: Phase = "configuring";
  private readonly queue: OmpRpcAccountRoutingFrame[] = [];
  private readonly catalogs = new Map<string, RoutingCatalog>();
  private accessibleNamespaces: ReadonlySet<string> = new Set();
  private readonly inflight = new Map<string, AbortController>();
  private registration: { dispose(): void } | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: OmpAccountRoutingBridgeOptions) {
    this.unsubscribe = options.transport.onMessage((message) => this.onMessage(message));
  }

  get hostEpoch(): string {
    return this.options.authority.hostEpoch;
  }

  /**
   * Sends `account.routing.configure`, requires complete coverage and model dispatch, then registers
   * the runtime with the authority. Throws {@link OmpAccountRoutingRefusedError} otherwise; the
   * caller closes the child. Nothing falls back to an unmanaged credential.
   */
  async configure(): Promise<void> {
    const { authority, transport, runtimeInstanceId, agentId } = this.options;
    let data;
    try {
      data = OmpRpcRoutingConfigureDataSchema.parse(
        await transport.request({
          type: "account.routing.configure",
          version: 1,
          hostEpoch: authority.hostEpoch,
          runtimeInstanceId,
          scope: "host-owned",
          provider: "anthropic",
          includedOnly: true,
        }),
      );
    } catch (error) {
      this.close();
      throw refusedFrom(error);
    }
    if (!data.completeCoverage || data.modelDispatch !== "allowed") {
      this.close();
      throw new OmpAccountRoutingRefusedError("unsupported_runtime");
    }
    if (this.phase === "closed") throw new OmpAccountRoutingRefusedError("host_unavailable");
    this.accessibleNamespaces = new Set(data.accessibleNamespaces);
    for (const catalog of data.catalogs) this.holdCatalog(toHostCatalog(catalog));
    this.registration = authority.attachRuntime(
      {
        runtimeInstanceId,
        agentId,
        accessibleNamespaces: data.accessibleNamespaces,
        capabilityVersion: data.version,
        completeCoverage: true,
      },
      this.adapter(),
    );
    this.phase = "managed";
    for (const frame of this.queue.splice(0)) this.handle(frame);
  }

  /** Idempotent. Detaches the runtime (policy persists, transient work clears) and stops listening. */
  close(): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.unsubscribe();
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    this.queue.length = 0;
    this.registration?.dispose();
    this.registration = null;
  }

  private holdCatalog(catalog: RoutingCatalog): void {
    if (catalog.runtimeInstanceId !== this.options.runtimeInstanceId) return;
    const held = this.catalogs.get(catalog.storeNamespace);
    if (!held || catalog.catalogRevision >= held.catalogRevision) {
      this.catalogs.set(catalog.storeNamespace, catalog);
    }
  }

  private adapter(): RoutingMetadataAdapter {
    const { transport, runtimeInstanceId, authority } = this.options;
    return {
      catalogSnapshot: () => [...this.catalogs.values()],
      refreshMetadata: async (accountRef, modelId, signal) => {
        try {
          const data = OmpRpcRoutingRefreshDataSchema.parse(
            await raceAbort(
              transport.request({
                type: "account.routing.refresh",
                hostEpoch: authority.hostEpoch,
                runtimeInstanceId,
                accountRef,
                modelId,
              }),
              signal,
            ),
          );
          const catalog = toHostCatalog(data.catalog);
          this.holdCatalog(catalog);
          return catalog;
        } catch (error) {
          throw refusedFrom(error);
        }
      },
      rankCandidates: async (input: RankCandidatesInput, signal): Promise<RankCandidatesResult> => {
        try {
          const data = OmpRpcRoutingRankDataSchema.parse(
            await raceAbort(
              transport.request({
                type: "account.routing.rank",
                hostEpoch: authority.hostEpoch,
                runtimeInstanceId,
                modelId: input.modelId,
                catalogRevision: input.catalogRevision,
                candidateRefs: input.candidateRefs,
                nowMs: input.nowMs,
              }),
              signal,
            ),
          );
          return data;
        } catch (error) {
          throw refusedFrom(error);
        }
      },
      send: (frame) => transport.send({ ...frame }),
    };
  }

  private onMessage(message: Record<string, unknown>): void {
    const type = message.type;
    if (typeof type !== "string" || !type.startsWith("account.routing.")) return;
    const parsed = OmpRpcAccountRoutingFrameSchema.safeParse(message);
    if (!parsed.success) {
      this.options.logger.warn({ type }, "Ignoring malformed OMP account-routing frame");
      // A request nobody answers would hold the model call forever; refuse it by name.
      if (type === "account.routing.admit.request" && typeof message.id === "string") {
        this.respond(message.id, { kind: "refuse", reason: "host_unavailable" });
      }
      return;
    }
    const frame = parsed.data;
    if (this.phase === "closed") return;
    if (this.phase === "configuring") {
      if (this.queue.length < QUEUE_LIMIT) this.queue.push(frame);
      return;
    }
    this.handle(frame);
  }

  private handle(frame: OmpRpcAccountRoutingFrame): void {
    const { authority, runtimeInstanceId } = this.options;
    // A frame for another epoch or instance belongs to nobody here: ignore, never act on it.
    if (frame.hostEpoch !== authority.hostEpoch || frame.runtimeInstanceId !== runtimeInstanceId) {
      this.options.logger.warn(
        { type: frame.type },
        "Ignoring OMP account-routing frame for another epoch",
      );
      return;
    }
    switch (frame.type) {
      case "account.routing.admit.request":
        void this.admit(frame);
        return;
      case "account.routing.started":
        authority.started({
          runtimeInstanceId,
          admissionId: frame.admissionId,
          startedAt: frame.startedAt,
        });
        return;
      case "account.routing.outcome":
        authority.outcome({
          runtimeInstanceId,
          admissionId: frame.admissionId,
          hostEpoch: frame.hostEpoch,
          accountRef: frame.accountRef,
          selectionGeneration: frame.selectionGeneration,
          quotaBlocks: frame.quotaBlocks,
        });
        return;
      case "account.routing.cancel": {
        this.inflight.get(frame.id)?.abort();
        this.inflight.delete(frame.id);
        authority.cancel({
          runtimeInstanceId,
          operationId: frame.operationId,
          attemptId: frame.attemptId,
          ...(frame.waitId ? { waitId: frame.waitId } : {}),
          ...(frame.admissionId ? { admissionId: frame.admissionId } : {}),
        });
        return;
      }
      // The authority created the wait itself, and owns its wake. These are native-side notices.
      case "account.routing.paused":
      case "account.routing.resumed":
        return;
    }
  }

  private async admit(
    frame: Extract<OmpRpcAccountRoutingFrame, { type: "account.routing.admit.request" }>,
  ) {
    const { authority, runtimeInstanceId } = this.options;
    const controller = new AbortController();
    this.inflight.set(frame.id, controller);
    let decision: AdmissionDecision;
    if (!this.accessibleNamespaces.has(frame.catalog.storeNamespace)) {
      // Exact-source guard: a catalog from a namespace this runtime did not declare is not served.
      decision = { kind: "refuse", reason: "source_inaccessible", requiresUserAction: true };
    } else {
      try {
        decision = await authority.admit({
          runtimeInstanceId,
          operationId: frame.operationId,
          attemptId: frame.attemptId,
          sessionId: frame.sessionId,
          modelId: frame.modelId,
          purpose: frame.purpose,
          requestGeneration: frame.requestGeneration,
          ...(frame.previousWaitId ? { previousWaitId: frame.previousWaitId } : {}),
          catalog: toHostCatalog(frame.catalog),
          signal: controller.signal,
        });
        this.holdCatalog(toHostCatalog(frame.catalog));
      } catch {
        decision = { kind: "refuse", reason: "host_unavailable", requiresUserAction: false };
      }
    }
    const withdrawn = controller.signal.aborted || this.phase === "closed";
    this.inflight.delete(frame.id);
    if (withdrawn) {
      // Native withdrew the request (or the child is gone): nobody will hear a grant or a wait.
      if (decision.kind === "admit") {
        authority.cancel({
          runtimeInstanceId,
          operationId: frame.operationId,
          attemptId: frame.attemptId,
          admissionId: decision.admissionId,
        });
      } else if (decision.kind === "wait") {
        authority.cancel({
          runtimeInstanceId,
          operationId: frame.operationId,
          attemptId: frame.attemptId,
          waitId: decision.waitId,
        });
      }
      return;
    }
    this.respond(frame.id, toWire(decision));
  }

  private respond(id: string, decision: OmpRpcAdmitDecision): void {
    if (this.phase === "closed") return;
    this.options.transport.send({
      type: "account.routing.admit.response",
      id,
      hostEpoch: this.options.authority.hostEpoch,
      runtimeInstanceId: this.options.runtimeInstanceId,
      decision,
    });
  }
}

/** Native's decision carries no `requiresUserAction`; that stays a host UI fact. */
function toWire(decision: AdmissionDecision): OmpRpcAdmitDecision {
  switch (decision.kind) {
    case "admit":
      return {
        kind: "admit",
        admissionId: decision.admissionId,
        accountRef: decision.accountRef,
        selectionGeneration: decision.selectionGeneration,
        policyRevision: decision.policyRevision,
      };
    case "wait":
      return {
        kind: "wait",
        waitId: decision.waitId,
        reason: decision.reason,
        ...(decision.reconsiderAt !== undefined ? { reconsiderAt: decision.reconsiderAt } : {}),
      };
    case "refuse":
      return { kind: "refuse", reason: decision.reason };
  }
}
