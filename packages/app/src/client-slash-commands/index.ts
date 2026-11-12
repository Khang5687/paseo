import type { Agent } from "@/stores/session-store";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";

export type ClientSlashCommandKind = "archive-agent" | "replace-agent-with-draft" | "fork-agent";
export type ClientSlashCommandExecution = "immediate" | "insert";

export interface ClientSlashCommand {
  name: string;
  aliases: readonly string[];
  description: string;
  descriptionKey:
    | "composer.clientCommands.archiveAgent"
    | "composer.clientCommands.freshDraft"
    | "composer.clientCommands.forkAgent";
  argumentHint: string;
  kind: ClientSlashCommandKind;
  execution: ClientSlashCommandExecution;
  /** Only offered and runnable when the host reports `server_info.features.agentFork`. */
  requiresAgentFork?: boolean;
}

export const CLIENT_SLASH_COMMANDS: readonly ClientSlashCommand[] = [
  {
    name: "exit",
    aliases: ["quit", "q"],
    description: "Archive the current agent",
    descriptionKey: "composer.clientCommands.archiveAgent",
    argumentHint: "",
    kind: "archive-agent",
    execution: "immediate",
  },
  {
    name: "clear",
    aliases: ["new"],
    description: "Archive this agent and start a fresh draft",
    descriptionKey: "composer.clientCommands.freshDraft",
    argumentHint: "",
    kind: "replace-agent-with-draft",
    execution: "immediate",
  },
  {
    name: "fork",
    aliases: [],
    description: "Fork this chat into a new tab",
    descriptionKey: "composer.clientCommands.forkAgent",
    argumentHint: "",
    kind: "fork-agent",
    execution: "immediate",
    requiresAgentFork: true,
  },
];

const COMMAND_BY_NAME = new Map<string, ClientSlashCommand>();
for (const command of CLIENT_SLASH_COMMANDS) {
  COMMAND_BY_NAME.set(command.name, command);
  for (const alias of command.aliases) {
    COMMAND_BY_NAME.set(alias, command);
  }
}

export function isClientSlashCommandAvailable(
  command: ClientSlashCommand,
  host: { supportsAgentFork: boolean },
): boolean {
  return !command.requiresAgentFork || host.supportsAgentFork;
}

export function resolveClientSlashCommand(input: {
  text: string;
  hasAttachments: boolean;
  supportsAgentFork: boolean;
}): ClientSlashCommand | null {
  if (input.hasAttachments) {
    return null;
  }

  const trimmed = input.text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const commandName = trimmed.slice(1);
  if (!commandName || /\s/.test(commandName)) {
    return null;
  }

  const command = COMMAND_BY_NAME.get(commandName) ?? null;
  return command && isClientSlashCommandAvailable(command, input) ? command : null;
}

export function buildDraftAgentSetup(agent: Agent): WorkspaceDraftTabSetup {
  const featureValues: Record<string, unknown> = {};
  for (const feature of agent.features ?? []) {
    featureValues[feature.id] = feature.value;
  }

  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    featureValues,
  };
}
