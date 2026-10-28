import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentManagerEvent, ManagedAgent } from "./agent/agent-manager.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "./workspace-registry.js";
import { attachWorkspaceAutoUnsettle } from "./workspace-settle.js";

const SETTLED_AT = "2026-09-30T12:00:00.000Z";

describe("attachWorkspaceAutoUnsettle", () => {
  let tmpDir: string;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  let emit: (event: AgentManagerEvent) => void;
  let detach: () => void;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-settle-"));
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      createTestLogger(),
    );
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-1",
        projectId: "proj-1",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: SETTLED_AT,
        settledAt: SETTLED_AT,
      }),
    );
    let listener: ((event: AgentManagerEvent) => void) | null = null;
    detach = attachWorkspaceAutoUnsettle({
      agentManager: {
        subscribe: (callback) => {
          listener = callback;
          return () => {
            listener = null;
          };
        },
      },
      workspaceRegistry,
      logger: createTestLogger(),
    });
    emit = (event) => listener?.(event);
  });

  afterEach(() => {
    detach();
    rmSync(tmpDir, { recursive: true, force: true });
  });
  function agentState(input: {
    activeTurnStartedAt: string | null;
    internal?: boolean;
    workspaceId?: string;
  }) {
    // Only the fields the hook reads; a full ManagedAgent needs a live provider session.
    const agent = {
      id: "agent-1",
      workspaceId: input.workspaceId ?? "ws-1",
      internal: input.internal,
      activeTurnStartedAt: input.activeTurnStartedAt ? new Date(input.activeTurnStartedAt) : null,
    } as unknown as ManagedAgent;
    return { type: "agent_state", agent } as const;
  }

  test("a turn that starts after the settle returns the workspace to the main list", async () => {
    emit(agentState({ activeTurnStartedAt: "2026-09-30T12:05:00.000Z" }));

    await vi.waitFor(async () => {
      expect((await workspaceRegistry.get("ws-1"))?.settledAt).toBeNull();
    });
  });
  test("a turn already running when the user settled keeps the workspace settled", async () => {
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-2",
        projectId: "proj-1",
        cwd: "/tmp/repo-2",
        kind: "local_checkout",
        displayName: "other",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: SETTLED_AT,
        settledAt: SETTLED_AT,
      }),
    );
    emit(agentState({ activeTurnStartedAt: "2026-09-30T11:55:00.000Z" }));
    emit(agentState({ activeTurnStartedAt: null }));
    emit(agentState({ activeTurnStartedAt: "2026-09-30T12:05:00.000Z", internal: true }));
    // Events are handled in order, so once a later qualifying turn has unsettled ws-2,
    // every earlier ws-1 event has been fully handled.
    emit(agentState({ activeTurnStartedAt: "2026-09-30T12:05:00.000Z", workspaceId: "ws-2" }));
    await vi.waitFor(async () => {
      expect((await workspaceRegistry.get("ws-2"))?.settledAt).toBeNull();
    });

    expect((await workspaceRegistry.get("ws-1"))?.settledAt).toBe(SETTLED_AT);
  });
});
