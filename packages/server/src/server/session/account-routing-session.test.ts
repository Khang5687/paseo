import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import { AccountRoutingAuthority } from "../account-routing/authority.js";
import { AccountRoutingStore } from "../account-routing/store.js";
import type { SessionOutboundMessage } from "../messages.js";
import { AccountRoutingSession } from "./account-routing-session.js";
import { SessionDelivery } from "./owned-subscriptions/index.js";
import type { OmpAccountLogin } from "../account-routing/login.js";

type LoginPort = Pick<OmpAccountLogin, "start" | "status" | "cancel" | "submitCode">;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(
  options: {
    withAuthority?: boolean;
    modern?: boolean;
    login?: LoginPort;
    hostLocal?: boolean;
  } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-routing-session-"));
  dirs.push(dir);
  const authority =
    options.withAuthority === false
      ? undefined
      : new AccountRoutingAuthority({
          store: AccountRoutingStore.open(path.join(dir, "account-routing.json")),
        });
  const sent: SessionOutboundMessage[] = [];
  const delivery = new SessionDelivery((_source, message) => sent.push(message));
  const source = {};
  delivery.attach(source, options.modern ?? true);
  const session = new AccountRoutingSession({
    authority,
    login: options.login,
    isHostLocal: (candidate) => candidate === source && options.hostLocal === true,
    delivery,
    emit: (message) => delivery.reply(message),
    logger: pino({ level: "silent" }),
  });
  return { authority, delivery, source, session, sent };
}

test("subscribing answers with a host-assigned id and then streams committed state under it", async () => {
  const { authority, delivery, source, session, sent } = setup();
  const request = {
    type: "account.routing.get_state.request" as const,
    requestId: "r1",
    subscribe: {},
  };
  await delivery.request(source, request, () => session.handleGetState(request));
  const response = sent[0];
  if (response?.type !== "account.routing.get_state.response") throw new Error("no response");
  const subscriptionId = response.payload.subscriptionId!;
  expect(subscriptionId).toEqual(expect.any(String));
  expect(delivery.hasDemand("account-routing")).toBe(true);

  const revision = response.payload.state.policy.policyRevision;
  await authority!.mutate({
    expectedPolicyRevision: revision,
    command: { kind: "set_auto", enabled: false },
  });
  await expect
    .poll(() => sent.filter((m) => m.type === "account.routing.state.update"))
    .toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          subscriptionId,
          state: expect.objectContaining({
            policy: expect.objectContaining({ autoEnabled: false }),
          }),
        }),
      }),
    ]);

  // Disconnect releases the observer: later commits reach nobody.
  await delivery.detach(source);
  const before = sent.length;
  await authority!.mutate({
    expectedPolicyRevision: revision + 1,
    command: { kind: "set_auto", enabled: true },
  });
  await Promise.resolve();
  expect(sent.length).toBe(before);
});

test("a source without owned subscriptions gets a snapshot and never a stream", async () => {
  const { authority, delivery, source, session, sent } = setup({ modern: false });
  const request = {
    type: "account.routing.get_state.request" as const,
    requestId: "r1",
    subscribe: {},
  };
  await delivery.request(source, request, () => session.handleGetState(request));
  expect(sent).toEqual([
    expect.objectContaining({
      type: "account.routing.get_state.response",
      payload: expect.not.objectContaining({ subscriptionId: expect.anything() }),
    }),
  ]);
  expect(delivery.hasDemand("account-routing")).toBe(false);
  await authority!.mutate({
    expectedPolicyRevision: 0,
    command: { kind: "set_auto", enabled: false },
  });
  await Promise.resolve();
  expect(sent.length).toBe(1);
});

test("mutations carry the request id and report typed conflicts without throwing", async () => {
  const { delivery, source, session, sent } = setup();
  const stale = {
    type: "account.routing.mutate.request" as const,
    requestId: "m1",
    expectedPolicyRevision: 41,
    command: { kind: "set_auto" as const, enabled: false },
  };
  await delivery.request(source, stale, () => session.handleMutate(stale));
  expect(sent).toEqual([
    expect.objectContaining({
      type: "account.routing.mutate.response",
      payload: expect.objectContaining({
        requestId: "m1",
        error: expect.objectContaining({ code: "conflict" }),
      }),
    }),
  ]);
});

test("a host without an authority answers with a correlated rpc_error", async () => {
  const { delivery, source, session, sent } = setup({ withAuthority: false });
  const request = { type: "account.routing.get_state.request" as const, requestId: "r9" };
  await delivery.request(source, request, () => session.handleGetState(request));
  expect(sent).toEqual([
    {
      type: "rpc_error",
      payload: expect.objectContaining({
        requestId: "r9",
        requestType: "account.routing.get_state.request",
        code: "account_routing_unavailable",
      }),
    },
  ]);
});

test("login start, status, and cancel answer with the host login's status", async () => {
  const running = { state: "running" as const, startedAt: 1 };
  const calls: string[] = [];
  const login: LoginPort = {
    start: () => (calls.push("start"), { status: running, error: null }),
    status: () => (calls.push("status"), running),
    cancel: () => (calls.push("cancel"), { state: "cancelled" as const }),
    submitCode: () => null,
  };
  const { delivery, source, session, sent } = setup({ login });
  const a = { type: "account.routing.login.start.request" as const, requestId: "a" };
  const b = { type: "account.routing.login.get_status.request" as const, requestId: "b" };
  const c = { type: "account.routing.login.cancel.request" as const, requestId: "c" };
  await delivery.request(source, a, () => session.handleLoginStart(a));
  await delivery.request(source, b, () => session.handleLoginStatus(b));
  await delivery.request(source, c, () => session.handleLoginCancel(c));
  expect(calls).toEqual(["start", "status", "cancel"]);
  expect(sent).toEqual([
    {
      type: "account.routing.login.start.response",
      payload: { requestId: "a", status: running, error: null },
    },
    {
      type: "account.routing.login.get_status.response",
      payload: { requestId: "b", status: running, error: null },
    },
    {
      type: "account.routing.login.cancel.response",
      payload: { requestId: "c", status: { state: "cancelled" }, error: null },
    },
  ]);
});

test("a refused concurrent start carries already_running", async () => {
  const login: LoginPort = {
    start: () => ({ status: { state: "running" }, error: "already_running" }),
    status: () => ({ state: "running" }),
    cancel: () => ({ state: "cancelled" }),
    submitCode: () => null,
  };
  const { delivery, source, session, sent } = setup({ login });
  const a = { type: "account.routing.login.start.request" as const, requestId: "a" };
  await delivery.request(source, a, () => session.handleLoginStart(a));
  expect(sent[0]).toMatchObject({ payload: { error: "already_running" } });
});

test("a host without login answers with a correlated rpc_error", async () => {
  const { delivery, source, session, sent } = setup();
  const z = { type: "account.routing.login.start.request" as const, requestId: "z" };
  await delivery.request(source, z, () => session.handleLoginStart(z));
  expect(sent).toEqual([
    {
      type: "rpc_error",
      payload: expect.objectContaining({
        requestId: "z",
        requestType: "account.routing.login.start.request",
        code: "account_login_unavailable",
      }),
    },
  ]);
});

const LINK = "https://claude.ai/oauth/authorize?state=s";
function linkLogin() {
  const submitted: string[] = [];
  const starts: unknown[] = [];
  const status = {
    state: "running" as const,
    phase: "awaiting_browser" as const,
    authorizeUrl: LINK,
  };
  const login: LoginPort = {
    start: (options) => (starts.push(options), { status, error: null }),
    status: () => status,
    cancel: () => ({ state: "cancelled" }),
    submitCode: (input) => (submitted.push(input), null),
  };
  return { login, submitted, starts };
}

test("only the host's own app sees the sign-in link", async () => {
  for (const hostLocal of [true, false]) {
    const { login } = linkLogin();
    const { delivery, source, session, sent } = setup({ login, hostLocal });
    const a = { type: "account.routing.login.start.request" as const, requestId: "a" };
    const b = { type: "account.routing.login.get_status.request" as const, requestId: "b" };
    const c = {
      type: "account.routing.login.submit_code.request" as const,
      requestId: "c",
      input: "x",
    };
    await delivery.request(source, a, () => session.handleLoginStart(a));
    await delivery.request(source, b, () => session.handleLoginStatus(b));
    await delivery.request(source, c, () => session.handleLoginSubmitCode(c));
    for (const message of sent) {
      expect(message).toMatchObject({ payload: { status: { state: "running" } } });
      expect(JSON.stringify(message).includes("claude.ai")).toBe(hostLocal);
    }
  }
});

test("submit_code is refused for any connection but the host's own app", async () => {
  const remote = linkLogin();
  const r = setup({ login: remote.login, hostLocal: false });
  const msg = {
    type: "account.routing.login.submit_code.request" as const,
    requestId: "c",
    input: "SECRETCODE#s",
  };
  await r.delivery.request(r.source, msg, () => r.session.handleLoginSubmitCode(msg));
  expect(remote.submitted).toEqual([]);
  expect(r.sent[0]).toMatchObject({
    type: "account.routing.login.submit_code.response",
    payload: { requestId: "c", error: "not_allowed" },
  });

  const local = linkLogin();
  const l = setup({ login: local.login, hostLocal: true });
  await l.delivery.request(l.source, msg, () => l.session.handleLoginSubmitCode(msg));
  expect(local.submitted).toEqual(["SECRETCODE#s"]);
  expect(l.sent[0]).toMatchObject({ payload: { requestId: "c", error: null } });
  expect(JSON.stringify(l.sent)).not.toContain("SECRETCODE");
});

test("replace mode needs a listed account and passes only that target to the login", async () => {
  const { login, starts } = linkLogin();
  const { authority, delivery, source, session, sent } = setup({ login, hostLocal: true });
  const listed = { storeNamespace: "11111111-1111-4111-8111-111111111111", nativeRowId: 7 };
  const send = (requestId: string, extra: object) => {
    const msg = { type: "account.routing.login.start.request" as const, requestId, ...extra };
    return delivery.request(source, msg, () => session.handleLoginStart(msg));
  };
  await send("a", { mode: "replace" });
  await send("b", { mode: "replace", replaceAccount: listed });
  expect(starts).toEqual([]);
  expect(sent.map((m) => (m.payload as { error?: unknown }).error)).toEqual([
    "invalid_replace_target",
    "invalid_replace_target",
  ]);

  authority!.addSignedInAccount(listed);
  await send("c", { mode: "replace", replaceAccount: listed });
  await send("d", { mode: "add", replaceAccount: listed });
  await send("e", {});
  expect(starts).toEqual([{ replace: listed }, {}, {}]);
});
