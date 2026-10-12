import type pino from "pino";
import type { OmpAccountRoutingState } from "@getpaseo/protocol/messages";
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

export interface AccountRoutingSessionOptions {
  /** Absent when the policy file was unreadable: host routing is off and requests fail typed. */
  authority?: Pick<AccountRoutingAuthority, "observe" | "mutate" | "snapshot">;
  /** Absent unless the host can sign accounts in (macOS with account routing). */
  login?: Pick<OmpAccountLogin, "start" | "status" | "cancel">;
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
    const { login, emit } = this.options;
    if (!login) return this.loginUnavailable(msg);
    const { status, error } = login.start();
    emit({
      type: "account.routing.login.start.response",
      payload: { requestId: msg.requestId, status, error },
    });
  }

  async handleLoginStatus(msg: LoginStatus): Promise<void> {
    const { login, emit } = this.options;
    if (!login) return this.loginUnavailable(msg);
    emit({
      type: "account.routing.login.get_status.response",
      payload: { requestId: msg.requestId, status: login.status(), error: null },
    });
  }

  async handleLoginCancel(msg: LoginCancel): Promise<void> {
    const { login, emit } = this.options;
    if (!login) return this.loginUnavailable(msg);
    emit({
      type: "account.routing.login.cancel.response",
      payload: { requestId: msg.requestId, status: login.cancel(), error: null },
    });
  }

  private loginUnavailable(msg: LoginStart | LoginStatus | LoginCancel): void {
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
