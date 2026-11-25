import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { AutocompleteOption, AutocompleteStatus } from "@/components/ui/autocomplete";
import { findHighlightRanges } from "@/components/ui/highlighted-text-segments";
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
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { pluginDisplayName, usePluginList } from "@/plugins/plugin-list";
import { resolveProviderLabel } from "@/utils/provider-definitions";
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
  /** Shown in place of options; set exactly when `options` is empty. */
  status: AutocompleteStatus | null;
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

function isSameSlashCommand(a: SlashCommandRange | null, b: SlashCommandRange | null): boolean {
  return a?.start === b?.start && a?.query === b?.query;
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
  const providerOptions = draftConfig.providerOptions;
  return {
    provider: draftConfig.provider,
    cwd,
    ...(modeId ? { modeId } : {}),
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(providerOptions && Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
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

const CLIENT_COMMAND_ICONS = {
  "archive-agent": "archive",
  "replace-agent-with-draft": "new-draft",
  "fork-agent": "fork",
} as const satisfies Record<ClientSlashCommand["kind"], AutocompleteOption["icon"]>;

interface CommandOptionContext {
  query: string;
  pluginNames: ReadonlyMap<string, string>;
  t: TFunction;
}

function mapCommandToOption(
  entry: AvailableCommand,
  context: CommandOptionContext,
): AgentAutocompleteOption {
  const command = entry.command;
  const base = {
    id: command.name,
    label: `/${command.name}`,
    // The label carries a leading slash the query does not.
    labelMatches: findHighlightRanges(context.query, command.name).map((range) => ({
      start: range.start + 1,
      length: range.length,
    })),
    argumentHint: command.argumentHint || undefined,
  };
  if (entry.source === "client") {
    return {
      ...base,
      type: "client_command",
      command: entry.command,
      icon: CLIENT_COMMAND_ICONS[entry.command.kind],
      description: context.t(entry.command.descriptionKey),
      tag: "Paseo",
    };
  }
  if (entry.source === "plugin") {
    return {
      ...base,
      type: "plugin_command",
      command: entry.command,
      icon: "plugin",
      description: entry.command.description,
      tag: context.pluginNames.get(entry.command.pluginId) ?? entry.command.pluginId,
    };
  }
  const isSkill = entry.command.kind === "skill";
  return {
    ...base,
    type: "provider_command",
    icon: isSkill ? "skill" : "command",
    description: entry.command.description,
    tag: isSkill ? context.t("agentAutocomplete.skillTag") : undefined,
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
  mode: AutocompleteMode;
  pluginNames: ReadonlyMap<string, string>;
  commandFilterQuery: string;
  activeSlashCommand: SlashCommandRange | null;
  activeFileMention: FileMentionRange | null;
  fileSuggestions: DirectorySuggestionEntry[];
  t: TFunction;
}

function buildAutocompleteOptions(input: BuildAutocompleteOptionsInput): AgentAutocompleteOption[] {
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
    const context = {
      query: input.commandFilterQuery,
      pluginNames: input.pluginNames,
      t: input.t,
    };
    return orderAutocompleteOptions(matches).map((entry) => mapCommandToOption(entry, context));
  }

  const activeFileMention = input.activeFileMention;
  if (input.mode === "file" && activeFileMention) {
    const orderedEntries = orderAutocompleteOptions(input.fileSuggestions);
    return orderedEntries.map((entry) => ({
      type: "workspace_entry" as const,
      id: `${entry.kind}:${entry.path}`,
      label: entry.path,
      icon: entry.kind,
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
      labelMatches: findHighlightRanges(argument.query, choice.name),
      icon: "command" as const,
      argumentHint: choice.usage,
      description: choice.description,
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

type CommandsState = "ready" | "loading" | "error";

function resolveCommandsState(input: {
  canListCommands: boolean;
  isLoading: boolean;
  isError: boolean;
}): CommandsState {
  if (!input.canListCommands) return "ready";
  if (input.isError) return "error";
  if (input.isLoading) return "loading";
  return "ready";
}

interface AutocompleteMenu {
  options: AgentAutocompleteOption[];
  status: AutocompleteStatus | null;
}

/**
 * One state for the open menu, so options and a loading or error row cannot both claim it:
 * while a status row shows there are no options for Enter or Tab to pick.
 */
function resolveCommandMenu(input: {
  commandsState: CommandsState;
  /** A refetch is running; with nothing to list it reads as loading, not as "no commands". */
  isFetching: boolean;
  options: () => AgentAutocompleteOption[];
  providerLabel: string | null;
  error: Error | null;
  onRetry: () => void;
  emptyText: string;
  t: TFunction;
}): AutocompleteMenu {
  const { t } = input;
  const loadingStatus: AutocompleteStatus = {
    kind: "loading",
    message: input.providerLabel
      ? t("agentAutocomplete.loadingProviderCommands", { provider: input.providerLabel })
      : t("agentAutocomplete.loadingCommands"),
  };
  if (input.commandsState === "loading") {
    return { options: [], status: loadingStatus };
  }
  if (input.commandsState === "error") {
    const title = input.providerLabel
      ? t("agentAutocomplete.providerCommandsFailed", { provider: input.providerLabel })
      : t("agentAutocomplete.commandsFailed");
    return {
      options: [],
      status: { kind: "error", title, reason: input.error?.message, onRetry: input.onRetry },
    };
  }
  const options = input.options();
  if (options.length === 0 && input.isFetching) {
    return { options, status: loadingStatus };
  }
  return withEmptyStatus(options, input.emptyText);
}

function resolveFileMenu(input: {
  options: () => AgentAutocompleteOption[];
  isPending: boolean;
  isLoading: boolean;
  error: unknown;
  t: TFunction;
}): AutocompleteMenu {
  const options = input.options();
  if (input.isPending || (input.isLoading && options.length === 0)) {
    return {
      options: [],
      status: { kind: "loading", message: input.t("agentAutocomplete.searchingWorkspace") },
    };
  }
  if (input.error instanceof Error) {
    return {
      options: [],
      status: {
        kind: "error",
        title: input.t("agentAutocomplete.filesFailed"),
        reason: input.error.message,
      },
    };
  }
  return withEmptyStatus(options, input.t("agentAutocomplete.noFiles"));
}

function withEmptyStatus(options: AgentAutocompleteOption[], emptyText: string): AutocompleteMenu {
  return options.length > 0
    ? { options, status: null }
    : { options, status: { kind: "empty", message: emptyText } };
}

/** How long a command menu waits for commands before it opens on a loading row. */
const COMMANDS_LOADING_REVEAL_MS = 300;

/**
 * Whether the open command menu has waited long enough to show a loading row. Commands that
 * arrive sooner paint the list as the first frame; once the wait is over, loading (a retry)
 * shows at once so the open menu never closes on itself.
 */
function useLoadingRevealed(isMenuOpen: boolean): boolean {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!isMenuOpen) {
      setRevealed(false);
      return undefined;
    }
    const timer = setTimeout(() => setRevealed(true), COMMANDS_LOADING_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [isMenuOpen]);
  return revealed;
}

/** The names command rows and status rows show: the provider's label and each plugin's name. */
function useCommandSourceNames(input: {
  serverId: string;
  agentId: string;
  draftConfig: DraftCommandConfig | undefined;
  cwd: string;
  isCommandMenuOpen: boolean;
  commandsState: CommandsState;
  pluginCommandCount: number;
}): { providerLabel: string | null; pluginNames: ReadonlyMap<string, string> } {
  const agentProvider = useSessionStore(
    (state) => state.sessions[input.serverId]?.agents?.get(input.agentId)?.provider,
  );
  const provider = input.draftConfig?.provider ?? agentProvider;
  // Only a loading or error row names the provider; only plugin rows need plugin names.
  const { entries: providerEntries } = useProvidersSnapshot(input.serverId, {
    cwd: input.cwd,
    enabled: input.isCommandMenuOpen && input.commandsState !== "ready",
  });
  const pluginList = usePluginList(input.serverId, {
    enabled: input.isCommandMenuOpen && input.pluginCommandCount > 0,
  });
  const pluginNames = useMemo(
    () => new Map((pluginList.data ?? []).map((plugin) => [plugin.id, pluginDisplayName(plugin)])),
    [pluginList.data],
  );
  return {
    providerLabel: provider ? resolveProviderLabel(provider, providerEntries) : null,
    pluginNames,
  };
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
  isMenuVisible: boolean;
  commandsState: CommandsState;
  query: string;
  optionCount: number;
  revalidateForMiss: () => void;
}) {
  const { mode, revalidateForMiss } = args;
  const hasMiss =
    mode === "command" &&
    args.isMenuVisible &&
    args.commandsState === "ready" &&
    args.query.length > 0 &&
    args.optionCount === 0;
  const revalidatedRef = useRef(false);
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

function resolveCommandsEmptyText(args: {
  draft: DraftCommandTarget | undefined;
  t: TFunction;
}): string {
  if (args.draft?.status === "needs-project") {
    return args.t("agentAutocomplete.chooseProjectForCommands");
  }
  if (args.draft?.status === "needs-provider") {
    return args.t("agentAutocomplete.chooseModelForCommands");
  }
  return args.t("agentAutocomplete.noCommands");
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
  const activeSlashArgument = useMemo(
    () => findActiveSlashArgument({ text: userInput, cursorIndex }),
    [cursorIndex, userInput],
  );
  const showCommandAutocomplete = activeSlashCommand !== null;
  const commandFilterQuery = activeSlashCommand?.query ?? "";

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
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsAgentFork = useHostFeature(serverId, "agentFork");

  const mode = resolveAutocompleteMode({
    showFileAutocomplete,
    showCommandAutocomplete,
    showArgumentAutocomplete: activeSlashArgument !== null,
  });
  const canShowAutocomplete = resolveAutocompleteIsVisible({
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
  const commandsState = resolveCommandsState({
    canListCommands,
    isLoading: commandsQuery.isLoading,
    isError: commandsQuery.isError,
  });
  const isCommandMenuOpen = mode === "command" && canShowAutocomplete;
  const isLoadingRevealed = useLoadingRevealed(isCommandMenuOpen);
  const isVisible =
    canShowAutocomplete &&
    !(isCommandMenuOpen && commandsState === "loading" && !isLoadingRevealed);
  const { providerLabel, pluginNames } = useCommandSourceNames({
    serverId,
    agentId,
    draftConfig: queryDraftConfig,
    cwd: autocompleteCwd,
    isCommandMenuOpen,
    commandsState,
    pluginCommandCount: pluginClientSlashCommands.length,
  });
  const { argumentAutocomplete, isMenuVisible } = useArgumentAutocomplete({
    mode,
    isVisible,
    argument: activeSlashArgument,
    commands: commandsQuery.commands,
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

  const commandsEmptyText = resolveCommandsEmptyText({ draft, t });
  const retryCommandsQuery = commandsQuery.retry;
  const retryCommands = useCallback(() => {
    retryCommandsQuery();
    // Pressing Retry takes focus on web; hand it back so the user keeps typing the command.
    onAutocompleteApplied?.();
  }, [onAutocompleteApplied, retryCommandsQuery]);
  const { options, status } = useMemo<AutocompleteMenu>(() => {
    if (!isMenuVisible) return { options: [], status: null };
    if (mode === "argument") {
      return withEmptyStatus(argumentAutocomplete.options, argumentAutocomplete.hint ?? "");
    }
    const buildOptions = () =>
      buildAutocompleteOptions({
        activeFileMention,
        commandFilterQuery,
        commands: commandsQuery.commands,
        pluginCommands: pluginClientSlashCommands,
        pluginNames,
        activeSlashCommand,
        fileSuggestions: fileSuggestionsQuery.data ?? [],
        isDraftContext,
        supportsAgentFork,
        mode,
        t,
      });
    if (mode === "file") {
      return resolveFileMenu({
        options: buildOptions,
        isPending: fileSuggestionsQuery.isPending,
        isLoading: fileSuggestionsQuery.isLoading,
        error: fileSuggestionsQuery.error,
        t,
      });
    }
    return resolveCommandMenu({
      commandsState,
      isFetching: commandsQuery.isFetching,
      options: buildOptions,
      providerLabel,
      error: commandsQuery.error,
      onRetry: retryCommands,
      emptyText: commandsEmptyText,
      t,
    });
  }, [
    activeFileMention,
    activeSlashCommand,
    argumentAutocomplete,
    commandFilterQuery,
    commandsEmptyText,
    commandsQuery.commands,
    commandsQuery.error,
    commandsQuery.isFetching,
    commandsState,
    fileSuggestionsQuery.data,
    fileSuggestionsQuery.error,
    fileSuggestionsQuery.isLoading,
    fileSuggestionsQuery.isPending,
    isDraftContext,
    isMenuVisible,
    mode,
    pluginClientSlashCommands,
    pluginNames,
    providerLabel,
    retryCommands,
    supportsAgentFork,
    t,
  ]);

  useRevalidateCommandsOnMiss({
    mode,
    isMenuVisible,
    commandsState,
    query: commandFilterQuery,
    optionCount: options.length,
    revalidateForMiss: commandsQuery.revalidateForMiss,
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
    (option: AutocompleteOption, event?: AgentAutocompleteKeyPressEvent) => {
      // The cursor reaches the menu after paint, so a key can land while the options still
      // belong to an older query. Never pick from that list. A click picks what the user sees.
      if (
        mode === "command" &&
        event &&
        !isSameSlashCommand(
          findActiveSlashCommand({
            text: event.input.text,
            cursorIndex: event.input.selection.start,
          }),
          activeSlashCommand,
        )
      ) {
        return;
      }
      onSelectOption(option, event?.input);
    },
    [activeSlashCommand, mode, onSelectOption],
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

  return {
    isVisible: isMenuVisible,
    options,
    selectedIndex,
    status,
    onSelectOption,
    onKeyPress,
  };
}
