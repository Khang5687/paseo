import type {
  OmpRoutingAccountRef,
  OmpRoutingBillingState,
  OmpRoutingBlock,
  OmpRoutingRank,
  OmpRoutingWindow,
  RoutingRefusalCode,
  RoutingWaitReason,
} from "@getpaseo/protocol/messages";

export type {
  OmpAccountRoutingMutation,
  OmpAccountRoutingPolicy,
  OmpAccountRoutingState,
  OmpRoutingAccount,
  OmpRoutingAccountRef,
  RoutingRefusalCode,
  RoutingWaitReason,
} from "@getpaseo/protocol/messages";

/** Metadata-only account row as a native runtime reports it. Never carries a credential. */
export interface RoutingCatalogAccount {
  ref: OmpRoutingAccountRef;
  display: {
    email: string | null;
    accountId: string | null;
    organizationId: string | null;
    organizationName: string | null;
  };
  credentialAvailable: boolean;
  quotaIdentity: { accountUuid: string; organizationUuid: string } | null;
  billing: OmpRoutingBillingState;
  subscriptionTier: {
    kind: "pro" | "max5" | "max20" | "other" | "unknown";
    observedAt: number | null;
    source: string | null;
  };
  windows: OmpRoutingWindow[];
  quotaBlocks: OmpRoutingBlock[];
  rank: OmpRoutingRank;
}

/** One namespace's catalog from one runtime. Revisions compare only within a runtime. */
export interface RoutingCatalog {
  provider: "anthropic";
  runtimeInstanceId: string;
  storeNamespace: string;
  catalogRevision: number;
  nativeCredentialGeneration: number;
  observedAt: number;
  authoritativeObservedAt: number | null;
  authoritativeComplete: boolean;
  accounts: RoutingCatalogAccount[];
}

export interface RankCandidatesInput {
  candidateRefs: OmpRoutingAccountRef[];
  modelId: string;
  catalogRevision: number;
  nowMs: number;
}

export interface RankCandidatesResult {
  method: string;
  version: number;
  catalogRevision: number;
  anchorRef: OmpRoutingAccountRef | null;
  bestCloseRefs: OmpRoutingAccountRef[];
}

/**
 * Host view of one attached native runtime (host contract D12). The runtime-admission slice
 * implements it over the JSONL control frames. Calls run outside the policy queue and reject on
 * disconnect or abort.
 */
export interface RoutingMetadataAdapter {
  catalogSnapshot(): readonly RoutingCatalog[];
  refreshMetadata(
    accountRef: OmpRoutingAccountRef,
    modelId: string,
    signal: AbortSignal,
  ): Promise<RoutingCatalog>;
  rankCandidates(input: RankCandidatesInput, signal: AbortSignal): Promise<RankCandidatesResult>;
  send(frame: RoutingWakeFrame): void;
}

export interface RoutingWakeFrame {
  type: "account.routing.resume";
  hostEpoch: string;
  runtimeInstanceId: string;
  waitId: string;
}

export interface AttachRuntimeInput {
  runtimeInstanceId: string;
  /** Trusted host agent from AgentLaunchContext, never from a native frame. */
  agentId: string;
  accessibleNamespaces: string[];
  capabilityVersion: number | null;
  /** null while negotiation is pending. */
  completeCoverage: boolean | null;
}

export interface AdmissionRequest {
  runtimeInstanceId: string;
  operationId: string;
  attemptId: string;
  sessionId: string;
  modelId: string;
  purpose: string;
  requestGeneration: number;
  /** Retires exactly this live wait when the continuation re-admits. */
  previousWaitId?: string;
  /** Cache-only catalog projection that rode in on the request. */
  catalog?: RoutingCatalog;
  signal?: AbortSignal;
}

export type AdmissionDecision =
  | {
      kind: "admit";
      admissionId: string;
      accountRef: OmpRoutingAccountRef;
      selectionGeneration: number;
      policyRevision: number;
    }
  | {
      kind: "wait";
      waitId: string;
      reason: RoutingWaitReason;
      reconsiderAt?: number;
      requiresUserAction: boolean;
    }
  | { kind: "refuse"; reason: RoutingRefusalCode; requiresUserAction: boolean };

export interface StartedReport {
  runtimeInstanceId: string;
  admissionId: string;
  startedAt: number;
}

export interface OutcomeReport {
  runtimeInstanceId: string;
  admissionId: string;
  hostEpoch: string;
  accountRef: OmpRoutingAccountRef;
  selectionGeneration: number;
  quotaBlocks: OmpRoutingBlock[];
}

export interface CancelReport {
  runtimeInstanceId: string;
  operationId: string;
  attemptId: string;
  waitId?: string;
  admissionId?: string;
}

export interface AccountRoutingClock {
  now(): number;
  /** Returns a canceller. */
  setTimer(callback: () => void, delayMs: number): () => void;
}

export type AccountRoutingErrorCode =
  | "conflict"
  | "invalid_account"
  | "unsupported"
  | "persistence_failed";

export const ROUTING_ERROR_MESSAGES: Record<AccountRoutingErrorCode, string> = {
  conflict: "Account routing settings changed. Review the current state and try again.",
  invalid_account: "That account is not known to this host.",
  unsupported: "Account routing is not supported by the connected runtime.",
  persistence_failed: "Account routing settings could not be saved.",
};

export class AccountRoutingPersistenceError extends Error {
  readonly code = "persistence_failed" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AccountRoutingPersistenceError";
  }
}

export function refKey(ref: OmpRoutingAccountRef): string {
  return `${ref.storeNamespace}\u0000${ref.nativeRowId}`;
}

export function sameRef(a: OmpRoutingAccountRef | null, b: OmpRoutingAccountRef | null): boolean {
  return a === b || (a !== null && b !== null && refKey(a) === refKey(b));
}

/** Stable order: namespace lexicographic, then native row ascending. */
export function compareRefs(a: OmpRoutingAccountRef, b: OmpRoutingAccountRef): number {
  if (a.storeNamespace !== b.storeNamespace) return a.storeNamespace < b.storeNamespace ? -1 : 1;
  return a.nativeRowId - b.nativeRowId;
}
