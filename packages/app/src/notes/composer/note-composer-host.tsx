import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type SetStateAction,
} from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StyleSheet } from "react-native-unistyles";
import type { EditNoteOptions } from "@getpaseo/client/internal/daemon-client";
import {
  AdaptiveModalSheet,
  FULL_SHEET_SNAP_POINTS,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { queryClient } from "@/data/query-client";
import { useNoteComposerStore, type NoteDraft } from "@/notes/composer-store";
import {
  cancelNoteLocalReminder,
  claimLocalReminder,
  syncNoteLocalReminder,
} from "@/notes/local-reminders";
import type { Note, NoteAnchor, NoteCommandCondition } from "@/notes/model";
import { reminderDay } from "@/notes/screen/note-row-model";
import { createNote, deleteNote, editNote, useHostNotes, useNotesStore } from "@/notes/store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { shortenPath } from "@/utils/shorten-path";
import { formatTimeOfDay } from "@/utils/time";
import {
  buildEditChanges,
  buildFormWait,
  canSaveForm,
  openCreateForm,
  openEditForm,
  resolveFormTime,
  type NoteComposerForm,
  type NoteWaitKind,
} from "./note-composer-model";
import { REMINDER_PRESETS, type ReminderPreset } from "./parse-reminder-time";

const QUOTE_COLLAPSED_LINES = 3;
const QUOTE_COLLAPSE_CHARS = 160;
const CLOCK_TICK_MS = 30_000;
const FOCUS_DELAY_MS = 50;
const TERMINALS_STALE_MS = 5_000;
const CONDITIONS: readonly NoteCommandCondition[] = ["any", "success", "failure"];

type SetForm = Dispatch<SetStateAction<NoteComposerForm>>;
type PendingAction = "save" | "resolve" | "delete";
type HostAgents = ReadonlyMap<string, Agent> | null;

// Each open gets a fresh form, even when a new request replaces one that is still open.
const requestKeys = new WeakMap<object, string>();
let nextRequestKey = 0;

function requestKey(request: object): string {
  let key = requestKeys.get(request);
  if (!key) {
    nextRequestKey += 1;
    key = `note-composer-${nextRequestKey}`;
    requestKeys.set(request, key);
  }
  return key;
}

/** The one note composer. Mount once at the app root; `openNoteComposer` / `openNoteEditor` show it. */
export function NoteComposerHost(): ReactElement | null {
  const request = useNoteComposerStore((state) => state.request);
  if (!request) return null;
  if (request.mode === "create") {
    const { draft } = request;
    return (
      <NoteComposerSheet
        key={requestKey(request)}
        serverId={draft.serverId}
        quote={draft.quote}
        anchor={draft.anchor}
        draft={draft}
        note={null}
      />
    );
  }
  return (
    <NoteEditorLoader
      key={requestKey(request)}
      serverId={request.serverId}
      noteId={request.noteId}
    />
  );
}

/** Waits for the note to be known on its host and closes once it is gone (deleted elsewhere). */
function NoteEditorLoader({ serverId, noteId }: { serverId: string; noteId: string }) {
  const notes = useHostNotes(serverId);
  const status = useNotesStore((state) => state.hosts[serverId]?.status);
  const close = useNoteComposerStore((state) => state.close);
  const note = notes.find((entry) => entry.id === noteId) ?? null;
  const missing = note === null && status !== undefined && status !== "loading";
  useEffect(() => {
    if (missing) close();
  }, [close, missing]);
  if (!note) return null;
  return (
    <NoteComposerSheet
      serverId={serverId}
      quote={note.quote}
      anchor={note.anchor}
      draft={null}
      note={note}
    />
  );
}

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function useAgentOptions(
  agents: HostAgents,
  anchorWorkspaceId: string | undefined,
): SelectFieldOption<string>[] {
  const { t } = useTranslation();
  return useMemo(() => {
    if (!agents) return [];
    const list = Array.from(agents.values()).filter((agent) => !agent.archivedAt);
    list.sort(
      (a, b) =>
        Number(b.workspaceId === anchorWorkspaceId) - Number(a.workspaceId === anchorWorkspaceId) ||
        b.lastActivityAt.getTime() - a.lastActivityAt.getTime(),
    );
    return list.map((agent) => ({
      id: agent.id,
      value: agent.id,
      label: agent.title?.trim() || t("notes.composer.agent.untitled"),
      description: shortenPath(agent.cwd),
    }));
  }, [agents, anchorWorkspaceId, t]);
}

/** Every terminal on the host, the note's own workspace first. */
function useTerminalOptions(serverId: string, anchorWorkspaceId: string | undefined) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const query = useFetchQuery(
    {
      queryKey: ["notes-composer-terminals", serverId],
      enabled: client !== null,
      dataShape: "list",
      staleTimeMs: TERMINALS_STALE_MS,
      queryFn: async () => {
        if (!client) throw new Error("Host is offline");
        return client.listTerminals();
      },
    },
    queryClient,
  );
  const options = useMemo<SelectFieldOption<string>[]>(() => {
    const list = [...(query.data?.terminals ?? [])];
    list.sort(
      (a, b) =>
        Number(b.workspaceId === anchorWorkspaceId) - Number(a.workspaceId === anchorWorkspaceId),
    );
    return list.map((terminal) => ({
      id: terminal.id,
      value: terminal.id,
      label: terminal.title?.trim() || terminal.name,
      description: terminal.cwd ? shortenPath(terminal.cwd) : undefined,
    }));
  }, [anchorWorkspaceId, query.data]);
  return { options, loading: client !== null && query.isPending };
}

interface NoteComposerSheetProps {
  serverId: string;
  quote: string;
  anchor: NoteAnchor;
  /** Set when adding a note. */
  draft: NoteDraft | null;
  /** Set when editing; the live note, so resolve/reopen reads its current state. */
  note: Note | null;
}

function NoteComposerSheet({
  serverId,
  quote,
  anchor,
  draft,
  note,
}: NoteComposerSheetProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const close = useNoteComposerStore((state) => state.close);
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const now = useClock();
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents ?? null);
  const agentOptions = useAgentOptions(agents, anchor.workspaceId);
  const terminals = useTerminalOptions(serverId, anchor.workspaceId);
  const [initialForm] = useState<NoteComposerForm>(() => {
    if (draft) {
      return openCreateForm(draft, (agentId) => agents?.get(agentId)?.title?.trim() || null);
    }
    if (note) return openEditForm(note);
    throw new Error("The note composer needs a draft or a note");
  });
  const [form, setForm] = useState(initialForm);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const textInputRef = useRef<EditingTextInputHandle>(null);

  // Focus once the sheet has presented: opening it dismisses any keyboard left from below.
  useEffect(() => {
    const timeout = setTimeout(() => textInputRef.current?.focus(), FOCUS_DELAY_MS);
    return () => clearTimeout(timeout);
  }, []);

  const runAction = useCallback(
    async (action: PendingAction, errorKey: string, work: () => Promise<boolean>) => {
      setPending(action);
      try {
        if (await work()) close();
      } catch (error) {
        toast.error(t(errorKey, { message: toErrorMessage(error) }));
      } finally {
        setPending(null);
      }
    },
    [close, t, toast],
  );

  const saveNew = useCallback(async (): Promise<boolean> => {
    const text = form.text.trim();
    const built = buildFormWait(form, new Date());
    if (!built.ok || !text) return false;
    const { wait } = built;
    const localReminder = wait?.type === "time" ? await claimLocalReminder(wait.at) : null;
    const created = await createNote(serverId, { text, quote, anchor, wait, localReminder });
    void syncNoteLocalReminder(serverId, created);
    return true;
  }, [anchor, form, quote, serverId]);

  const saveEdit = useCallback(
    async (edited: Note): Promise<boolean> => {
      const changes = buildEditChanges(edited, form, new Date());
      if (!changes || !form.text.trim()) return false;
      if (changes.text === undefined && changes.wait === undefined) return true;
      const input: EditNoteOptions = { noteId: edited.id, ...changes };
      if (changes.wait !== undefined) {
        // A new time needs a new claim; any other change drops this device's reminder.
        input.localReminder =
          changes.wait?.type === "time" ? await claimLocalReminder(changes.wait.at) : null;
      }
      const saved = await editNote(serverId, input);
      void syncNoteLocalReminder(serverId, saved);
      return true;
    },
    [form, serverId],
  );

  const handleSave = useCallback(() => {
    void runAction("save", "notes.composer.errors.save", () => (note ? saveEdit(note) : saveNew()));
  }, [note, runAction, saveEdit, saveNew]);

  const handleToggleResolved = useCallback(() => {
    if (!note) return;
    void runAction("resolve", "notes.composer.errors.update", async () => {
      const saved = await editNote(serverId, { noteId: note.id, resolved: !note.resolvedAt });
      void syncNoteLocalReminder(serverId, saved);
      return true;
    });
  }, [note, runAction, serverId]);

  const handleDelete = useCallback(() => {
    if (!note) return;
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("notes.composer.deleteConfirm.title"),
        message: t("notes.composer.deleteConfirm.message"),
        confirmLabel: t("notes.composer.deleteConfirm.confirm"),
        cancelLabel: t("notes.composer.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) return;
      await runAction("delete", "notes.composer.errors.delete", async () => {
        await deleteNote(serverId, note.id);
        void cancelNoteLocalReminder(serverId, note.id);
        return true;
      });
    })();
  }, [note, runAction, serverId, t]);

  const header = useMemo<SheetHeader>(
    () => ({ title: note ? t("notes.composer.titleEdit") : t("notes.composer.titleNew") }),
    [note, t],
  );
  const canSave = pending === null && canSaveForm(form, now);
  const resolved = Boolean(note?.resolvedAt);
  const footer = useMemo(
    () => (
      <ComposerFooter
        editing={note !== null}
        resolved={resolved}
        pending={pending}
        canSave={canSave}
        onCancel={close}
        onSave={handleSave}
        onToggleResolved={handleToggleResolved}
        onDelete={handleDelete}
      />
    ),
    [canSave, close, handleDelete, handleSave, handleToggleResolved, note, pending, resolved],
  );

  const setText = useCallback((text: string) => setForm((prev) => ({ ...prev, text })), []);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={close}
      footer={footer}
      snapPoints={FULL_SHEET_SNAP_POINTS}
      testID="note-composer"
    >
      <View style={styles.body}>
        {quote ? <QuoteBlock quote={quote} monospace={anchor.kind === "terminal"} /> : null}
        <Field label={t("notes.composer.textLabel")}>
          <FormTextInput
            ref={textInputRef}
            size={controlSize}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            accessibilityLabel={t("notes.composer.textLabel")}
            placeholder={t("notes.composer.textPlaceholder")}
            initialValue={initialForm.text}
            onChangeText={setText}
            style={styles.textInput}
            testID="note-composer-text"
          />
        </Field>
        <WaitFields
          form={form}
          initialForm={initialForm}
          setForm={setForm}
          now={now}
          controlSize={controlSize}
          agents={agents}
          agentOptions={agentOptions}
          terminalOptions={terminals.options}
          terminalsLoading={terminals.loading}
        />
      </View>
    </AdaptiveModalSheet>
  );
}

interface ComposerFooterProps {
  editing: boolean;
  resolved: boolean;
  pending: PendingAction | null;
  canSave: boolean;
  onCancel: () => void;
  onSave: () => void;
  onToggleResolved: () => void;
  onDelete: () => void;
}

function ComposerFooter({
  editing,
  resolved,
  pending,
  canSave,
  onCancel,
  onSave,
  onToggleResolved,
  onDelete,
}: ComposerFooterProps) {
  const { t } = useTranslation();
  const busy = pending !== null;
  return (
    <View style={styles.footer}>
      {editing ? (
        <Button
          style={styles.footerButton}
          variant="ghost"
          size="md"
          onPress={onDelete}
          disabled={busy}
          loading={pending === "delete"}
          testID="note-composer-delete"
        >
          {t("notes.composer.actions.delete")}
        </Button>
      ) : null}
      {editing ? (
        <Button
          style={styles.footerButton}
          variant="secondary"
          size="md"
          onPress={onToggleResolved}
          disabled={busy}
          loading={pending === "resolve"}
          testID="note-composer-resolve"
        >
          {resolved ? t("notes.composer.actions.reopen") : t("notes.composer.actions.resolve")}
        </Button>
      ) : (
        <Button
          style={styles.footerButton}
          variant="secondary"
          size="md"
          onPress={onCancel}
          disabled={busy}
        >
          {t("notes.composer.actions.cancel")}
        </Button>
      )}
      <Button
        style={styles.footerButton}
        variant="default"
        size="md"
        onPress={onSave}
        disabled={!canSave}
        loading={pending === "save"}
        testID="note-composer-save"
      >
        {editing ? t("notes.composer.actions.save") : t("notes.composer.actions.add")}
      </Button>
    </View>
  );
}

function QuoteBlock({ quote, monospace }: { quote: string; monospace: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const collapsible =
    quote.length > QUOTE_COLLAPSE_CHARS || quote.split("\n").length > QUOTE_COLLAPSED_LINES;
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const text = (
    <Text
      style={monospace ? styles.quoteTextMono : styles.quoteText}
      numberOfLines={expanded ? undefined : QUOTE_COLLAPSED_LINES}
    >
      {quote}
    </Text>
  );
  if (!collapsible) {
    return (
      <View style={styles.quote} accessibilityLabel={t("notes.composer.quoteLabel")}>
        {text}
      </View>
    );
  }
  return (
    <PressHighlight
      style={styles.quote}
      onPress={toggle}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={t("notes.composer.quoteLabel")}
      testID="note-composer-quote"
    >
      {text}
      <Text style={styles.quoteToggle}>
        {expanded ? t("notes.composer.showLess") : t("notes.composer.showMore")}
      </Text>
    </PressHighlight>
  );
}

interface WaitFieldsProps {
  form: NoteComposerForm;
  initialForm: NoteComposerForm;
  setForm: SetForm;
  now: Date;
  controlSize: FieldControlSize;
  agents: HostAgents;
  agentOptions: SelectFieldOption<string>[];
  terminalOptions: SelectFieldOption<string>[];
  terminalsLoading: boolean;
}

/** Note | Waiting on, then the event to wait for and its details. */
function WaitFields({
  form,
  initialForm,
  setForm,
  now,
  controlSize,
  agents,
  agentOptions,
  terminalOptions,
  terminalsLoading,
}: WaitFieldsProps) {
  const { t } = useTranslation();
  const kindOptions = useMemo<SegmentedControlOption<"note" | "waiting">[]>(
    () => [
      { value: "note", label: t("notes.composer.kind.note") },
      { value: "waiting", label: t("notes.composer.kind.waiting") },
    ],
    [t],
  );
  // An event is offered when the host has something to watch, or the note already names one.
  const hasAgents = agentOptions.length > 0 || initialForm.agent !== null;
  const hasTerminals = terminalOptions.length > 0 || initialForm.terminal !== null;
  const eventOptions = useMemo<SegmentedControlOption<NoteWaitKind>[]>(() => {
    const options: SegmentedControlOption<NoteWaitKind>[] = [];
    if (hasAgents) options.push({ value: "agent", label: t("notes.composer.event.agent") });
    if (hasTerminals) options.push({ value: "command", label: t("notes.composer.event.command") });
    options.push({ value: "time", label: t("notes.composer.event.time") });
    return options;
  }, [hasAgents, hasTerminals, t]);
  const setKind = useCallback(
    (kind: "note" | "waiting") => setForm((prev) => ({ ...prev, waiting: kind === "waiting" })),
    [setForm],
  );
  const setWaitKind = useCallback(
    (waitKind: NoteWaitKind) => setForm((prev) => ({ ...prev, waitKind })),
    [setForm],
  );

  return (
    <>
      <Field label={t("notes.composer.kind.label")}>
        <SegmentedControl
          options={kindOptions}
          value={form.waiting ? "waiting" : "note"}
          onValueChange={setKind}
          size={controlSize}
          testID="note-composer-kind"
        />
      </Field>
      {form.waiting && eventOptions.length > 1 ? (
        <Field label={t("notes.composer.event.label")}>
          <SegmentedControl
            options={eventOptions}
            value={form.waitKind}
            onValueChange={setWaitKind}
            size={controlSize}
            testID="note-composer-event"
          />
        </Field>
      ) : null}
      {form.waiting && form.waitKind === "agent" ? (
        <AgentWaitField
          form={form}
          setForm={setForm}
          controlSize={controlSize}
          agents={agents}
          options={agentOptions}
        />
      ) : null}
      {form.waiting && form.waitKind === "command" ? (
        <CommandWaitFields
          form={form}
          setForm={setForm}
          controlSize={controlSize}
          options={terminalOptions}
          loading={terminalsLoading}
        />
      ) : null}
      {form.waiting && form.waitKind === "time" ? (
        <TimeWaitFields
          form={form}
          initialForm={initialForm}
          setForm={setForm}
          now={now}
          controlSize={controlSize}
        />
      ) : null}
    </>
  );
}

function AgentWaitField({
  form,
  setForm,
  controlSize,
  agents,
  options,
}: {
  form: NoteComposerForm;
  setForm: SetForm;
  controlSize: FieldControlSize;
  agents: HostAgents;
  options: SelectFieldOption<string>[];
}) {
  const { t } = useTranslation();
  const picked = form.agent;
  // A note saved without a title shows the agent's current one.
  const fallbackTitle = picked ? agents?.get(picked.id)?.title?.trim() : undefined;
  const untitled = t("notes.composer.agent.untitled");
  const selectedDisplay = useMemo<SelectFieldDisplay | null>(
    () => (picked ? { label: picked.label ?? (fallbackTitle || untitled) } : null),
    [fallbackTitle, picked, untitled],
  );
  const setAgent = useCallback(
    (id: string, display: SelectFieldDisplay) =>
      setForm((prev) => ({ ...prev, agent: { id, label: display.label } })),
    [setForm],
  );
  return (
    <SelectField
      label={t("notes.composer.agent.label")}
      value={picked?.id ?? null}
      selectedDisplay={selectedDisplay}
      options={options}
      onChange={setAgent}
      placeholder={t("notes.composer.agent.placeholder")}
      emptyText={t("notes.composer.agent.empty")}
      searchable
      searchPlaceholder={t("notes.composer.agent.search")}
      title={t("notes.composer.agent.label")}
      size={controlSize}
      triggerTestID="note-composer-agent"
    />
  );
}

function CommandWaitFields({
  form,
  setForm,
  controlSize,
  options,
  loading,
}: {
  form: NoteComposerForm;
  setForm: SetForm;
  controlSize: FieldControlSize;
  options: SelectFieldOption<string>[];
  loading: boolean;
}) {
  const { t } = useTranslation();
  const picked = form.terminal;
  const listedLabel = picked ? options.find((option) => option.id === picked.id)?.label : undefined;
  const untitled = t("notes.composer.command.untitled");
  const selectedDisplay = useMemo<SelectFieldDisplay | null>(
    () => (picked ? { label: picked.label ?? listedLabel ?? untitled } : null),
    [listedLabel, picked, untitled],
  );
  const conditionOptions = useMemo<SegmentedControlOption<NoteCommandCondition>[]>(
    () =>
      CONDITIONS.map((condition) => ({
        value: condition,
        label: t(`notes.composer.command.${condition}`),
      })),
    [t],
  );
  const setTerminal = useCallback(
    (id: string, display: SelectFieldDisplay) =>
      setForm((prev) => ({ ...prev, terminal: { id, label: display.label } })),
    [setForm],
  );
  const setCondition = useCallback(
    (condition: NoteCommandCondition) => setForm((prev) => ({ ...prev, condition })),
    [setForm],
  );
  const setCommand = useCallback(
    (command: string) => setForm((prev) => ({ ...prev, command })),
    [setForm],
  );
  return (
    <>
      <SelectField
        label={t("notes.composer.command.terminalLabel")}
        value={picked?.id ?? null}
        selectedDisplay={selectedDisplay}
        options={options}
        onChange={setTerminal}
        placeholder={t("notes.composer.command.placeholder")}
        emptyText={t("notes.composer.command.empty")}
        loading={loading}
        searchable
        searchPlaceholder={t("notes.composer.command.search")}
        title={t("notes.composer.command.terminalLabel")}
        size={controlSize}
        triggerTestID="note-composer-terminal"
      />
      <Text style={styles.mutedText}>{t("notes.composer.command.binding")}</Text>
      <Field label={t("notes.composer.command.conditionLabel")}>
        <SegmentedControl
          options={conditionOptions}
          value={form.condition}
          onValueChange={setCondition}
          size={controlSize}
          testID="note-composer-condition"
        />
      </Field>
      <Field label={t("notes.composer.command.commandLabel")}>
        <FormTextInput
          size={controlSize}
          accessibilityLabel={t("notes.composer.command.commandLabel")}
          placeholder={t("notes.composer.command.commandPlaceholder")}
          initialValue={form.command}
          onChangeText={setCommand}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.monoInput}
          testID="note-composer-command"
        />
      </Field>
    </>
  );
}

function formatResolvedTime(at: Date, now: Date, t: TFunction): string {
  const time = formatTimeOfDay(at);
  switch (reminderDay(at, now)) {
    case "today":
      return t("notes.composer.time.resolvedToday", { time });
    case "tomorrow":
      return t("notes.composer.time.resolvedTomorrow", { time });
    case "other": {
      const date = at.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      return t("notes.composer.time.resolvedOther", { date, time });
    }
  }
}

function TimeWaitFields({
  form,
  initialForm,
  setForm,
  now,
  controlSize,
}: {
  form: NoteComposerForm;
  initialForm: NoteComposerForm;
  setForm: SetForm;
  now: Date;
  controlSize: FieldControlSize;
}) {
  const { t } = useTranslation();
  const [inputResetKey, setInputResetKey] = useState(0);
  const resolved = resolveFormTime(form.time, now);
  const invalid = form.time.kind === "text" && !resolved;
  const setPreset = useCallback(
    (preset: ReminderPreset) => {
      setForm((prev) => ({ ...prev, time: { kind: "preset", preset } }));
      // Picking a preset clears the typed time so only one source shows as chosen.
      setInputResetKey((key) => key + 1);
    },
    [setForm],
  );
  const setTimeText = useCallback(
    (text: string) =>
      setForm((prev) => ({
        ...prev,
        // An emptied field falls back to what the form opened with (an edited note's time).
        time: text.trim() ? { kind: "text", text } : initialForm.time,
      })),
    [initialForm.time, setForm],
  );
  return (
    <>
      <Field label={t("notes.composer.time.label")}>
        <View style={styles.presets}>
          {REMINDER_PRESETS.map((preset) => (
            <PresetButton
              key={preset}
              preset={preset}
              selected={form.time.kind === "preset" && form.time.preset === preset}
              onPress={setPreset}
            />
          ))}
        </View>
      </Field>
      <Field
        label={t("notes.composer.time.inputLabel")}
        error={invalid ? t("notes.composer.time.invalid") : null}
      >
        <FormTextInput
          size={controlSize}
          accessibilityLabel={t("notes.composer.time.inputLabel")}
          placeholder={t("notes.composer.time.inputPlaceholder")}
          initialValue={form.time.kind === "text" ? form.time.text : ""}
          resetKey={inputResetKey}
          onChangeText={setTimeText}
          autoCapitalize="none"
          autoCorrect={false}
          testID="note-composer-time-input"
        />
      </Field>
      {resolved ? (
        <Text style={styles.resolvedTime} testID="note-composer-time-resolved">
          {formatResolvedTime(resolved, now, t)}
        </Text>
      ) : null}
    </>
  );
}

function PresetButton({
  preset,
  selected,
  onPress,
}: {
  preset: ReminderPreset;
  selected: boolean;
  onPress: (preset: ReminderPreset) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(preset), [onPress, preset]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <Button
      variant={selected ? "default" : "outline"}
      size="md"
      onPress={handlePress}
      accessibilityState={accessibilityState}
      testID={`note-composer-preset-${preset}`}
    >
      {t(`notes.composer.time.presets.${preset}`)}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
  },
  quote: {
    gap: theme.spacing[1],
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.borderAccent,
    paddingLeft: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  quoteText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  quoteTextMono: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  quoteToggle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  textInput: {
    minHeight: 88,
    textAlignVertical: "top",
  },
  monoInput: {
    fontFamily: theme.fontFamily.mono,
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  presets: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  resolvedTime: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  footerButton: {
    flex: 1,
  },
}));
