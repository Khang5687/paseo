import type { CreateTerminalResponse, ListTerminalsResponse } from "@getpaseo/protocol/messages";

type TerminalListEntry = ListTerminalsResponse["payload"]["terminals"][number];
type CreatedTerminal = NonNullable<CreateTerminalResponse["payload"]["terminal"]>;

function toTerminalListEntry(input: { terminal: CreatedTerminal }): TerminalListEntry {
  return {
    id: input.terminal.id,
    name: input.terminal.name,
    ...(input.terminal.title ? { title: input.terminal.title } : {}),
    // The chat drawer reads the owner; without it a new drawer terminal opens as a workspace tab
    // until the next list refresh.
    ...(input.terminal.ownerAgentId ? { ownerAgentId: input.terminal.ownerAgentId } : {}),
    ...(input.terminal.createdAt ? { createdAt: input.terminal.createdAt } : {}),
  };
}

export function upsertTerminalListEntry(input: {
  terminals: TerminalListEntry[];
  terminal: CreatedTerminal;
}): TerminalListEntry[] {
  const createdTerminal = toTerminalListEntry({ terminal: input.terminal });
  const existingIndex = input.terminals.findIndex((terminal) => terminal.id === createdTerminal.id);

  if (existingIndex < 0) {
    return [...input.terminals, createdTerminal];
  }

  const nextTerminals = [...input.terminals];
  nextTerminals[existingIndex] = createdTerminal;
  return nextTerminals;
}
