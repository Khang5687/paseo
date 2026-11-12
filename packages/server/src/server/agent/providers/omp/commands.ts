import type {
  AgentSlashCommand,
  AgentSlashCommandKind,
  AgentSlashCommandSubcommand,
} from "../../agent-sdk-types.js";
import { OmpAvailableCommandsUpdateEventSchema, type OmpAvailableCommand } from "./rpc-types.js";

export const OMP_HANDLED_BUILTIN_SLASH_COMMANDS: readonly AgentSlashCommand[] = [
  {
    name: "compact",
    description: "Manually compact the session context",
    argumentHint: "[instructions]",
    kind: "command",
  },
  {
    name: "autocompact",
    description: "Toggle automatic context compaction",
    argumentHint: "[on|off|toggle]",
    kind: "command",
    subcommands: [
      { name: "on", description: "Enable automatic compaction" },
      { name: "off", description: "Disable automatic compaction" },
      { name: "toggle", description: "Switch automatic compaction on or off" },
    ],
  },
  {
    name: "goal",
    description: "Set, pause, resume, drop, or show the OMP goal",
    argumentHint: "[set <objective> [--budget N] | pause | resume | drop | show]",
    kind: "command",
  },
  {
    name: "handoff",
    description: "Hand off from planning to implementation",
    argumentHint: "[instructions]",
    kind: "command",
  },
  {
    name: "steer",
    description: "Steer the active OMP turn",
    argumentHint: "<message>",
    kind: "command",
  },
  {
    name: "follow-up",
    description: "Queue a follow-up message for OMP",
    argumentHint: "<message>",
    kind: "command",
  },
];

export function mapOmpSlashCommands(commands: readonly OmpAvailableCommand[]): AgentSlashCommand[] {
  const mappedCommands = new Map<string, AgentSlashCommand>(
    OMP_HANDLED_BUILTIN_SLASH_COMMANDS.map((command) => [command.name, { ...command }]),
  );
  for (const command of commands) {
    const knownCommand = mappedCommands.get(command.name);
    const subcommands = command.subcommands?.length
      ? command.subcommands.map(mapOmpSubcommand)
      : knownCommand?.subcommands;
    mappedCommands.set(command.name, {
      name: command.name,
      description: command.description ?? command.source ?? "command",
      argumentHint: command.input?.hint ?? knownCommand?.argumentHint ?? "",
      kind: mapOmpCommandKind(command.source),
      ...(command.aliases?.length ? { aliases: [...command.aliases] } : {}),
      ...(subcommands ? { subcommands } : {}),
    });
  }
  return [...mappedCommands.values()];
}

export function mapOmpAvailableCommandsUpdate(event: unknown): AgentSlashCommand[] | null {
  const parsed = OmpAvailableCommandsUpdateEventSchema.safeParse(event);
  return parsed.success ? mapOmpSlashCommands(parsed.data.commands) : null;
}

/** How Paseo runs one `/compact` invocation against OMP. */
export type OmpCompactRequest =
  | { kind: "rpc"; customInstructions?: string }
  | { kind: "prompt"; message: string }
  | { kind: "invalid"; error: string };

/**
 * OMP's `compact` RPC takes no mode, so `/compact <mode> [focus]` goes through
 * OMP's own `/compact` handler as a prompt. `modes` are the subcommands OMP
 * advertises for `compact`. Like OMP's parser, a first token that is not a mode
 * makes the whole argument focus text. OMP advertises a mode that takes no focus
 * text (snapcompact) without `usage`, and its handler rejects focus for it.
 */
export function resolveOmpCompactRequest(
  args: string | undefined,
  modes: readonly AgentSlashCommandSubcommand[],
): OmpCompactRequest {
  const trimmed = args?.trim() ?? "";
  if (!trimmed) {
    return { kind: "rpc" };
  }
  const spaceIndex = trimmed.search(/\s/);
  const firstToken = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
  const mode = modes.find((candidate) => candidate.name.toLowerCase() === firstToken);
  if (!mode) {
    return { kind: "rpc", customInstructions: trimmed };
  }
  const focus = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
  if (focus && !mode.usage) {
    return { kind: "invalid", error: `/compact ${mode.name} does not take focus instructions.` };
  }
  return {
    kind: "prompt",
    message: focus ? `/compact ${mode.name} ${focus}` : `/compact ${mode.name}`,
  };
}

function mapOmpCommandKind(source: string | undefined): AgentSlashCommandKind {
  return source === "skill" ? "skill" : "command";
}

function mapOmpSubcommand(
  subcommand: NonNullable<OmpAvailableCommand["subcommands"]>[number],
): AgentSlashCommandSubcommand {
  return {
    name: subcommand.name,
    ...(subcommand.description ? { description: subcommand.description } : {}),
    ...(subcommand.usage ? { usage: subcommand.usage } : {}),
  };
}
