import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { OpenFileDisposition } from "@/workspace/file-open";
import { openExternalUrl } from "@/utils/open-external-url";
import { formatFileLinkTooltipPath } from "./tooltip-path";
import type { InlinePathTarget } from "./parse";
import { chooseFileFrom } from "./file-link-choice";
import {
  FileLinkPickCancelledError,
  lookupFileCandidatesOnDaemon,
  matchKnownFileTargets,
  resolveFileLinkCandidates,
  type FileLinkLadderInput,
} from "./ladder";
import {
  useAssistantFileLinkResolverContext,
  type AssistantFileLinkResolverConfig,
  type AssistantFileLinkResolverContextValue,
} from "./provider";
import {
  classifyForResolution,
  getAssistantFileLinkToken,
  UnresolvedFileLinkError,
  type AssistantFileLinkResolution,
  type AssistantFileLinkSource,
  type AssistantFileLinkContext,
} from "./resolver";

export interface UseFileLinkResult {
  target: InlinePathTarget | null;
  /**
   * The file this link names before any daemon lookup, or null when it is not a local file.
   * An ambiguous token's real path is only known after `resolveFile`.
   */
  fileCandidate: InlinePathTarget | null;
  tooltipPath: string | null;
  onHoverIn: () => void;
  onPress: () => void;
  open: (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => void;
  /**
   * The link's file, looked up through the ladder when the token is ambiguous. Asks which file
   * the link means when several match, and rejects with `FileLinkPickCancelledError` when the
   * user dismisses the question.
   */
  resolveFile: () => Promise<InlinePathTarget>;
}

export interface AssistantFileLinkActions {
  open(source: AssistantFileLinkSource, disposition: OpenFileDisposition): void;
  canOpen(source: AssistantFileLinkSource): boolean;
  canResolveFile(source: AssistantFileLinkSource): boolean;
}

interface AssistantFileLinkLookupKey {
  query: string;
  path: string;
  lineStart: number | null;
  lineEnd: number | null;
  /** The extra roots the lookup searches, joined. */
  roots: string;
  /** Whether the lookup also searches Git-ignored files. */
  ignored: boolean;
}

type AssistantFileLinkQueryKey = readonly [
  "assistantFileLink",
  string | null,
  string | null,
  AssistantFileLinkLookupKey | null,
];

type NeedsLookupResolution = Extract<AssistantFileLinkResolution, { kind: "needsLookup" }>;

const DISABLED_QUERY_KEY = ["assistantFileLink", null, null, null] as const;

export function useFileLink(source: AssistantFileLinkSource): UseFileLinkResult {
  const { t } = useTranslation();
  const context = useAssistantFileLinkResolverContext();
  const queryClient = useQueryClient();
  const stableSource = useStableSource(source);
  const activeConfig = context.configRef.current;
  const workspaceRoot = activeConfig.workspaceRoot;
  const relativePathBase = activeConfig.relativePathBase;
  const serverId = activeConfig.serverId;
  const searchRoots = activeConfig.searchRoots;
  const searchIgnored = context.supportsIgnoredLookup();
  const resolution = useMemo(
    () =>
      classifyForResolution(stableSource, {
        workspaceRoot,
        relativePathBase,
      }),
    [stableSource, workspaceRoot, relativePathBase],
  );
  const queryKey = useMemo(
    () =>
      resolution.kind === "needsLookup"
        ? assistantFileLinkQueryKey({
            serverId,
            workspaceRoot,
            searchRoots,
            searchIgnored,
            resolution,
          })
        : DISABLED_QUERY_KEY,
    [resolution, searchIgnored, searchRoots, serverId, workspaceRoot],
  );

  const fetchLookup = useStableEvent(() => {
    if (resolution.kind !== "needsLookup") {
      throw new Error("Assistant file link lookup requested for a sync link.");
    }
    return fetchDaemonCandidates(
      buildLadderInput({ resolution, config: context.configRef.current, context }),
      resolution.token,
    );
  });

  const query = useQuery({
    queryKey,
    queryFn: fetchLookup,
    enabled: false,
    retry: 0,
    staleTime: Infinity,
  });

  const open = useStableEvent(
    (nextSource: AssistantFileLinkSource, disposition: OpenFileDisposition) => {
      openAssistantFileLink({
        source: nextSource,
        disposition,
        context,
        queryClient,
        formatNoFileFoundMessage: (token) => t("common.errors.noFileFound", { token }),
      });
    },
  );

  const onHoverIn = useStableEvent(() => {
    if (resolution.kind !== "needsLookup") {
      return;
    }

    void queryClient.prefetchQuery({
      queryKey,
      queryFn: fetchLookup,
      retry: 0,
      staleTime: Infinity,
    });
  });

  const onPress = useStableEvent(() => {
    open(stableSource, "preferred");
  });

  const knownTargets = useMemo(
    () =>
      resolution.kind === "needsLookup"
        ? matchKnownFileTargets(
            buildLadderInput({ resolution, config: context.configRef.current, context }),
          )
        : [],
    [context, resolution],
  );

  const target = useMemo(() => {
    if (resolution.kind === "resolved") {
      return resolution.value.kind === "file" ? resolution.value.target : null;
    }
    // Several matches leave the link ambiguous until the user picks one.
    const candidates = knownTargets.length > 0 ? knownTargets : (query.data ?? []);
    return candidates.length === 1 ? candidates[0] : null;
  }, [knownTargets, query.data, resolution]);

  const fileCandidate = useMemo(() => {
    if (resolution.kind === "needsLookup") {
      return resolution.target;
    }
    return resolution.value.kind === "file" ? resolution.value.target : null;
  }, [resolution]);

  const resolveFile = useStableEvent(async (): Promise<InlinePathTarget> => {
    if (resolution.kind === "needsLookup") {
      return resolveFileLinkLookup({
        resolution,
        config: context.configRef.current,
        context,
        queryClient,
      });
    }
    if (resolution.value.kind === "file") {
      return resolution.value.target;
    }
    throw new UnresolvedFileLinkError(getAssistantFileLinkToken(stableSource));
  });

  const tooltipPath = target ? formatFileLinkTooltipPath({ target, workspaceRoot }) : null;
  return useMemo(
    () => ({ target, fileCandidate, tooltipPath, onHoverIn, onPress, open, resolveFile }),
    [target, fileCandidate, tooltipPath, onHoverIn, onPress, open, resolveFile],
  );
}

export function useAssistantFileLinkActions(): AssistantFileLinkActions {
  const context = useAssistantFileLinkResolverContext();
  const actionLink = useFileLink(ACTION_LINK_SOURCE);

  const open = useStableEvent(
    (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => {
      actionLink.open(source, disposition);
    },
  );
  const canOpen = useCallback(
    (source: AssistantFileLinkSource) =>
      canOpenAssistantFileLink(source, context.configRef.current),
    [context.configRef],
  );
  const canResolveFile = useCallback(
    (source: AssistantFileLinkSource) =>
      canResolveAssistantFileLinkToFile(source, context.configRef.current),
    [context.configRef],
  );

  return useMemo(() => ({ open, canOpen, canResolveFile }), [open, canOpen, canResolveFile]);
}

function openAssistantFileLink(input: {
  source: AssistantFileLinkSource;
  disposition: OpenFileDisposition;
  context: AssistantFileLinkResolverContextValue;
  queryClient: QueryClient;
  formatNoFileFoundMessage: (token: string) => string;
}): void {
  const capturedConfig = input.context.configRef.current;
  const capturedResolution = classifyForResolution(input.source, {
    workspaceRoot: capturedConfig.workspaceRoot,
    relativePathBase: capturedConfig.relativePathBase,
  });

  if (capturedResolution.kind === "resolved") {
    void dispatchResolvedLink({
      resolution: capturedResolution,
      disposition: input.disposition,
      capturedServerId: capturedConfig.serverId,
      capturedWorkspaceRoot: capturedConfig.workspaceRoot,
      context: input.context,
    });
    return;
  }

  const run = async () => {
    try {
      const target = await resolveFileLinkLookup({
        resolution: capturedResolution,
        config: capturedConfig,
        context: input.context,
        queryClient: input.queryClient,
      });
      await dispatchFileTarget({
        target,
        disposition: input.disposition,
        capturedServerId: capturedConfig.serverId,
        capturedWorkspaceRoot: capturedConfig.workspaceRoot,
        context: input.context,
      });
    } catch (error) {
      if (error instanceof FileLinkPickCancelledError) return;
      await dispatchUnresolvedError({
        error,
        noFileFoundMessage: input.formatNoFileFoundMessage(capturedResolution.token),
        capturedServerId: capturedConfig.serverId,
        capturedWorkspaceRoot: capturedConfig.workspaceRoot,
        context: input.context,
      });
    }
  };

  void run();
}

function buildLadderInput(input: {
  resolution: NeedsLookupResolution;
  config: AssistantFileLinkResolverConfig;
  context: AssistantFileLinkResolverContextValue;
}): FileLinkLadderInput {
  return {
    query: input.resolution.ambiguousQuery,
    target: input.resolution.target,
    cwd: input.config.workspaceRoot?.trim() ?? "",
    extraRoots: input.config.searchRoots ?? [],
    knownPaths: input.config.getKnownFilePaths?.() ?? [],
    searchIgnored: input.context.supportsIgnoredLookup(),
    getDirectorySuggestions: input.context.getDirectorySuggestions,
  };
}

/** The daemon steps of the ladder. A miss throws so a file created later is looked up again. */
async function fetchDaemonCandidates(
  ladder: FileLinkLadderInput,
  token: string,
): Promise<InlinePathTarget[]> {
  if (!ladder.cwd) throw new UnresolvedFileLinkError(token);
  const found = await lookupFileCandidatesOnDaemon(ladder);
  if (found.length === 0) throw new UnresolvedFileLinkError(token);
  return found;
}

/**
 * Walks the ladder for a link that needs a lookup and settles on one file: the only match, or the
 * one the user picks when several match. Rejects with `UnresolvedFileLinkError` when nothing
 * matches and `FileLinkPickCancelledError` when the user dismisses the question.
 */
export async function resolveFileLinkLookup(input: {
  resolution: NeedsLookupResolution;
  config: AssistantFileLinkResolverConfig;
  context: AssistantFileLinkResolverContextValue;
  queryClient: QueryClient;
}): Promise<InlinePathTarget> {
  const { resolution, config, context, queryClient } = input;
  const ladder = buildLadderInput({ resolution, config, context });
  if (!ladder.cwd) throw new UnresolvedFileLinkError(resolution.token);
  const queryKey = assistantFileLinkQueryKey({
    serverId: config.serverId,
    workspaceRoot: config.workspaceRoot,
    searchRoots: config.searchRoots,
    searchIgnored: ladder.searchIgnored,
    resolution,
  });
  const candidates = await resolveFileLinkCandidates(ladder, async (lookupInput) => {
    try {
      return await queryClient.fetchQuery({
        queryKey,
        queryFn: () => fetchDaemonCandidates(lookupInput, resolution.token),
        retry: 0,
        staleTime: Infinity,
      });
    } catch (error) {
      if (error instanceof UnresolvedFileLinkError) return [];
      throw error;
    }
  });
  if (candidates.length === 0) throw new UnresolvedFileLinkError(resolution.token);
  if (candidates.length === 1) return candidates[0];
  const chosen = await chooseFileFrom({
    paths: candidates.map((candidate) => candidate.path),
    workspaceRoot: ladder.cwd,
  });
  const picked = candidates.find((candidate) => candidate.path === chosen);
  if (!picked) throw new FileLinkPickCancelledError();
  return picked;
}

function canOpenAssistantFileLink(
  source: AssistantFileLinkSource,
  context: AssistantFileLinkContext,
): boolean {
  const resolution = classifyForResolution(source, context);
  return resolution.kind === "needsLookup" || resolution.value.kind !== "ignored";
}

function canResolveAssistantFileLinkToFile(
  source: AssistantFileLinkSource,
  context: AssistantFileLinkContext,
): boolean {
  const resolution = classifyForResolution(source, context);
  return resolution.kind === "needsLookup" || resolution.value.kind === "file";
}

function useStableSource(source: AssistantFileLinkSource): AssistantFileLinkSource {
  const { href, text, title, markup, sourceInfo, sourceType } = source;
  return useMemo(
    () => ({ href, text, title, markup, sourceInfo, sourceType }),
    [href, text, title, markup, sourceInfo, sourceType],
  );
}

function assistantFileLinkQueryKey(input: {
  serverId?: string;
  workspaceRoot?: string;
  searchRoots?: readonly string[];
  searchIgnored: boolean;
  resolution: NeedsLookupResolution;
}): AssistantFileLinkQueryKey {
  return [
    "assistantFileLink",
    input.serverId ?? null,
    input.workspaceRoot ?? null,
    {
      query: input.resolution.ambiguousQuery,
      path: input.resolution.target.path,
      lineStart: input.resolution.target.lineStart ?? null,
      lineEnd: input.resolution.target.lineEnd ?? null,
      roots: (input.searchRoots ?? []).join("\n"),
      ignored: input.searchIgnored,
    },
  ];
}

async function dispatchResolvedLink(input: {
  resolution: Extract<AssistantFileLinkResolution, { kind: "resolved" }>;
  disposition: OpenFileDisposition;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const { value } = input.resolution;
  if (value.kind === "file") {
    await dispatchFileTarget({
      target: value.target,
      disposition: input.disposition,
      capturedServerId: input.capturedServerId,
      capturedWorkspaceRoot: input.capturedWorkspaceRoot,
      context: input.context,
    });
    return;
  }
  if (value.kind === "external") {
    await dispatchExternalUrl({
      url: value.url,
      capturedServerId: input.capturedServerId,
      capturedWorkspaceRoot: input.capturedWorkspaceRoot,
      context: input.context,
    });
  }
}

async function dispatchFileTarget(input: {
  target: InlinePathTarget;
  disposition: OpenFileDisposition;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const current = input.context.configRef.current;
  if (
    current.serverId !== input.capturedServerId ||
    current.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  current.onOpenWorkspaceFile?.(input.target, input.disposition);
}

async function dispatchExternalUrl(input: {
  url: string;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const current = input.context.configRef.current;
  if (
    current.serverId !== input.capturedServerId ||
    current.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  await openExternalUrl(input.url);
}

async function dispatchUnresolvedError(input: {
  error: unknown;
  noFileFoundMessage: string;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const current = input.context.configRef.current;
  if (
    current.serverId !== input.capturedServerId ||
    current.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  current.toast?.show(input.noFileFoundMessage, {
    variant: "error",
    testID: "assistant-file-link-not-found-toast",
  });
}

const ACTION_LINK_SOURCE: AssistantFileLinkSource = {
  href: "",
};
