import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import { shortenPath } from "@/utils/shorten-path";
import {
  useAutocompleteCommands,
  type AgentSlashCommand,
  type DraftCommandConfig,
  type DraftCommandTarget,
} from "@/agent-commands";
import { orderAutocompleteOptions } from "@/components/ui/autocomplete-utils";
import { useAutocomplete } from "./use-autocomplete";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  CLIENT_SLASH_COMMANDS,
  isClientSlashCommandAvailable,
  type ClientSlashCommand,
} from "@/client-slash-commands";
import { useHostFeature } from "@/runtime/host-features";
import type { PluginClientSlashCommand } from "@/plugins/client-slash-commands";
import { mergeSlashCommandSources } from "@/plugins/client-slash-commands/model";
import {
  applySlashArgumentReplacement,
  applySlashCommandReplacement,
  filterAndRankCommandAutocompleteEntries,
  filterInlineSkillCommandEntries,
  filterSlashArgumentChoices,
  findActiveSlashArgument,
  findActiveSlashCommand,
  type SlashArgumentRange,
  type SlashCommandRange,
} from "@/utils/agent-command-autocomplete";
import {
  applyFileMentionReplacement,
  findActiveFileMention,
  type FileMentionRange,
} from "@/utils/file-mention-autocomplete";

interface UseAgentAutocompleteInput {
  userInput: string;
  cursorIndex: number;
  setUserInput: (nextValue: string) => void;
  serverId: string;
  agentId: string;
  draft?: DraftCommandTarget;
  onAutocompleteApplied?: () => void;
  onClientSlashCommand?: (command: ClientSlashCommand) => void;
  canExecuteClientSlashCommand?: boolean;
  pluginClientSlashCommands?: readonly PluginClientSlashCommand[];
}

interface AgentAutocompleteKeyPressEvent {
  key: string;
  preventDefault: () => void;
  input: AgentAutocompleteInputSnapshot;
}

interface AgentAutocompleteInputSnapshot {
  text: string;
  selection: { start: number; end: number };
}

type AgentAutocompleteOption =
  | (AutocompleteOption & { type: "client_command"; command: ClientSlashCommand })
  | (AutocompleteOption & {
      type: "plugin_command";
      command: PluginClientSlashCommand;
    })
  | (AutocompleteOption & { type: "provider_command" })
  | (AutocompleteOption & { type: "argument_choice"; value: string })
  | (AutocompleteOption & {
      type: "workspace_entry";
      entryPath: string;
      mention: FileMentionRange;
    });

interface AgentAutocompleteResult {
  isVisible: boolean;
  options: AutocompleteOption[];
  selectedIndex: number;
  isLoading: boolean;
  errorMessage?: string;
  loadingText: string;
  emptyText: string;
  onSelectOption: (option: AutocompleteOption, input?: AgentAutocompleteInputSnapshot) => void;
  onKeyPress: (event: AgentAutocompleteKeyPressEvent) => boolean;
}

interface AgentAutocompleteSnapshot {
  text: string;
  slashCommand: SlashCommandRange | null;
  fileMention: FileMentionRange | null;
}

function resolveAgentAutocompleteSnapshot(input: {
  input?: AgentAutocompleteInputSnapshot;
  userInput: string;
  cursorIndex: number;
  activeSlashCommand: SlashCommandRange | null;
  activeFileMention: FileMentionRange | null;
}): AgentAutocompleteSnapshot {
  if (!input.input) {
    return {
      text: input.userInput,
      slashCommand: input.activeSlashCommand,
      fileMention: input.activeFileMention,
    };
  }

  const text = input.input.text;
  const cursorIndex = input.input.selection.start;
  return {
    text,
    slashCommand: findActiveSlashCommand({ text, cursorIndex }),
    fileMention: findActiveFileMention({ text, cursorIndex }),
  };
}

interface DirectorySuggestionEntry {
  path: string;
  kind: "file" | "directory";
}

type AvailableCommand =
  | { source: "client"; command: ClientSlashCommand }
  | { source: "plugin"; command: PluginClientSlashCommand }
  | { source: "provider"; command: AgentSlashCommand };

function resolveDraftQueryConfig(draft?: DraftCommandTarget): DraftCommandConfig | undefined {
  if (draft?.status !== "ready") {
    return undefined;
  }

  const draftConfig = draft.config;
  const cwd = draftConfig.cwd.trim();
  const modeId = draftConfig.modeId?.trim() ?? "";
  const model = draftConfig.model?.trim() ?? "";
  const thinkingOptionId = draftConfig.thinkingOptionId?.trim() ?? "";
  const featureValues = draftConfig.featureValues;
  return {
    provider: draftConfig.provider,
    cwd,
    ...(modeId ? { modeId } : {}),
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(featureValues && Object.keys(featureValues).length > 0 ? { featureValues } : {}),
  };
}

function mapDirectorySuggestionsToEntries(payload: {
  entries?: Array<{ path: string; kind: string }>;
  directories?: string[];
}): DirectorySuggestionEntry[] {
  if (Array.isArray(payload.entries) && payload.entries.length > 0) {
    return payload.entries.flatMap((entry) => {
      if (
        !entry ||
        typeof entry.path !== "string" ||
        (entry.kind !== "file" && entry.kind !== "directory")
      ) {
        return [];
      }
      return [{ path: entry.path, kind: entry.kind }];
    });
  }

  return (payload.directories ?? []).map((path) => ({
    path,
    kind: "directory" as const,
  }));
}

function mapCommandToOption(entry: AvailableCommand, t: TFunction): AgentAutocompleteOption {
  const command = entry.command;
  const base = {
    id: command.name,
    label: `/${command.name}`,
    detail: command.argumentHint || undefined,
    description:
      entry.source === "client" ? t(entry.command.descriptionKey) : entry.command.description,
    kind: "command" as const,
  };
  if (entry.source === "client") {
    return {
      ...base,
      type: "client_command",
      command: entry.command,
    };
  }
  if (entry.source === "plugin") {
    return { ...base, type: "plugin_command", command: entry.command };
  }
  return {
    ...base,
    type: "provider_command",
    ...(entry.command.sourcePath ? { sourcePath: shortenPath(entry.command.sourcePath) } : {}),
  };
}

type AutocompleteMode = "command" | "argument" | "file" | null;

interface RootCommandsInput {
  commands: AgentSlashCommand[];
  pluginCommands: readonly PluginClientSlashCommand[];
  isDraftContext: boolean;
  supportsAgentFork: boolean;
}

function resolveRootCommands(input: RootCommandsInput): AvailableCommand[] {
  return mergeSlashCommandSources({
    builtIn: CLIENT_SLASH_COMMANDS.filter((command) =>
      isClientSlashCommandAvailable(command, input),
    ),
    plugins: input.pluginCommands,
    provider: input.commands,
    onPluginCollision(command, winner) {
      console.warn(
        `[Plugins] Client slash command /${command.name} from ${command.pluginId} ignored; ${winner} command wins`,
      );
    },
  })
    .filter((entry) => !input.isDraftContext || entry.source !== "built-in")
    .map((entry): AvailableCommand => {
      if (entry.source === "built-in") return { source: "client", command: entry.command };
      return entry;
    });
}

interface BuildAutocompleteOptionsInput extends RootCommandsInput {
  isVisible: boolean;
  mode: AutocompleteMode;
  commandFilterQuery: string;
  activeSlashCommand: SlashCommandRange | null;
  activeFileMention: FileMentionRange | null;
  fileSuggestions: DirectorySuggestionEntry[];
  t: TFunction;
}

function buildCommandAutocompleteOptions(input: BuildAutocompleteOptionsInput) {
  if (!input.isVisible) {
    return [];
  }

  if (input.mode === "command") {
    const providerCommands = input.commands.map((command) => ({
      source: "provider" as const,
      command,
    }));
    const availableCommands: AvailableCommand[] =
      input.activeSlashCommand?.position === "inline"
        ? filterInlineSkillCommandEntries(providerCommands)
        : resolveRootCommands(input);
    const matches = filterAndRankCommandAutocompleteEntries(
      availableCommands,
      input.commandFilterQuery,
    );
    const orderedMatches = orderAutocompleteOptions(matches);
    return orderedMatches.map((entry) => mapCommandToOption(entry, input.t));
  }

  const activeFileMention = input.activeFileMention;
  if (input.mode === "file" && activeFileMention) {
    const orderedEntries = orderAutocompleteOptions(input.fileSuggestions);
    return orderedEntries.map((entry) => ({
      type: "workspace_entry" as const,
      id: `${entry.kind}:${entry.path}`,
      label: entry.path,
      kind: entry.kind,
      entryPath: entry.path,
      mention: activeFileMention,
    }));
  }

  return [];
}

interface ArgumentAutocomplete {
  /** Choices for the first argument, from the command's subcommands. */
  options: AgentAutocompleteOption[];
  /** Shown as a row nobody can select when the command has no choices. */
  hint: string | null;
  /**
   * Enter picks a choice only when sending the text as typed would be wrong: a partial
   * choice, or a bare command whose argument is required. Otherwise Enter sends and
   * Tab or the arrow keys pick. Menus without choices keep Enter selecting.
   */
  enterSelects: boolean;
}

const NO_ARGUMENT_AUTOCOMPLETE: ArgumentAutocomplete = {
  options: [],
  hint: null,
  enterSelects: true,
};

function buildArgumentAutocomplete(
  input: RootCommandsInput & { argument: SlashArgumentRange | null },
): ArgumentAutocomplete {
  const argument = input.argument;
  if (!argument) {
    return NO_ARGUMENT_AUTOCOMPLETE;
  }
  const entry = resolveRootCommands(input).find(
    (candidate) =>
      candidate.command.name === argument.commandName ||
      (candidate.source !== "plugin" &&
        (candidate.command.aliases ?? []).includes(argument.commandName)),
  );
  if (!entry) {
    return NO_ARGUMENT_AUTOCOMPLETE;
  }
  const subcommands = entry.source === "provider" ? (entry.command.subcommands ?? []) : [];
  if (subcommands.length === 0) {
    const hint = entry.command.argumentHint.trim();
    return hint && argument.start === argument.end
      ? { ...NO_ARGUMENT_AUTOCOMPLETE, hint: `/${entry.command.name} ${hint}` }
      : NO_ARGUMENT_AUTOCOMPLETE;
  }
  const choices = filterSlashArgumentChoices(subcommands, argument.query);
  const query = argument.query.toLowerCase();
  const isExactChoice = choices.some((choice) => choice.name.toLowerCase() === query);
  return {
    options: orderAutocompleteOptions(choices).map((choice) => ({
      type: "argument_choice" as const,
      id: `argument:${choice.name}`,
      label: choice.name,
      detail: choice.usage,
      description: choice.description,
      kind: "command" as const,
      value: choice.name,
    })),
    hint: null,
    enterSelects: query ? !isExactChoice : entry.command.argumentHint.trim().startsWith("<"),
  };
}

function resolveAutocompleteMode(args: {
  showFileAutocomplete: boolean;
  showCommandAutocomplete: boolean;
  showArgumentAutocomplete: boolean;
}): AutocompleteMode {
  if (args.showFileAutocomplete) {
    return "file";
  }
  if (args.showCommandAutocomplete) {
    return "command";
  }
  if (args.showArgumentAutocomplete) {
    return "argument";
  }
  return null;
}

function resolveAutocompleteQuery(args: {
  mode: AutocompleteMode;
  commandFilterQuery: string;
  fileFilterQuery: string;
  argument: SlashArgumentRange | null;
}): string {
  if (args.mode === "command") {
    return args.commandFilterQuery;
  }
  if (args.mode === "argument") {
    return args.argument?.query ?? "";
  }
  return args.fileFilterQuery;
}

function resolveAutocompleteIsVisible(args: {
  mode: AutocompleteMode;
  canLoadCommands: boolean;
  serverId: string;
  autocompleteCwd: string;
}): boolean {
  if (args.mode === "command" || args.mode === "argument") {
    return args.canLoadCommands;
  }
  if (args.mode === "file") {
    return Boolean(args.serverId) && args.autocompleteCwd.length > 0;
  }
  return false;
}

function resolveCanLoadCommands(args: {
  serverId: string;
  agentId: string;
  isDraftContext: boolean;
}): boolean {
  if (!args.serverId) {
    return false;
  }
  return Boolean(args.agentId) || args.isDraftContext;
}

function resolveAutocompleteIsLoading(args: {
  mode: AutocompleteMode;
  isCommandsLoading: boolean;
  isCommandsFetching: boolean;
  fileSuggestionsIsPending: boolean;
  fileSuggestionsIsLoading: boolean;
  optionsLength: number;
}): boolean {
  if (args.mode === "command") {
    // Provider commands still loading show a spinner next to the built-ins; a refetch with
    // nothing to show reads as loading, not as "no commands".
    return args.isCommandsLoading || (args.isCommandsFetching && args.optionsLength === 0);
  }
  if (args.mode === "file") {
    return (
      args.fileSuggestionsIsPending || (args.fileSuggestionsIsLoading && args.optionsLength === 0)
    );
  }
  return false;
}

function resolveAutocompleteErrorMessage(args: {
  mode: AutocompleteMode;
  isCommandError: boolean;
  commandError: Error | null;
  fileSuggestionsError: unknown;
  t: TFunction;
}): string | undefined {
  if (args.mode === "command") {
    return args.isCommandError
      ? (args.commandError?.message ?? args.t("agentAutocomplete.failedToLoad"))
      : undefined;
  }
  if (args.mode === "file") {
    return args.fileSuggestionsError instanceof Error
      ? args.fileSuggestionsError.message
      : undefined;
  }
  return undefined;
}

// A draft's agentId is a draft key the daemon does not know, so a draft lists
// commands by its config only, and not at all until that config is complete.
function resolveDraftCommandContext(draft: DraftCommandTarget | undefined) {
  const queryDraftConfig = resolveDraftQueryConfig(draft);
  const isDraftContext = draft !== undefined;
  return {
    isDraftContext,
    queryDraftConfig,
    canListCommands: !isDraftContext || queryDraftConfig !== undefined,
  };
}

function resolveAutocompleteEmptyText(args: {
  mode: AutocompleteMode;
  draft: DraftCommandTarget | undefined;
  argumentHint: string | null;
  t: TFunction;
}): string {
  if (args.mode === "argument") {
    return args.argumentHint ?? "";
  }
  if (args.mode === "file") {
    return args.t("agentAutocomplete.noFiles");
  }
  if (args.draft?.status === "needs-project") {
    return args.t("agentAutocomplete.chooseProjectForCommands");
  }
  if (args.draft?.status === "needs-provider") {
    return args.t("agentAutocomplete.chooseModelForCommands");
  }
  return args.t("agentAutocomplete.noCommands");
}

function applyArgumentChoice(input: {
  value: string;
  snapshot: AgentAutocompleteInputSnapshot | undefined;
  userInput: string;
  activeSlashArgument: SlashArgumentRange | null;
}): string | null {
  const text = input.snapshot?.text ?? input.userInput;
  const argument = input.snapshot
    ? findActiveSlashArgument({ text, cursorIndex: input.snapshot.selection.start })
    : input.activeSlashArgument;
  return argument ? applySlashArgumentReplacement({ text, argument, value: input.value }) : null;
}

function useArgumentAutocomplete(
  input: RootCommandsInput & {
    mode: AutocompleteMode;
    isVisible: boolean;
    argument: SlashArgumentRange | null;
  },
): { argumentAutocomplete: ArgumentAutocomplete; isMenuVisible: boolean } {
  const { mode, argument, commands, pluginCommands, isDraftContext, supportsAgentFork } = input;
  const argumentAutocomplete = useMemo(
    () =>
      mode === "argument"
        ? buildArgumentAutocomplete({
            argument,
            commands,
            pluginCommands,
            isDraftContext,
            supportsAgentFork,
          })
        : NO_ARGUMENT_AUTOCOMPLETE,
    [argument, commands, isDraftContext, mode, pluginCommands, supportsAgentFork],
  );
  // The argument menu shows only when it has choices or a hint for this command.
  const hasArgumentContent =
    argumentAutocomplete.options.length > 0 || argumentAutocomplete.hint !== null;
  return {
    argumentAutocomplete,
    isMenuVisible: input.isVisible && (mode !== "argument" || hasArgumentContent),
  };
}

// One refetch per menu session when the typed query matches nothing: the command the user is
// looking for may have been installed after the cached list was fetched.
function useRevalidateCommandsOnMiss(args: {
  mode: AutocompleteMode;
  isVisible: boolean;
  commandFilterQuery: string;
  optionsLength: number;
  revalidateForMiss: () => void;
}) {
  const { mode, revalidateForMiss } = args;
  const revalidatedRef = useRef(false);
  const hasMiss =
    mode === "command" &&
    args.isVisible &&
    args.commandFilterQuery.length > 0 &&
    args.optionsLength === 0;
  useEffect(() => {
    if (mode !== "command") {
      revalidatedRef.current = false;
      return;
    }
    if (!hasMiss || revalidatedRef.current) {
      return;
    }
    revalidatedRef.current = true;
    revalidateForMiss();
  }, [mode, hasMiss, revalidateForMiss]);
}

export function useAgentAutocomplete(input: UseAgentAutocompleteInput): AgentAutocompleteResult {
  const { t } = useTranslation();
  const {
    userInput,
    cursorIndex,
    setUserInput,
    serverId,
    agentId,
    draft,
    onAutocompleteApplied,
    onClientSlashCommand,
    canExecuteClientSlashCommand,
    pluginClientSlashCommands = [],
  } = input;

  const activeSlashCommand = useMemo(
    () =>
      findActiveSlashCommand({
        text: userInput,
        cursorIndex,
      }),
    [cursorIndex, userInput],
  );
  const showCommandAutocomplete = activeSlashCommand !== null;
  const commandFilterQuery = activeSlashCommand?.query ?? "";
  const activeSlashArgument = useMemo(
    () => findActiveSlashArgument({ text: userInput, cursorIndex }),
    [cursorIndex, userInput],
  );

  const activeFileMention = useMemo(
    () =>
      findActiveFileMention({
        text: userInput,
        cursorIndex,
      }),
    [cursorIndex, userInput],
  );
  const showFileAutocomplete = activeFileMention !== null;
  const fileFilterQuery = activeFileMention?.query ?? "";
  const [debouncedFileFilterQuery, setDebouncedFileFilterQuery] = useState(fileFilterQuery);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFileFilterQuery(fileFilterQuery), 180);
    return () => clearTimeout(timer);
  }, [fileFilterQuery]);

  const { isDraftContext, queryDraftConfig, canListCommands } = useMemo(
    () => resolveDraftCommandContext(draft),
    [draft],
  );
  const canLoadCommands = resolveCanLoadCommands({ serverId, agentId, isDraftContext });

  const agentCwd = useSessionStore(
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.cwd ?? "",
  );
  const autocompleteCwd = useMemo(() => {
    if (isDraftContext) {
      return queryDraftConfig?.cwd ?? "";
    }
    return agentCwd.trim();
  }, [agentCwd, isDraftContext, queryDraftConfig]);

  const client = useHostRuntimeClient(serverId);
  const supportsAgentFork = useHostFeature(serverId, "agentFork");
  const isConnected = useHostRuntimeIsConnected(serverId);

  const mode = resolveAutocompleteMode({
    showFileAutocomplete,
    showCommandAutocomplete,
    showArgumentAutocomplete: activeSlashArgument !== null,
  });
  // The command menu does not wait for provider commands: built-in and plugin commands
  // show at once and provider commands join when they arrive. Listing them can take
  // seconds when the daemon has to resume an idle agent first.
  const isVisible = resolveAutocompleteIsVisible({
    mode,
    canLoadCommands,
    serverId,
    autocompleteCwd,
  });

  const commandsQuery = useAutocompleteCommands({
    serverId,
    agentId,
    enabled: (mode === "command" || mode === "argument") && canLoadCommands && canListCommands,
    draftConfig: queryDraftConfig,
  });
  const {
    commands,
    isError,
    error,
    isFetching: isCommandsFetching,
    revalidateForMiss,
  } = commandsQuery;
  const isCommandsLoading = canListCommands && commandsQuery.isLoading;

  const { argumentAutocomplete, isMenuVisible } = useArgumentAutocomplete({
    mode,
    isVisible,
    argument: activeSlashArgument,
    commands,
    pluginCommands: pluginClientSlashCommands,
    isDraftContext,
    supportsAgentFork,
  });
  const fileSuggestionsQuery = useQuery({
    queryKey: [
      "directorySuggestions",
      serverId,
      autocompleteCwd,
      debouncedFileFilterQuery,
      true,
      true,
    ],
    queryFn: async (): Promise<DirectorySuggestionEntry[]> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const response = await client.getDirectorySuggestions({
        cwd: autocompleteCwd,
        query: debouncedFileFilterQuery,
        limit: 50,
        includeFiles: true,
        includeDirectories: true,
      });
      if (response.error) {
        throw new Error(response.error);
      }
      return mapDirectorySuggestionsToEntries(response);
    },
    enabled:
      mode === "file" &&
      Boolean(serverId) &&
      autocompleteCwd.length > 0 &&
      Boolean(client) &&
      isConnected,
    retry: false,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const options = useMemo<AgentAutocompleteOption[]>(() => {
    if (mode === "argument") {
      return isVisible ? argumentAutocomplete.options : [];
    }
    return buildCommandAutocompleteOptions({
      activeFileMention,
      commandFilterQuery,
      commands,
      pluginCommands: pluginClientSlashCommands,
      activeSlashCommand,
      fileSuggestions: fileSuggestionsQuery.data ?? [],
      isDraftContext,
      supportsAgentFork,
      isVisible,
      mode,
      t,
    });
  }, [
    activeFileMention,
    activeSlashCommand,
    argumentAutocomplete.options,
    commandFilterQuery,
    commands,
    pluginClientSlashCommands,
    fileSuggestionsQuery.data,
    isDraftContext,
    supportsAgentFork,
    isVisible,
    mode,
    t,
  ]);

  useRevalidateCommandsOnMiss({
    mode,
    isVisible,
    commandFilterQuery,
    optionsLength: options.length,
    revalidateForMiss,
  });

  const onSelectOption = useCallback(
    (option: AutocompleteOption, snapshot?: AgentAutocompleteInputSnapshot) => {
      const selected = option as AgentAutocompleteOption;
      if (selected.type === "argument_choice") {
        const nextInput = applyArgumentChoice({
          value: selected.value,
          snapshot,
          userInput,
          activeSlashArgument,
        });
        if (nextInput !== null) {
          setUserInput(nextInput);
          onAutocompleteApplied?.();
        }
        return;
      }
      const current = resolveAgentAutocompleteSnapshot({
        input: snapshot,
        userInput,
        cursorIndex,
        activeSlashCommand,
        activeFileMention,
      });
      const selectedIsCommand =
        selected.type === "client_command" ||
        selected.type === "plugin_command" ||
        selected.type === "provider_command";
      if (snapshot && selectedIsCommand && !current.slashCommand) return;
      if (
        selected.type === "client_command" &&
        selected.command.execution === "immediate" &&
        canExecuteClientSlashCommand &&
        onClientSlashCommand
      ) {
        onClientSlashCommand(selected.command);
        return;
      }

      if (selectedIsCommand) {
        if (!current.slashCommand) {
          setUserInput(`/${selected.id} `);
          onAutocompleteApplied?.();
          return;
        }

        const nextInput = applySlashCommandReplacement({
          text: current.text,
          command: current.slashCommand,
          commandName: selected.id,
        });
        setUserInput(nextInput);
        onAutocompleteApplied?.();
        return;
      }

      if (!current.fileMention) return;
      const nextInput = applyFileMentionReplacement({
        text: current.text,
        mention: current.fileMention,
        relativePath: selected.entryPath,
      });
      setUserInput(nextInput);
      onAutocompleteApplied?.();
    },
    [
      canExecuteClientSlashCommand,
      onAutocompleteApplied,
      onClientSlashCommand,
      setUserInput,
      userInput,
      cursorIndex,
      activeFileMention,
      activeSlashArgument,
      activeSlashCommand,
    ],
  );

  const selectOptionFromKeyPress = useCallback(
    (option: AutocompleteOption, event?: AgentAutocompleteKeyPressEvent) =>
      onSelectOption(option, event?.input),
    [onSelectOption],
  );

  const { selectedIndex, onKeyPress } = useAutocomplete({
    isVisible: isMenuVisible,
    options,
    query: resolveAutocompleteQuery({
      mode,
      commandFilterQuery,
      fileFilterQuery,
      argument: activeSlashArgument,
    }),
    onSelectOption: selectOptionFromKeyPress,
    onEscape:
      mode === "command" && activeSlashCommand?.position === "start"
        ? () => setUserInput("")
        : undefined,
    enterSelects: argumentAutocomplete.enterSelects,
  });

  const isLoading = resolveAutocompleteIsLoading({
    mode,
    isCommandsLoading,
    isCommandsFetching,
    fileSuggestionsIsPending: fileSuggestionsQuery.isPending,
    fileSuggestionsIsLoading: fileSuggestionsQuery.isLoading,
    optionsLength: options.length,
  });
  const errorMessage = resolveAutocompleteErrorMessage({
    mode,
    isCommandError: isError,
    commandError: error,
    fileSuggestionsError: fileSuggestionsQuery.error,
    t,
  });

  const loadingText =
    mode === "file"
      ? t("agentAutocomplete.searchingWorkspace")
      : t("agentAutocomplete.loadingCommands");
  const emptyText = resolveAutocompleteEmptyText({
    mode,
    draft,
    argumentHint: argumentAutocomplete.hint,
    t,
  });

  return {
    isVisible: isMenuVisible,
    options,
    selectedIndex,
    isLoading,
    errorMessage,
    loadingText,
    emptyText,
    onSelectOption,
    onKeyPress,
  };
}
