import { describe, expect, it } from "vitest";
import {
  CLIENT_SLASH_COMMANDS,
  buildDraftAgentSetup,
  isClientSlashCommandAvailable,
  resolveClientSlashCommand,
} from "@/client-slash-commands";
import type { Agent } from "@/stores/session-store";

function createAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date("2026-05-15T00:00:00.000Z");
  return {
    serverId: "server-1",
    id: "agent-1",
    provider: "codex",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: now,
    lastActivityAt: now,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: "mode-current",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: "session-1",
      model: "runtime-model",
      modeId: "runtime-mode",
      thinkingOptionId: "runtime-thinking",
    },
    title: "Agent",
    cwd: "/repo",
    model: "agent-model",
    thinkingOptionId: "think-hard",
    features: [
      { type: "toggle", id: "web-search", label: "Web search", value: true },
      {
        type: "select",
        id: "effort",
        label: "Effort",
        value: "high",
        options: [{ id: "high", label: "High" }],
      },
    ],
    parentAgentId: null,
    labels: {},
    ...overrides,
    turn: overrides.turn ?? { phase: "idle", cancellationRequestId: null },
  };
}

function resolve(
  text: string,
  overrides: { hasAttachments?: boolean; supportsAgentFork?: boolean },
) {
  return resolveClientSlashCommand({
    text,
    hasAttachments: overrides.hasAttachments ?? false,
    supportsAgentFork: overrides.supportsAgentFork ?? false,
  });
}

describe("resolveClientSlashCommand", () => {
  it("declares the exact canonical client commands with their aliases", () => {
    expect(
      CLIENT_SLASH_COMMANDS.map((command) => [
        command.name,
        [...command.aliases],
        command.execution,
      ]),
    ).toEqual([
      ["exit", ["quit", "q"], "immediate"],
      ["clear", ["new"], "immediate"],
      ["fork", [], "immediate"],
    ]);
  });

  it("resolves canonical names and aliases after trimming", () => {
    expect(resolve(" /quit ", {})).toMatchObject({
      name: "exit",
      kind: "archive-agent",
      execution: "immediate",
    });
    expect(resolve("/exit", {})).toMatchObject({ name: "exit", kind: "archive-agent" });
    expect(resolve("/q", {})).toMatchObject({ name: "exit", kind: "archive-agent" });
    expect(resolve("/clear", {})).toMatchObject({
      name: "clear",
      kind: "replace-agent-with-draft",
    });
    expect(resolve("/new", {})).toMatchObject({ name: "clear", kind: "replace-agent-with-draft" });
  });

  it("resolves /fork only on hosts with native fork support", () => {
    expect(resolve("/fork", { supportsAgentFork: true })).toMatchObject({
      name: "fork",
      kind: "fork-agent",
      execution: "immediate",
    });
    expect(resolve("/fork", { supportsAgentFork: false })).toBeNull();
    expect(
      isClientSlashCommandAvailable(CLIENT_SLASH_COMMANDS[2]!, { supportsAgentFork: false }),
    ).toBe(false);
    expect(
      isClientSlashCommandAvailable(CLIENT_SLASH_COMMANDS[0]!, { supportsAgentFork: false }),
    ).toBe(true);
  });

  it("leaves provider commands, arguments, ordinary messages, and attachment submits alone", () => {
    expect(resolve("/clear now", {})).toBeNull();
    expect(resolve("/quit now", {})).toBeNull();
    expect(resolve("/fork now", { supportsAgentFork: true })).toBeNull();
    expect(resolve("/provider-command", {})).toBeNull();
    expect(resolve("hello /quit", {})).toBeNull();
    expect(resolve("/quit", { hasAttachments: true })).toBeNull();
    expect(resolve("/fork", { hasAttachments: true, supportsAgentFork: true })).toBeNull();
  });
});

describe("buildDraftAgentSetup", () => {
  it("builds draft setup from the active agent snapshot", () => {
    expect(buildDraftAgentSetup(createAgent())).toEqual({
      provider: "codex",
      cwd: "/repo",
      modeId: "mode-current",
      model: "agent-model",
      thinkingOptionId: "think-hard",
      featureValues: {
        "web-search": true,
        effort: "high",
      },
    });
  });

  it("falls back to runtime model setup when top-level fields are absent", () => {
    expect(
      buildDraftAgentSetup(
        createAgent({
          currentModeId: null,
          model: null,
          thinkingOptionId: null,
        }),
      ),
    ).toMatchObject({
      modeId: "runtime-mode",
      model: "runtime-model",
      thinkingOptionId: "runtime-thinking",
    });
  });
});
