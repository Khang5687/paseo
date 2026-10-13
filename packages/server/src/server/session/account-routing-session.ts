import type pino from "pino";
import type { OmpAccountLoginStatus, OmpAccountRoutingState } from "@getpaseo/protocol/messages";
import type { AccountRoutingAuthority } from "../account-routing/authority.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { SessionDelivery } from "./owned-subscriptions/index.js";
import type { OmpAccountLogin } from "../account-routing/login.js";

type GetState = Extract<SessionInboundMessage, { type: "account.routing.get_state.request" }>;
type Mutate = Extract<SessionInboundMessage, { type: "account.routing.mutate.request" }>;
type LoginStart = Extract<SessionInboundMessage, { type: "account.routing.login.start.request" }>;
type LoginStatus = Extract<
  SessionInboundMessage,
  { type: "account.routing.login.get_status.request" }
>;
type LoginCancel = Extract<SessionInboundMessage, { type: "account.routing.login.cancel.request" }>;
type LoginSubmit = Extract<
  SessionInboundMessage,
  { type: "account.routing.login.submit_code.request" }
>;
type LoginRequest = LoginStart | LoginStatus | LoginCancel | LoginSubmit;

export interface AccountRoutingSessionOptions {
  /** Absent when the policy file was unreadable: host routing is off and requests fail typed. */
  authority?: Pick<AccountRoutingAuthority, "observe" | "mutate" | "snapshot">;
  /** Absent unless the host can sign accounts in (macOS with account routing). */
  login?: Pick<OmpAccountLogin, "start" | "status" | "cancel" | "submitCode">;
  /**
   * True for a direct loopback or local IPC connection: the host's own app. Only such a source
   * sees the sign-in link and may submit a code (plan D12 amendment). Absent means none is.
   */
  isHostLocal?: (source: object | undefined) => boolean;
  delivery: Pick<SessionDelivery, "begin" | "isModern" | "currentSource">;
  emit(message: SessionOutboundMessage): void;
  logger: pino.Logger;
}

/**
 * Wire face of the one host routing authority. Permissions are enforced by the operation registry
 * before dispatch; this class only translates requests, so it holds no policy.
 */
export class AccountRoutingSession {
  constructor(private readonly options: AccountRoutingSessionOptions) {}

  async handleGetState(msg: GetState): Promise<void> {
    const { authority, delivery, emit } = this.options;
    if (!authority) return this.unavailable(msg);
    // A source without owned subscriptions never gets a stream, only the snapshot.
    if (!msg.subscribe || !delivery.isModern(delivery.currentSource)) {
      emit({
        type: "account.routing.get_state.response",
        payload: { requestId: msg.requestId, state: authority.snapshot() },
      });
      return;
    }

    let release: (() => void) | undefined;
    const owner = delivery.begin("account-routing", undefined, () => release?.());
    let ready = false;
    let pending: OmpAccountRoutingState | null = null;
    const push = (state: OmpAccountRoutingState) =>
      owner.emit({
        type: "account.routing.state.update",
        payload: { subscriptionId: owner.responseId, state },
      });
    try {
      // Updates that land between the snapshot and the response wait for the response.
      const observed = await authority.observe((state) => {
        if (owner.signal.aborted) return;
        if (ready) push(state);
        else pending = state;
      });
      release = observed.release;
      if (owner.signal.aborted) {
        release();
        return;
      }
      emit({
        type: "account.routing.get_state.response",
        payload: {
          requestId: msg.requestId,
          state: observed.state,
          subscriptionId: owner.responseId,
        },
      });
      ready = true;
      const held = pending as OmpAccountRoutingState | null;
      if (held && held.stateSequence > observed.state.stateSequence) push(held);
    } catch (error) {
      await owner.release();
      this.failed(msg, error);
    }
  }

  async handleMutate(msg: Mutate): Promise<void> {
    const { authority, emit } = this.options;
    if (!authority) return this.unavailable(msg);
    try {
      const result = await authority.mutate({
        expectedPolicyRevision: msg.expectedPolicyRevision,
        command: msg.command,
      });
      emit({
        type: "account.routing.mutate.response",
        payload: { requestId: msg.requestId, ...result },
      });
    } catch (error) {
      this.failed(msg, error);
    }
  }

  async handleLoginStart(msg: LoginStart): Promise<void> {
    const { login, authority, emit } = this.options;
    if (!login) return this.loginUnavailable(msg);
    const replace = msg.mode === "replace" ? msg.replaceAccount : undefined;
    if (
      msg.mode === "replace" &&
      !(
        replace &&
        authority
          ?.snapshot()
          .accounts.some(
            (a) =>
              a.ref.storeNamespace === replace.storeNamespace &&
              a.ref.nativeRowId === replace.nativeRowId,
          )
      )
    ) {
      emit({
        type: "account.routing.login.start.response",
        payload: {
          requestId: msg.requestId,
          status: this.visible(login.status()),
          error: "invalid_replace_target",
        },
      });
      return;
    }
    const { status, error } = login.start(replace ? { replace } : {});
    emit({
      type: "account.routing.login.start.response",
      payload: { requestId: msg.requestId, status: this.visible(status), error },
    });
  }

  async handleLoginStatus(msg: LoginStatus): Promise<void> {
    const { login, emit } = this.options;
    if (!login) return this.loginUnavailable(msg);
    emit({
      type: "account.routing.login.get_status.response",
      payload: { requestId: msg.requestId, status: this.visible(login.status()), error: null },
    });
  }

  async handleLoginCancel(msg: LoginCancel): Promise<void> {
    const { login, emit } = this.options;
    if (!login) return this.loginUnavailable(msg);
    emit({
      type: "account.routing.login.cancel.response",
      payload: { requestId: msg.requestId, status: this.visible(login.cancel()), error: null },
    });
  }

  /** The pasted text goes to the login and nowhere else: no log line, no error, no status. */
  async handleLoginSubmitCode(msg: LoginSubmit): Promise<void> {
    const { login, emit } = this.options;
    if (!login) return this.loginUnavailable(msg);
    const error = this.hostLocal() ? login.submitCode(msg.input) : "not_allowed";
    emit({
      type: "account.routing.login.submit_code.response",
      payload: { requestId: msg.requestId, status: this.visible(login.status()), error },
    });
  }

  private hostLocal(): boolean {
    return this.options.isHostLocal?.(this.options.delivery.currentSource) === true;
  }

  /** Drops the sign-in link for every connection that is not the host's own app. */
  private visible(status: OmpAccountLoginStatus): OmpAccountLoginStatus {
    if (status.authorizeUrl === undefined || this.hostLocal()) return status;
    const { authorizeUrl: _hidden, ...rest } = status;
    return rest;
  }

  private loginUnavailable(msg: LoginRequest): void {
    this.options.emit({
      type: "rpc_error",
      payload: {
        requestId: msg.requestId,
        requestType: msg.type,
        error: "Adding an account is unavailable on this host",
        code: "account_login_unavailable",
      },
    });
  }

  private unavailable(msg: GetState | Mutate): void {
    this.options.emit({
      type: "rpc_error",
      payload: {
        requestId: msg.requestId,
        requestType: msg.type,
        error: "Account routing is unavailable on this host",
        code: "account_routing_unavailable",
      },
    });
  }

  private failed(msg: GetState | Mutate, error: unknown): void {
    this.options.logger.error({ err: error }, "Account routing request failed");
    this.options.emit({
      type: "rpc_error",
      payload: {
        requestId: msg.requestId,
        requestType: msg.type,
        error: "Account routing request failed",
        code: "account_routing_failed",
      },
    });
  }
}
