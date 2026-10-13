import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import type { OmpAccountLoginStatus, OmpRoutingAccountRef } from "@getpaseo/protocol/messages";
import type { OmpRuntime, OmpRuntimeSession } from "../agent/providers/omp/runtime.js";
import type {
  OmpLoginExisting,
  OmpLoginResult,
  OmpLogoutAccount,
  OmpRuntimeEvent,
} from "../agent/providers/omp/rpc-types.js";
import { createConfiguredOmpRuntime } from "./listing.js";
import type { ProviderRuntimeSettings } from "../agent/provider-launch-config.js";
import type { AccountRoutingAuthority } from "./authority.js";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const PROVIDER_ID = "anthropic";
const MAX_INPUT_LENGTH = 4096;

type Failure = NonNullable<OmpAccountLoginStatus["failure"]>;
type Outcome = NonNullable<OmpAccountLoginStatus["outcome"]>;
export type SubmitCodeError = "not_waiting" | "invalid_input" | "wrong_login";

export interface OmpAccountLoginOptions {
  runtime: OmpRuntime;
  logger: Logger;
  /** Resolves the new row's ref and lists it in the routing policy at once. */
  accounts?: Pick<AccountRoutingAuthority, "refForSignedInRow" | "addSignedInAccount"> &
    Partial<Pick<AccountRoutingAuthority, "publishListing">>;
  timeoutMs?: number;
}

/** What one run needs beyond its status: the open paste prompt and the link's `state`. */
interface Run {
  status: OmpAccountLoginStatus;
  session?: OmpRuntimeSession;
  inputId?: string;
  expectedState?: string;
}

/**
 * One host-side Claude sign-in at a time. A short-lived plain `omp --mode rpc` runs OMP's own
 * `login` with the add-only guard: OMP serves the loopback callback, writes the credential into its
 * native store, and refuses to overwrite a stored account unless told which one. This class shows
 * the sign-in link, forwards a pasted redirect address, and reports which row the login wrote.
 * The link, pasted text, codes and tokens never reach a log line, and OMP's error text is dropped
 * for the same reason. Who may see the link is the session's decision.
 */
export class OmpAccountLogin {
  private run: Run = { status: { state: "idle" } };
  private teardown: (() => void) | null = null;
  private guard = false;
  private readonly guardListeners = new Set<() => void>();

  constructor(private readonly options: OmpAccountLoginOptions) {}

  status(): OmpAccountLoginStatus {
    return { ...this.run.status };
  }

  /** The probed OMP has the add-only guard, so the link flow may be offered. */
  get linkSupported(): boolean {
    return this.guard;
  }

  setLinkSupported(supported: boolean): void {
    if (supported === this.guard) return;
    this.guard = supported;
    for (const listener of this.guardListeners) listener();
  }

  onLinkSupportChange(listener: () => void): () => void {
    this.guardListeners.add(listener);
    return () => void this.guardListeners.delete(listener);
  }

  /** `replace` names the only stored account this sign-in may overwrite; absent is add-only. */
  start(options: { replace?: OmpRoutingAccountRef } = {}): {
    status: OmpAccountLoginStatus;
    error: "already_running" | null;
  } {
    if (this.run.status.state === "running")
      return { status: this.status(), error: "already_running" };
    const run: Run = { status: { state: "running", phase: "preparing", startedAt: Date.now() } };
    this.run = run;
    const existing: OmpLoginExisting = options.replace
      ? { replaceRowId: options.replace.nativeRowId }
      : "refuse";
    void this.execute(run, existing, options.replace);
    return { status: this.status(), error: null };
  }

  /** Answers OMP's open paste prompt. Only a parsed code with a matching `state` reaches OMP. */
  submitCode(input: string): SubmitCodeError | null {
    const run = this.run;
    if (run.status.state !== "running" || !run.inputId || !run.session) return "not_waiting";
    const parsed = parseCallbackInput(input);
    if (!parsed) return "invalid_input";
    if (parsed.state && run.expectedState && parsed.state !== run.expectedState)
      return "wrong_login";
    run.session.respondToExtensionUiRequest(run.inputId, {
      value: parsed.state ? `${parsed.code}#${parsed.state}` : parsed.code,
    });
    run.inputId = undefined;
    this.update(run, { phase: "verifying", authorizeUrl: undefined, pasteAccepted: undefined });
    return null;
  }

  cancel(): OmpAccountLoginStatus {
    this.settle(this.run, { state: "cancelled" });
    return this.status();
  }

  dispose(): void {
    this.cancel();
    this.guardListeners.clear();
  }

  private update(run: Run, patch: Partial<OmpAccountLoginStatus>): void {
    if (this.run !== run || run.status.state !== "running") return;
    const next = { ...run.status, ...patch };
    for (const key of Object.keys(patch) as Array<keyof OmpAccountLoginStatus>) {
      if (patch[key] === undefined) delete next[key];
    }
    run.status = next;
  }

  /** Records the outcome of `run` once and stops its process. A stale run cannot change a newer one. */
  private settle(
    run: Run,
    end: { state: "succeeded" | "cancelled" | "failed"; failure?: Failure; outcome?: Outcome },
  ): void {
    if (this.run !== run || run.status.state !== "running") return;
    run.status = { ...end, startedAt: run.status.startedAt, endedAt: Date.now() };
    run.inputId = undefined;
    this.teardown?.();
    this.teardown = null;
    this.options.logger.info(
      { state: end.state, failure: end.failure, outcome: end.outcome?.kind },
      "OMP account login ended",
    );
  }

  private async execute(
    run: Run,
    existing: OmpLoginExisting,
    replace: OmpRoutingAccountRef | undefined,
  ): Promise<void> {
    const { runtime } = this.options;
    let cwd: string | undefined;
    const timer = setTimeout(
      () => this.settle(run, { state: "failed", failure: "timeout" }),
      this.options.timeoutMs ?? LOGIN_TIMEOUT_MS,
    );
    const cleanup = () => {
      clearTimeout(timer);
      void run.session?.close().catch(() => undefined);
      if (cwd) void rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    };
    this.teardown = cleanup;

    const onEvent = (event: OmpRuntimeEvent) => {
      if (event.type !== "extension_ui_request") return;
      if (event.method === "open_url") {
        const url = parseHttpsUrl(event.url);
        if (!url) return this.settle(run, { state: "failed", failure: "omp_failed" });
        run.expectedState = url.searchParams.get("state") ?? undefined;
        this.update(run, { phase: "awaiting_browser", authorizeUrl: url.href });
      } else if (event.method === "input") {
        // OMP races its loopback callback against this paste prompt from the start. Keep it open:
        // cancelling makes OMP ask again, and only `submitCode` may answer it.
        run.inputId = event.id;
        this.update(run, { pasteAccepted: true });
      } else if (event.method === "cancel") {
        if (event.targetId !== run.inputId) return;
        run.inputId = undefined;
        this.update(run, { pasteAccepted: undefined });
      } else if (event.method === "notify") {
        if (event.message?.startsWith("Exchanging authorization code"))
          this.update(run, { phase: "verifying", authorizeUrl: undefined });
      } else if (["select", "confirm", "editor"].includes(event.method)) {
        run.session?.cancelExtensionUiRequest(event.id);
      }
    };

    let result: OmpLoginResult;
    let before: OmpLogoutAccount[] | null = null;
    try {
      cwd = await mkdtemp(path.join(tmpdir(), "paseo-omp-login-"));
      const session = await runtime.startSession({ cwd, protocolMode: "rpc", noSession: true });
      run.session = session;
      if (this.run !== run || run.status.state !== "running") return cleanup();
      session.onEvent(onEvent);
      before = await listAccounts(session);
      result = await session.login(PROVIDER_ID, { existing });
    } catch {
      this.settle(run, { state: "failed", failure: run.session ? "omp_failed" : "spawn_failed" });
      cleanup();
      return;
    }
    try {
      const after = run.status.state === "running" ? await listAccounts(run.session) : null;
      // The store listing this child just read also feeds the account list, so the new row shows
      // by name with no agent running. Read-only, like the listing itself.
      if (after) {
        this.options.accounts?.publishListing?.(
          "login",
          oauthRows(after).map((a) => ({ nativeRowId: a.credentialId, label: a.label })),
        );
      }
      const outcome = this.outcomeOf(result, before, after, replace);
      if (result.kind === "credential_exists") {
        this.settle(run, { state: "failed", failure: "omp_failed", outcome });
      } else {
        // OMP wrote the row even if the user cancelled meanwhile, so it is listed either way.
        if (outcome?.kind === "added" && outcome.ref)
          this.options.accounts?.addSignedInAccount(outcome.ref);
        this.settle(run, { state: "succeeded", ...(outcome ? { outcome } : {}) });
      }
    } finally {
      cleanup();
    }
  }

  /**
   * OMP's own report wins. An OMP without it gets the outcome from the store listing before and
   * after the login: a new oauth row is `added`; no new row means a stored row was overwritten.
   */
  private outcomeOf(
    result: OmpLoginResult,
    before: OmpLogoutAccount[] | null,
    after: OmpLogoutAccount[] | null,
    replace: OmpRoutingAccountRef | undefined,
  ): Outcome | undefined {
    const listed = (rowId: number | undefined) =>
      rowId === undefined ? undefined : after?.find((a) => a.credentialId === rowId);
    const describe = (
      kind: Outcome["kind"],
      rowId: number | undefined,
      email?: string,
      org?: string,
    ) => {
      const label =
        email ?? listed(rowId)?.label ?? before?.find((a) => a.credentialId === rowId)?.label;
      const ref = rowId === undefined ? null : this.options.accounts?.refForSignedInRow(rowId);
      return {
        kind,
        ...(label ? { label } : {}),
        ...(org ? { organizationLabel: org } : {}),
        ...(ref ? { ref } : {}),
      };
    };
    if (result.kind === "credential_exists")
      return describe("already_listed", result.rowId, result.email, result.orgName);
    if (result.outcome) return describe(result.outcome, result.rowId, result.email, result.orgName);
    if (!before || !after) return undefined;
    const known = new Set(oauthRows(before).map((a) => a.credentialId));
    const added = oauthRows(after).filter((a) => !known.has(a.credentialId));
    if (added.length === 1) return describe("added", added[0].credentialId);
    if (added.length > 1) return undefined;
    return describe("replaced", replace?.nativeRowId);
  }
}

const oauthRows = (accounts: OmpLogoutAccount[]) => accounts.filter((a) => a.type === "oauth");

/** The store listing, or null when this OMP cannot list it; the login goes on either way. */
async function listAccounts(session: OmpRuntimeSession | undefined) {
  try {
    return session ? await session.getLogoutAccounts(PROVIDER_ID) : null;
  } catch {
    return null;
  }
}

function parseHttpsUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Same forms OMP accepts: a redirect URL, a `code=…&state=…` query, or `code#state`. */
export function parseCallbackInput(input: string): { code: string; state?: string } | null {
  const value = input.trim();
  if (!value || value.length > MAX_INPUT_LENGTH) return null;
  let code: string | null | undefined;
  let state: string | null | undefined;
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    // not a URL
  }
  if (url) {
    code = url.searchParams.get("code");
    state = url.searchParams.get("state");
  } else if (value.includes("code=")) {
    const params = new URLSearchParams(value.replace(/^[?#]/, ""));
    code = params.get("code");
    state = params.get("state");
  } else {
    [code, state] = value.split("#", 2);
  }
  if (!code || /\s/.test(code) || (state && /\s/.test(state))) return null;
  return state ? { code, state } : { code };
}

/** The macOS host login, or undefined elsewhere. `runtimeSettings` is read at each start. */
export function createMacAccountLogin(input: {
  logger: Logger;
  runtimeSettings: () => ProviderRuntimeSettings | undefined;
  accounts?: OmpAccountLoginOptions["accounts"];
}): OmpAccountLogin | undefined {
  if (process.platform !== "darwin") return undefined;
  return new OmpAccountLogin({
    runtime: createConfiguredOmpRuntime(input.logger, input.runtimeSettings),
    accounts: input.accounts,
    logger: input.logger.child({ module: "omp-account-login" }),
  });
}
