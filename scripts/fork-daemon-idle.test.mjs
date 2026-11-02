import assert from "node:assert/strict";
import { test } from "node:test";
import { busyReasons } from "./fork-daemon-idle.mjs";

function agent(overrides = {}) {
  return {
    id: "agent-0001-aaaa",
    title: "Fixer",
    status: "idle",
    pendingPermissions: [],
    queuedMessages: [],
    ...overrides,
  };
}

const empty = { agents: [], workspaces: [], schedules: [] };

test("agents waiting for a person keep the daemon idle", () => {
  const state = {
    ...empty,
    agents: [
      agent({ status: "idle", requiresAttention: true, attentionReason: "finished" }),
      agent({ status: "error", requiresAttention: true, attentionReason: "error" }),
      agent({ status: "closed" }),
    ],
    workspaces: [{ id: "w1", name: "main" }, { id: "w2", runningSubagentCount: 0 }],
    schedules: [{ id: "s1", runs: [{ status: "succeeded" }, { status: "failed" }] }],
  };
  assert.deepEqual(busyReasons(state), []);
});

test("a running or initializing agent is busy", () => {
  assert.deepEqual(busyReasons({ ...empty, agents: [agent({ status: "running" })] }), [
    "agent Fixer is running",
  ]);
  assert.deepEqual(
    busyReasons({ ...empty, agents: [agent({ status: "initializing", title: null })] }),
    ["agent agent-00 is initializing"],
  );
});

test("a pending permission is busy even when the agent is idle", () => {
  const state = { ...empty, agents: [agent({ pendingPermissions: [{ id: "p1" }] })] };
  assert.deepEqual(busyReasons(state), ["agent Fixer waits on 1 permission request(s)"]);
});

test("an unpaused queue on an idle agent is about to drain", () => {
  const queued = [{ id: "q1" }, { id: "q2" }];
  assert.deepEqual(busyReasons({ ...empty, agents: [agent({ queuedMessages: queued })] }), [
    "agent Fixer has 2 queued message(s) about to send",
  ]);
  // A paused queue waits for a person; an errored agent's queue does not drain.
  assert.deepEqual(
    busyReasons({
      ...empty,
      agents: [
        agent({ queuedMessages: queued, queuePaused: true }),
        agent({ queuedMessages: queued, status: "error" }),
      ],
    }),
    [],
  );
});

test("a running provider subagent is busy while its parent is idle", () => {
  const state = {
    ...empty,
    agents: [agent({ status: "idle" })],
    workspaces: [{ id: "w1", name: "paseo", runningSubagentCount: 2 }],
  };
  assert.deepEqual(busyReasons(state), ["workspace paseo has 2 running subagent(s)"]);
});

test("a schedule run in progress is busy", () => {
  const state = {
    ...empty,
    schedules: [{ id: "s1", name: "nightly", runs: [{ status: "succeeded" }, { status: "running" }] }],
  };
  assert.deepEqual(busyReasons(state), ["schedule nightly has a run in progress"]);
});
