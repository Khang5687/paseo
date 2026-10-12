import type {
  OmpAccountRoutingState,
  OmpRoutingAccount,
  OmpRoutingAccountRef,
  OmpRoutingWindow,
  ProviderUsageWindow,
  UsageReport,
  UsageReportEntry,
} from "@getpaseo/protocol/messages";

/** `snapshotForAgent` result plus the trusted host agent it was filtered for. */
export type ManagedRoutingSnapshot = Pick<
  OmpAccountRoutingState,
  "hostEpoch" | "stateSequence" | "accounts" | "activeRequests" | "lastServed"
> & { agentId: string };

export const ROUTING_SOURCE_ID = "omp-routing";
const ROUTING_ID_PREFIX = "omp-routing:";
const MANAGED_ID_PREFIX = "omp-managed:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function managedReportId(agentId: string): string {
  return `${MANAGED_ID_PREFIX}${agentId}`;
}

export function routingReportId(ref: OmpRoutingAccountRef): string {
  return (
    ROUTING_ID_PREFIX +
    Buffer.from(JSON.stringify([ref.storeNamespace, ref.nativeRowId])).toString("base64url")
  );
}

/** Null unless `id` is exactly what `routingReportId` produces: a namespace UUID and a row. */
export function decodeRoutingReportId(id: string): OmpRoutingAccountRef | null {
  if (!id.startsWith(ROUTING_ID_PREFIX)) return null;
  try {
    const payload = id.slice(ROUTING_ID_PREFIX.length);
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [storeNamespace, nativeRowId] = parsed as unknown[];
    if (typeof storeNamespace !== "string" || !UUID.test(storeNamespace)) return null;
    if (typeof nativeRowId !== "number" || !Number.isSafeInteger(nativeRowId) || nativeRowId < 1)
      return null;
    const ref = { storeNamespace, nativeRowId };
    return routingReportId(ref) === id ? ref : null;
  } catch {
    return null;
  }
}

const refKey = (ref: OmpRoutingAccountRef) => `${ref.storeNamespace}\u0000${ref.nativeRowId}`;
const compareRefs = (a: OmpRoutingAccountRef, b: OmpRoutingAccountRef) =>
  a.storeNamespace.localeCompare(b.storeNamespace) || a.nativeRowId - b.nativeRowId;

/**
 * Serving identities come from the authority's own records, never launch env. Admitted-but-not-
 * started is not serving. With none serving, the one last-served identity stands in; with
 * neither, the agent has not dispatched yet and the single report says so.
 */
export function projectManagedUsage(
  snapshot: ManagedRoutingSnapshot,
  nowMs: number,
): UsageReportEntry[] {
  const serving = new Map<string, OmpRoutingAccountRef>();
  for (const request of snapshot.activeRequests) {
    if (request.agentId === snapshot.agentId && request.phase === "serving")
      serving.set(refKey(request.accountRef), request.accountRef);
  }
  const lastServed = snapshot.lastServed.find((entry) => entry.agentId === snapshot.agentId);
  const routing = { hostEpoch: snapshot.hostEpoch, stateSequence: snapshot.stateSequence };

  if (serving.size === 0 && !lastServed) {
    return [
      {
        id: managedReportId(snapshot.agentId),
        sourceId: ROUTING_SOURCE_ID,
        sourceLabel: "Claude",
        account: {},
        fetchedAt: new Date(nowMs).toISOString(),
        report: {
          status: "unavailable",
          problem: { kind: "no_quota", detail: "No request has been served yet." },
        },
        routing: { accountRef: null, state: "unknown", ...routing },
      },
    ];
  }

  const refs = serving.size > 0 ? [...serving.values()] : [lastServed!.accountRef];
  const state = serving.size > 0 ? "serving" : "last_served";
  return refs.sort(compareRefs).map((ref) => {
    const account = snapshot.accounts.find((a) => refKey(a.ref) === refKey(ref));
    const authorityAt =
      lastServed && refKey(lastServed.accountRef) === refKey(ref)
        ? lastServed.servedAt
        : (snapshot.activeRequests.find((r) => refKey(r.accountRef) === refKey(ref))?.observedAt ??
          nowMs);
    const { report, observedAt } = projectReport(account, nowMs);
    const stale = observedAt === null;
    const entry: UsageReportEntry = {
      id: routingReportId(ref),
      sourceId: ROUTING_SOURCE_ID,
      sourceLabel: "Claude",
      account: account ? { label: account.label } : {},
      fetchedAt: new Date(observedAt ?? authorityAt).toISOString(),
      report:
        stale && report.status === "available"
          ? {
              ...report,
              details: [...(report.details ?? []), { id: "stale", label: "Stale", value: "true" }],
            }
          : report,
      routing: { accountRef: ref, state, ...routing },
    };
    return entry;
  });
}

function projectReport(
  account: OmpRoutingAccount | undefined,
  nowMs: number,
): { report: UsageReport; observedAt: number | null } {
  if (!account || account.windows.length === 0) {
    return {
      report: {
        status: "unavailable",
        problem: { kind: "no_quota", detail: "Usage windows are unknown." },
      },
      observedAt: null,
    };
  }
  const times = [
    ...account.windows.map((w) => w.observedAt),
    account.subscriptionTier.observedAt,
    account.billing.observedAt,
  ].filter((t): t is number => t !== null);
  const report: UsageReport = {
    status: "available",
    windows: account.windows.map((w) => projectWindow(w, nowMs)),
    ...(account.quotaIdentity ? { quotaIdentity: account.quotaIdentity } : {}),
    ...(account.subscriptionTier.kind === "unknown"
      ? {}
      : {
          subscription: {
            subscriptionType: account.subscriptionTier.kind,
            rateLimitTier: null,
            observedAt: account.subscriptionTier.observedAt,
            source: "native-usage" as const,
          },
        }),
  };
  return { report, observedAt: times.length ? Math.max(...times) : null };
}

function windowIdentity(w: OmpRoutingWindow): { id: string; label: string; shortLabel: string } {
  if (w.id === "5h") return { id: "five-hour", label: "5-hour", shortLabel: "5h" };
  if (w.id === "7d" && w.scope.kind === "shared")
    return { id: "weekly", label: "Weekly", shortLabel: "wk" };
  if (w.id === "7d") {
    const name =
      w.scope.kind === "model" ? w.scope.modelId : ((w.scope as { family?: string }).family ?? "");
    return { id: `weekly-${name}`, label: `Weekly · ${name}`, shortLabel: `wk ${name}` };
  }
  return { id: w.id, label: w.label, shortLabel: w.label };
}

/** An expired or empty reading is unknown, never zero. */
function projectWindow(w: OmpRoutingWindow, nowMs: number): ProviderUsageWindow {
  const expired = w.validUntil !== null && w.validUntil <= nowMs;
  const used = w.usedFraction === null || expired ? null : w.usedFraction * 100;
  return {
    ...windowIdentity(w),
    usedPct: used,
    remainingPct: used === null ? null : Math.max(0, 100 - used),
    resetsAt: w.resetAt === null ? null : new Date(w.resetAt).toISOString(),
  };
}

function tierKind(sub: { subscriptionType: string | null; rateLimitTier: string | null }) {
  const type = sub.subscriptionType?.toLowerCase() ?? null;
  const tier = sub.rateLimitTier?.toLowerCase() ?? "";
  if (type === null && !tier) return "unknown" as const;
  if (type === "pro") return "pro" as const;
  if (type === "max" && /(^|_)5x($|_)/.test(tier)) return "max5" as const;
  if (type === "max" && /(^|_)20x($|_)/.test(tier)) return "max20" as const;
  return "other" as const;
}

/**
 * Fills a native account's unknown or older tier from an already-fetched usage report. The join
 * is the exact account and organization UUID pair; report IDs, labels and hashed route keys never
 * match. A report that is not strictly newer than a known native tier cannot replace it.
 */
export function enrichRoutingTier(
  nativeAccount: OmpRoutingAccount,
  cachedReports: readonly UsageReportEntry[],
): OmpRoutingAccount {
  const identity = nativeAccount.quotaIdentity;
  if (!identity) return nativeAccount;
  let best: { kind: ReturnType<typeof tierKind>; observedAt: number; source: string } | null = null;
  for (const entry of cachedReports) {
    const report = entry.report;
    if (report.status !== "available" || !report.quotaIdentity || !report.subscription) continue;
    if (
      report.quotaIdentity.accountUuid !== identity.accountUuid ||
      report.quotaIdentity.organizationUuid !== identity.organizationUuid
    )
      continue;
    const { observedAt, source } = report.subscription;
    if (observedAt === null || source === "unknown") continue;
    const kind = tierKind(report.subscription);
    if (kind === "unknown" || (best && best.observedAt >= observedAt)) continue;
    best = { kind, observedAt, source };
  }
  const current = nativeAccount.subscriptionTier;
  if (!best) return nativeAccount;
  if (current.kind !== "unknown" && (current.observedAt ?? -Infinity) >= best.observedAt)
    return nativeAccount;
  return { ...nativeAccount, subscriptionTier: best };
}
