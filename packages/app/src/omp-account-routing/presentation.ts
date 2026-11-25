import type {
  OmpAccountRoutingState,
  OmpRoutingAccount,
  OmpRoutingAccountRef,
  OmpRoutingWindow,
  RoutingWaitOrRefusalCode,
} from "@getpaseo/protocol/messages";

/** Stable identity of a native account. Never derived from labels or list position. */
export function refKey(ref: OmpRoutingAccountRef): string {
  return JSON.stringify([ref.storeNamespace, ref.nativeRowId]);
}

export function sameRef(a: OmpRoutingAccountRef | null, b: OmpRoutingAccountRef | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.storeNamespace === b.storeNamespace &&
    a.nativeRowId === b.nativeRowId
  );
}

export type ServingRequest = OmpAccountRoutingState["activeRequests"][number];
export type LastServed = OmpAccountRoutingState["lastServed"][number];

export interface AccountRow {
  key: string;
  ref: OmpRoutingAccountRef;
  /** Null for a saved ref the catalog no longer has (tombstone). */
  account: OmpRoutingAccount | null;
  /** 1-based position in the visible policy order. */
  position: number;
  included: boolean;
  isCurrent: boolean;
  serving: ServingRequest[];
  admitted: ServingRequest[];
  lastServed: LastServed[];
}

/** Rows in policy priority order; catalog accounts the policy has not ranked yet follow in catalog order. */
export function buildAccountRows(state: OmpAccountRoutingState): AccountRow[] {
  const byKey = new Map(state.accounts.map((account) => [refKey(account.ref), account] as const));
  const ordered: OmpRoutingAccountRef[] = [];
  const seen = new Set<string>();
  const push = (ref: OmpRoutingAccountRef | null) => {
    if (!ref || seen.has(refKey(ref))) return;
    seen.add(refKey(ref));
    ordered.push(ref);
  };
  state.policy.priorityOrder.forEach(push);
  state.accounts.forEach((account) => push(account.ref));
  push(state.policy.current);
  return ordered.map((ref, index) => {
    const key = refKey(ref);
    const requests = state.activeRequests.filter((request) => sameRef(request.accountRef, ref));
    return {
      key,
      ref,
      account: byKey.get(key) ?? null,
      position: index + 1,
      // Included unless the policy says otherwise, matching the host authority.
      included:
        state.policy.inclusion.find((entry) => sameRef(entry.account, ref))?.included ?? true,
      isCurrent: sameRef(state.policy.current, ref),
      serving: requests.filter((request) => request.phase === "serving"),
      admitted: requests.filter((request) => request.phase === "admitted"),
      lastServed: state.lastServed.filter((entry) => sameRef(entry.accountRef, ref)),
    };
  });
}

export interface AccountTitle {
  title: string;
  /** Organization line, or null when the row has none worth showing (missing account, default personal organization). */
  organization: string | null;
}

function organizationName(account: OmpRoutingAccount, shared: boolean): string | null {
  if (!account.organizationLabel) return null;
  return shared ? account.organizationIdentityLabel : account.organizationLabel;
}

/** The organization every personal account gets by default; it only repeats the account name. */
function isDefaultOrganization(account: OmpRoutingAccount): boolean {
  return (
    account.organizationLabel === `${account.label}'s Organization` ||
    account.organizationLabel === `${account.label}\u2019s Organization`
  );
}

/**
 * Known only by a saved ref or a labels-only store listing: no catalog has measured or checked
 * anything for it yet. The unknowns are then "not reported", not a problem with the account.
 */
export function detailsPending(account: OmpRoutingAccount | null): boolean {
  return (
    account !== null &&
    account.authoritativeObservedAt === null &&
    account.billing.state === "unknown" &&
    account.billing.observedAt === null &&
    account.windows.length === 0
  );
}

/**
 * Names an account with the server's labels. A label shared with another account switches to the
 * server's identity label, and a shared organization to its organization identity label, so two
 * accounts are never indistinguishable.
 */
export function describeAccount(
  row: AccountRow,
  rows: readonly AccountRow[],
  fallbacks: {
    missing: (rowId: number) => string;
    unknownOrganization: string;
    detailsPending: string;
  },
): AccountTitle {
  const account = row.account;
  if (!account) return { title: fallbacks.missing(row.ref.nativeRowId), organization: null };
  const others = rows.filter((other) => other.key !== row.key && other.account);
  const labelShared = others.some((other) => other.account?.label === account.label);
  const orgShared = others.some(
    (other) =>
      other.account?.label === account.label &&
      other.account.organizationLabel === account.organizationLabel,
  );
  return {
    title: labelShared ? account.identityLabel : account.label,
    // Kept while another account shares the label, where the organization tells them apart.
    organization:
      !labelShared && isDefaultOrganization(account)
        ? null
        : (organizationName(account, orgShared) ??
          (detailsPending(account) ? fallbacks.detailsPending : fallbacks.unknownOrganization)),
  };
}

export type WindowKind = "fiveHour" | "weekly" | "model" | "other";

export type WindowTone = "default" | "warning" | "danger";

export interface WindowView {
  key: string;
  kind: WindowKind;
  /** The window's length when the id names one; model windows keep theirs. */
  period: "fiveHour" | "weekly" | null;
  /** Model named in the server label's trailing parentheses, for model windows. */
  model: string | null;
  /** Server label; only shown for unclassified windows and model windows without a known period. */
  serverLabel: string;
  /** Whole percent in [0,100]; 100 only when nothing is left, 0 only when nothing is used. */
  consumedPct: number | null;
  tone: WindowTone;
  resetAt: number | null;
  observedAt: number | null;
  stale: boolean;
}

function windowKind(window: OmpRoutingWindow): WindowKind {
  if (window.id === "5h") return "fiveHour";
  if (window.id === "7d" && window.scope.kind === "shared") return "weekly";
  if (window.scope.kind === "model" || window.scope.kind === "family") return "model";
  return "other";
}

function windowPeriod(window: OmpRoutingWindow): WindowView["period"] {
  if (window.id === "5h") return "fiveHour";
  if (window.id === "7d") return "weekly";
  return null;
}

/** Same bands as the Usage screen: warning from 70%, danger above 90%. */
function toneFor(consumedPct: number | null): WindowTone {
  if (consumedPct === null) return "default";
  if (consumedPct > 90) return "danger";
  return consumedPct >= 70 ? "warning" : "default";
}

const KIND_ORDER: Record<WindowKind, number> = { fiveHour: 0, weekly: 1, model: 2, other: 3 };

/** Rounds so 100% consumed means exhausted and 100% remaining means untouched. */
export function consumedPercent(usedFraction: number): number {
  return Math.min(100, Math.max(0, Math.ceil(usedFraction * 100 - 1e-9)));
}

/** Five-hour, shared weekly, then model/family windows; the server's order within each group. */
export function buildWindowViews(account: OmpRoutingAccount, nowMs: number): WindowView[] {
  return account.windows
    .map((window, index) => ({ window, index }))
    .toSorted(
      (a, b) =>
        KIND_ORDER[windowKind(a.window)] - KIND_ORDER[windowKind(b.window)] || a.index - b.index,
    )
    .map(({ window }) => {
      const expired = window.validUntil !== null && window.validUntil <= nowMs;
      const measured = window.usedFraction !== null && window.source !== "unknown" && !expired;
      const consumed = measured ? consumedPercent(window.usedFraction as number) : null;
      const kind = windowKind(window);
      return {
        key: `${window.id}:${JSON.stringify(window.scope)}`,
        kind,
        period: windowPeriod(window),
        model: kind === "model" ? (/\(([^()]+)\)\s*$/.exec(window.label)?.[1] ?? null) : null,
        serverLabel: window.label,
        consumedPct: consumed,
        tone: toneFor(consumed),
        resetAt: window.resetAt,
        observedAt: window.observedAt,
        stale: expired || window.source === "unknown",
      };
    });
}

export type BadgeKind =
  | "current"
  | "serving"
  | "lastServed"
  | "excluded"
  | "missing"
  | "billing"
  | "quota";

/** Which reason copy explains an account's refusal. Billing and credential state outrank quota. */
export function accountRefusal(
  row: AccountRow,
  nowMs: number,
): { kind: "billing" | "quota" | "unavailable"; code: RoutingWaitOrRefusalCode } | null {
  const account = row.account;
  if (!account || detailsPending(account)) return null;
  if (account.billing.state === "enabled") return { kind: "billing", code: "billing_enabled" };
  if (account.billing.state === "unknown") return { kind: "billing", code: "billing_unknown" };
  if (!account.available) return { kind: "unavailable", code: "source_inaccessible" };
  const blocked = account.quotaBlocks.some(
    (block) => block.resetAt === null || block.resetAt > nowMs,
  );
  return blocked ? { kind: "quota", code: "quota_blocked" } : null;
}

const LIMIT_ORDER: Record<WindowKind, number> = { weekly: 0, model: 1, fiveHour: 2, other: 3 };

/** The full window that explains a quota refusal: the longest limit first. Null when none is known full. */
export function quotaLimit(views: readonly WindowView[]): WindowView | null {
  return (
    views
      .filter((view) => view.consumedPct === 100)
      .toSorted((a, b) => LIMIT_ORDER[a.kind] - LIMIT_ORDER[b.kind])[0] ?? null
  );
}

/** When the account can serve again: its latest still-pending reset among full windows and quota blocks. */
function recoveryAt(row: AccountRow, nowMs: number): number | null {
  if (!row.account) return null;
  const resets = [
    ...buildWindowViews(row.account, nowMs)
      .filter((view) => view.consumedPct === 100)
      .map((view) => view.resetAt),
    ...row.account.quotaBlocks.map((block) => block.resetAt),
  ].filter((at): at is number => at !== null && at > nowMs);
  return resets.length > 0 ? Math.max(...resets) : null;
}

export type RoutingSummary =
  | { kind: "paused"; resumesAt: number | null }
  | { kind: "using"; row: AccountRow }
  | { kind: "auto" };

/** One line for the whole section, from the same rows and refusals the list shows. */
export function summarizeRouting(
  state: OmpAccountRoutingState,
  rows: readonly AccountRow[],
  nowMs: number,
): RoutingSummary | null {
  const candidates = rows.filter((row) => row.included && row.account);
  if (
    state.policy.autoEnabled &&
    candidates.length > 0 &&
    candidates.every((row) => accountRefusal(row, nowMs)?.kind === "quota")
  ) {
    const times = candidates.map((row) => recoveryAt(row, nowMs)).filter((at) => at !== null);
    return { kind: "paused", resumesAt: times.length > 0 ? Math.min(...times) : null };
  }
  const current = rows.find((row) => row.isCurrent);
  if (current) return { kind: "using", row: current };
  return state.policy.autoEnabled ? { kind: "auto" } : null;
}

export type SectionNoticeKind =
  | "unsupported"
  | "offline"
  | "readOnly"
  | "pending"
  | "conflict"
  | "paused"
  | "recovered";

const NO_RECOVERIES: ReadonlySet<string> = new Set();

export interface SectionState {
  /**
   * Controls render once the host supports routing, even before any agent has reported a catalog:
   * the auto toggle and saved policy work without one. Otherwise a loading catalog renders none.
   */
  phase: "loading" | "ready";
  catalog: "empty" | "incomplete" | "stale" | "loaded" | "loading" | "unsupported";
  capabilitySupported: boolean;
  capabilityReason: RoutingWaitOrRefusalCode | null;
  paused: { reason: RoutingWaitOrRefusalCode } | null;
  recovered: boolean;
}

/**
 * `visibleRecoveries` holds the wait ids whose recovery the current state is the first to show, so
 * "recovered" appears for one committed transition and then gives way to the normal state.
 */
export function describeSection(
  state: OmpAccountRoutingState,
  visibleRecoveries: ReadonlySet<string> = NO_RECOVERIES,
): SectionState {
  const paused = state.pausedRequests.find((request) => request.recoveredAt === null);
  return {
    phase:
      state.catalog.status === "loading" && state.capability.status !== "supported"
        ? "loading"
        : "ready",
    catalog: state.catalog.status,
    capabilitySupported: state.capability.status === "supported",
    capabilityReason: state.capability.reason,
    paused: paused ? { reason: paused.reason } : null,
    recovered:
      !paused &&
      state.pausedRequests.some(
        (request) => request.recoveredAt !== null && visibleRecoveries.has(request.waitId),
      ),
  };
}

/** Local date and time ("Oct 14, 7:00 AM"; the year only when it is not this one). */
export function formatTimestamp(ms: number, locale: string): string {
  const sameYear = new Date(ms).getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}

export interface Notice {
  id: string;
  /** i18n key under the shared `ompAccountRouting` namespace. */
  key: string;
  alert: boolean;
}

const notice = (id: string, key: string, alert = false): Notice => ({ id, key, alert });

/** Notices that come from the host's committed state. */
function stateNotices(
  state: OmpAccountRoutingState,
  hostSupportsFeature: boolean,
  recoveries: ReadonlySet<string>,
): Notice[] {
  const section = describeSection(state, recoveries);
  const notices: Notice[] = [];
  if (!hostSupportsFeature || !section.capabilitySupported || section.catalog === "unsupported") {
    notices.push(notice("unsupported", "ompAccountRouting.status.unsupported"));
    if (section.capabilityReason) {
      notices.push(
        notice("capabilityReason", `ompAccountRouting.reason.${section.capabilityReason}`),
      );
    }
  }
  if (section.paused) {
    notices.push(notice("paused", "ompAccountRouting.status.paused"));
    notices.push(notice("pausedReason", `ompAccountRouting.reason.${section.paused.reason}`));
  }
  if (section.recovered) notices.push(notice("recovered", "ompAccountRouting.status.recovered"));
  if (section.catalog === "incomplete") {
    notices.push(notice("incomplete", "ompAccountRouting.status.unknownUsage"));
  }
  if (section.catalog === "stale") notices.push(notice("stale", "ompAccountRouting.labels.stale"));
  return notices;
}

export interface NoticeInput {
  state: OmpAccountRoutingState | null;
  /** Wait ids whose recovery this state is the first to show. */
  recoveries: ReadonlySet<string>;
  featureOn: boolean;
  offline: boolean;
  readOnly: boolean;
  pending: boolean;
  conflict: boolean;
  error: string | null;
}

/** Every notice the section shows, in display order. Each is stated once. */
export function buildNotices(input: NoticeInput): Notice[] {
  const flags: Notice[] = [];
  if (input.offline) flags.push(notice("offline", "ompAccountRouting.status.offline"));
  if (input.readOnly) flags.push(notice("readOnly", "ompAccountRouting.status.readOnly"));
  if (input.pending) flags.push(notice("pending", "ompAccountRouting.status.pending"));
  if (input.conflict) {
    flags.push(notice("conflict", "ompAccountRouting.mutationError.conflict", true));
  }
  if (input.error) {
    flags.push(notice("error", `ompAccountRouting.mutationError.${input.error}`, true));
  }
  let fromState: Notice[] = [];
  if (input.state) fromState = stateNotices(input.state, input.featureOn, input.recoveries);
  else if (!input.featureOn)
    fromState = [notice("unsupported", "ompAccountRouting.status.unsupported")];
  const isSupportNotice = (n: Notice) => n.id === "unsupported" || n.id === "capabilityReason";
  // Support first, then connection and permission, then host-reported conditions.
  return [
    ...fromState.filter(isSupportNotice),
    ...flags,
    ...fromState.filter((n) => !isSupportNotice(n)),
  ];
}

export type AddAccountMode = "button" | "elsewhere" | "update" | "terminal";

/**
 * The sign-in link opens in the user's own browser, so only the desktop app on the host's
 * computer gets the button. Every other client is told where to go. A host that can sign in but
 * lacks the link flow asks for an update; a host that cannot sign in at all keeps the terminal
 * hint alone.
 */
export function addAccountMode(input: {
  featureOn: boolean;
  linkOn: boolean;
  canEdit: boolean;
  onHostComputer: boolean;
}): AddAccountMode {
  if (!input.featureOn) return "terminal";
  if (!input.linkOn) return "update";
  return input.canEdit && input.onHostComputer ? "button" : "elsewhere";
}
