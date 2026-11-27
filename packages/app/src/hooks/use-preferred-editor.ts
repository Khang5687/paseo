import { useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { readValidatedString, type ValidatedStorage } from "@/storage/validated-storage";

type EditorTargetId = string;

const PREFERRED_EDITOR_STORAGE_KEY = "@paseo:preferred-editor";

interface EditorPreferenceStorage extends ValidatedStorage {
  setItem(key: string, value: string): Promise<void>;
}

interface ProjectEditorScope {
  serverId: string;
  projectId: string | null;
}

export function createPreferredEditorPreference({
  scope,
  queryClient,
  storage,
}: {
  scope: ProjectEditorScope;
  queryClient: QueryClient;
  storage: EditorPreferenceStorage;
}) {
  const queryKey = ["preferred-editor", scope.serverId, scope.projectId];
  const storageKey = `${PREFERRED_EDITOR_STORAGE_KEY}:${JSON.stringify([scope.serverId, scope.projectId])}`;
  async function load() {
    if (scope.projectId === null) return null;
    const projectEditor = await readValidatedString(storage, storageKey, z.string().trim().min(1));
    if (projectEditor !== null) return projectEditor;
    return readValidatedString(storage, PREFERRED_EDITOR_STORAGE_KEY, z.string().trim().min(1));
  }
  return {
    queryOptions: {
      queryKey,
      queryFn: load,
      enabled: scope.projectId !== null,
      staleTime: Infinity,
      gcTime: Infinity,
    },
    async update(editorId: EditorTargetId | null) {
      if (scope.projectId === null) return;
      if (editorId) {
        await storage.setItem(storageKey, editorId);
      } else {
        await storage.removeItem(storageKey);
      }
      queryClient.setQueryData(queryKey, await load());
    },
  };
}

const DEFAULT_EDITOR_QUERY_KEY = ["default-editor"];

/**
 * The editor every project falls back to until it has its own choice. Settings edits it, and
 * opens with no project (file links in chat) use it.
 */
export function createDefaultEditorPreference({
  queryClient,
  storage,
}: {
  queryClient: QueryClient;
  storage: EditorPreferenceStorage;
}) {
  function load() {
    return readValidatedString(storage, PREFERRED_EDITOR_STORAGE_KEY, z.string().trim().min(1));
  }
  return {
    queryOptions: {
      queryKey: DEFAULT_EDITOR_QUERY_KEY,
      queryFn: load,
      staleTime: Infinity,
      gcTime: Infinity,
    },
    async update(editorId: EditorTargetId | null) {
      if (editorId) {
        await storage.setItem(PREFERRED_EDITOR_STORAGE_KEY, editorId);
      } else {
        await storage.removeItem(PREFERRED_EDITOR_STORAGE_KEY);
      }
      queryClient.setQueryData(DEFAULT_EDITOR_QUERY_KEY, await load());
      // Project preferences without their own choice resolve to this default.
      await queryClient.invalidateQueries({ queryKey: ["preferred-editor"] });
    },
  };
}

export function resolvePreferredEditorId(
  availableEditorIds: readonly EditorTargetId[],
  storedEditorId: EditorTargetId | null | undefined,
): EditorTargetId | null {
  if (storedEditorId === undefined) {
    return null;
  }
  if (
    storedEditorId &&
    availableEditorIds.some((availableEditorId) => availableEditorId === storedEditorId)
  ) {
    return storedEditorId;
  }
  return availableEditorIds[0] ?? null;
}

export function usePreferredEditor(scope: ProjectEditorScope) {
  const queryClient = useQueryClient();
  const { serverId, projectId } = scope;
  const preference = useMemo(
    () =>
      createPreferredEditorPreference({
        scope: { serverId, projectId },
        queryClient,
        storage: AsyncStorage,
      }),
    [queryClient, serverId, projectId],
  );
  const { data, isPending } = useQuery(preference.queryOptions);

  const isLoading = projectId !== null && isPending;
  return {
    preferredEditorId: isLoading ? undefined : (data ?? null),
    isLoading,
    updatePreferredEditor: preference.update,
  };
}

export function useDefaultEditor() {
  const queryClient = useQueryClient();
  const preference = useMemo(
    () => createDefaultEditorPreference({ queryClient, storage: AsyncStorage }),
    [queryClient],
  );
  const { data, isPending } = useQuery(preference.queryOptions);
  return {
    preferredEditorId: isPending ? undefined : (data ?? null),
    updatePreferredEditor: preference.update,
  };
}
