import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import React from "react";
import type { ToastApi } from "@/components/toast-host";
import type { OpenFileDisposition } from "@/workspace/file-open";
import type { InlinePathTarget } from "./parse";
import { findOfflineFiles } from "@/offline-files/store";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { AssistantFileLinkContext, GetDirectorySuggestions } from "./resolver";

export interface AssistantFileLinkDaemonClient {
  readFile?: import("@getpaseo/client/internal/daemon-client").DaemonClient["readFile"];
  getDirectorySuggestions: GetDirectorySuggestions;
}

export interface AssistantFileLinkResolverConfig {
  client?: AssistantFileLinkDaemonClient | null;
  serverId?: string;
  workspaceRoot?: string;
  /**
   * Folders to search for a bare file name after the workspace root misses: the workspace folder
   * and the project root, which sit above the agent's working directory.
   */
  searchRoots?: readonly string[];
  /** The files this chat's agent named in its tool calls. Read when a link is opened. */
  getKnownFilePaths?: () => readonly string[];
  relativePathBase?: string;
  onOpenWorkspaceFile?: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
  toast?: ToastApi | null;
}

export interface AssistantFileLinkResolverProviderProps extends AssistantFileLinkResolverConfig {
  children: ReactNode;
}

export interface AssistantFileLinkResolverContextValue {
  configRef: MutableRefObject<AssistantFileLinkResolverConfig>;
  getDirectorySuggestions: GetDirectorySuggestions;
  /** Whether the chat's host is connected and can search Git-ignored files. */
  supportsIgnoredLookup: () => boolean;
}

const AssistantFileLinkResolverContext =
  createContext<AssistantFileLinkResolverContextValue | null>(null);

export function useAssistantFileLinkEnvironmentBridge() {
  const value = useContext(AssistantFileLinkResolverContext);
  return useCallback(
    (children: ReactNode) => (
      <AssistantFileLinkResolverContext.Provider value={value}>
        {children}
      </AssistantFileLinkResolverContext.Provider>
    ),
    [value],
  );
}

export function AssistantFileLinkResolverProvider({
  client,
  serverId,
  workspaceRoot,
  searchRoots,
  getKnownFilePaths,
  relativePathBase,
  onOpenWorkspaceFile,
  toast,
  children,
}: AssistantFileLinkResolverProviderProps) {
  const configRef = useRef<AssistantFileLinkResolverConfig>({
    client,
    serverId,
    workspaceRoot,
    searchRoots,
    getKnownFilePaths,
    relativePathBase,
    onOpenWorkspaceFile,
    toast,
  });
  configRef.current = {
    client,
    serverId,
    workspaceRoot,
    searchRoots,
    getKnownFilePaths,
    relativePathBase,
    onOpenWorkspaceFile,
    toast,
  };

  const getDirectorySuggestions = useCallback<GetDirectorySuggestions>(async (input) => {
    const { client: activeClient, serverId: activeServerId } = configRef.current;
    // With the host offline, bare file names resolve against the files saved on this device.
    const host = activeServerId ? getHostRuntimeStore().getSnapshot(activeServerId) : null;
    if (activeServerId && host && !isHostRuntimeConnected(host)) {
      const paths = await findOfflineFiles({
        serverId: activeServerId,
        cwd: input.cwd,
        query: input.query,
      });
      return {
        entries: paths.slice(0, input.limit).map((path) => ({ path, kind: "file" as const })),
        error: null,
      };
    }
    if (!activeClient) {
      return { entries: [], error: null };
    }

    const result = await activeClient.getDirectorySuggestions(input);
    return { entries: result.entries, error: result.error };
  }, []);

  const supportsIgnoredLookup = useCallback(() => {
    const { serverId: activeServerId } = configRef.current;
    if (!activeServerId) return false;
    const host = getHostRuntimeStore().getSnapshot(activeServerId);
    if (!host || !isHostRuntimeConnected(host)) return false;
    return (
      useSessionStore.getState().sessions[activeServerId]?.serverInfo?.features
        ?.directorySuggestionsIncludeIgnored === true
    );
  }, []);

  const value = useMemo<AssistantFileLinkResolverContextValue>(
    () => ({ configRef, getDirectorySuggestions, supportsIgnoredLookup }),
    [getDirectorySuggestions, supportsIgnoredLookup],
  );

  return (
    <AssistantFileLinkResolverContext.Provider value={value}>
      {children}
    </AssistantFileLinkResolverContext.Provider>
  );
}

export function useAssistantFileLinkResolverContext(): AssistantFileLinkResolverContextValue {
  const context = useContext(AssistantFileLinkResolverContext);
  return context ?? EMPTY_CONTEXT;
}

export type { AssistantFileLinkContext };

const EMPTY_CONTEXT: AssistantFileLinkResolverContextValue = {
  configRef: { current: {} },
  getDirectorySuggestions: async () => ({ entries: [], error: null }),
  supportsIgnoredLookup: () => false,
};

export function useAssistantFileLinkEnvironment() {
  return useAssistantFileLinkResolverContext().configRef.current;
}
