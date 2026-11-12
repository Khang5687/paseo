import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ComposerEditingSession } from "@/composer/editing-session";

/** Where a chat message's commands run: the agent's host and workspace. */
export interface CodeRunScope {
  serverId: string;
  agentId: string;
  workspaceId: string;
  cwd: string;
  /** Identifies the message, so the same command in two replies keeps two runs. */
  messageKey: string;
  /** Shows a run's terminal as a tab of its workspace. */
  openTerminal: (input: { workspaceId: string; terminalId: string }) => void;
}

const ScopeContext = createContext<CodeRunScope | null>(null);
const ComposerInsertContext = createContext<((text: string) => void) | null>(null);

/** Shell fences under this provider get a Run button. Without it they render as plain code. */
export function CodeRunScopeProvider({
  serverId,
  agentId,
  workspaceId,
  cwd,
  messageKey,
  openTerminal,
  children,
}: CodeRunScope & { children: ReactNode }) {
  const scope = useMemo(
    () => ({ serverId, agentId, workspaceId, cwd, messageKey, openTerminal }),
    [serverId, agentId, workspaceId, cwd, messageKey, openTerminal],
  );
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}

export function useCodeRunScope(): CodeRunScope | null {
  return useContext(ScopeContext);
}

/** Lets a finished run hand its output to the chat's composer. */
export function CodeRunComposerProvider({
  editingSession,
  children,
}: {
  editingSession: ComposerEditingSession | null;
  children: ReactNode;
}) {
  const insert = useMemo(
    () => (editingSession ? (text: string) => editingSession.insertText(text) : null),
    [editingSession],
  );
  return <ComposerInsertContext.Provider value={insert}>{children}</ComposerInsertContext.Provider>;
}

export function useCodeRunComposerInsert(): ((text: string) => void) | null {
  return useContext(ComposerInsertContext);
}

export function codeRunKey(scope: CodeRunScope, codeHash: string): string {
  return [scope.serverId, scope.agentId, scope.messageKey, codeHash].join("\u0000");
}
