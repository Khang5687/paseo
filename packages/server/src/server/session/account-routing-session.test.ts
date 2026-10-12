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

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { withAuthority?: boolean; modern?: boolean } = {}) {
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
