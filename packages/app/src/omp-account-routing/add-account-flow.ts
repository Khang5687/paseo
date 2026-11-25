import type { OmpAccountRoutingState, OmpRoutingAccountRef } from "@getpaseo/protocol/messages";
import type { LoginFailure, LoginSnapshot, PasteError } from "./queries";
import { sameRef } from "./presentation";

/** Where the Add Claude account sheet is. Derived from the host's login, never stored. */
export type AddAccountStep = "warning" | "preparing" | "link" | "verifying" | "result";

export type AddAccountResultKind = "added" | "replaced" | "alreadyListed" | "failed" | "cancelled";

export type BillingNote = "enabled" | "unknown" | null;

export interface AddAccountResult {
  kind: AddAccountResultKind;
  /** Email-like label OMP reported; null when the host sent none. */
  label: string | null;
  organization: string | null;
  /** Copy key suffix under `ompAccountRouting.login.failure`; only for `failed`. */
  failure: Exclude<LoginFailure, "paste_code_unsupported" | "browser_open_failed"> | null;
  /** Only for `added`. */
  billing: BillingNote;
}

export interface AddAccountView {
  step: AddAccountStep;
  /** Accounts the catalog already lists, for the warning step. */
  existingLabels: string[];
  authorizeUrl: string | null;
  /** The paste field may be shown (OMP's prompt is open). */
  canPaste: boolean;
  pasteOpen: boolean;
  pasteText: string;
  canSubmit: boolean;
  submitting: boolean;
  pasteError: PasteError | null;
  result: AddAccountResult | null;
}

/** What only this sheet knows; everything else comes from the host. */
interface FlowLocal {
  pasteOpen: boolean;
  pasteText: string;
}

/** The two retired failures are never sent by this daemon; they read as a generic OMP failure. */
function failureKey(failure: LoginFailure | null): AddAccountResult["failure"] {
  if (
    failure === null ||
    failure === "paste_code_unsupported" ||
    failure === "browser_open_failed"
  ) {
    return "omp_failed";
  }
  return failure;
}

/** Paid extra usage on the account turns auto-routing off for it; say so unless it is known off. */
export function billingNote(
  ref: OmpRoutingAccountRef | undefined,
  accounts: OmpAccountRoutingState["accounts"],
): BillingNote {
  const state = ref ? accounts.find((account) => sameRef(account.ref, ref))?.billing.state : null;
  if (state === "enabled") return "enabled";
  return state === "disabled" ? null : "unknown";
}

function describeResult(
  login: LoginSnapshot,
  accounts: OmpAccountRoutingState["accounts"],
): AddAccountResult {
  const { outcome } = login;
  const base = {
    label: outcome?.label ?? null,
    organization: outcome?.organizationLabel ?? null,
    failure: null,
    billing: null,
  };
  if (outcome?.kind === "already_listed") return { ...base, kind: "alreadyListed" };
  if (login.phase === "cancelled") return { ...base, kind: "cancelled" };
  if (login.phase === "failed") {
    return { ...base, kind: "failed", failure: failureKey(login.failure) };
  }
  if (outcome?.kind === "replaced") return { ...base, kind: "replaced" };
  return { ...base, kind: "added", billing: billingNote(outcome?.ref, accounts) };
}

function stepFor(login: LoginSnapshot): AddAccountStep {
  switch (login.phase) {
    case "idle":
      return "warning";
    case "starting":
      return "preparing";
    case "running":
      if (login.step === "awaiting_browser" && login.authorizeUrl) return "link";
      return login.step === "verifying" ? "verifying" : "preparing";
    default:
      return "result";
  }
}

/** Pure: the sheet's content from the host's login, the catalog, and the sheet's own input. */
export function describeAddAccount(
  login: LoginSnapshot,
  accounts: OmpAccountRoutingState["accounts"],
  local: FlowLocal,
): AddAccountView {
  const step = stepFor(login);
  const canPaste = step === "link" && login.pasteAccepted;
  return {
    step,
    existingLabels: [...new Set(accounts.map((account) => account.label))],
    authorizeUrl: step === "link" ? login.authorizeUrl : null,
    canPaste,
    pasteOpen: canPaste && local.pasteOpen,
    pasteText: local.pasteText,
    canSubmit: canPaste && !login.submitting && local.pasteText.trim().length > 0,
    submitting: login.submitting,
    pasteError: login.pasteError,
    result: step === "result" ? describeResult(login, accounts) : null,
  };
}

/**
 * The sheet's own input: whether the paste field is open and what is typed in it. Plain
 * TypeScript per docs/forms.md; `useSyncExternalStore` in the sheet gives it a lifetime, and
 * `reset` runs on every open so one open never inherits another's text.
 */
export class AddAccountFlow {
  private local: FlowLocal = { pasteOpen: false, pasteText: "" };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): FlowLocal => this.local;

  reset(): void {
    this.set({ pasteOpen: false, pasteText: "" });
  }

  openPaste(): void {
    this.set({ pasteOpen: true });
  }

  setPasteText(text: string): void {
    this.set({ pasteText: text });
  }

  private set(patch: Partial<FlowLocal>): void {
    this.local = { ...this.local, ...patch };
    for (const listener of this.listeners) listener();
  }
}
