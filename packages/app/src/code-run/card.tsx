import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleX,
  Copy,
  Eye,
  EyeOff,
  Play,
  RotateCcw,
  Send,
  SquareTerminal,
  X,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { markdownCopyDataSet } from "@/assistant-selection-copy/markup";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { isNative } from "@/constants/platform";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { shortenPath } from "@/utils/shorten-path";
import {
  commandRisk,
  formatRunDuration,
  formatRunReport,
  readRunPrompt,
  type RunPrompt,
} from "./command";
import { revealField } from "./reveal";
import {
  answerCodeRun,
  interruptCodeRun,
  observeCodeRun,
  pressCodeRunKey,
  rerunCodeRun,
  startCodeRun,
  type CodeRunClient,
} from "./runner";
import { useCodeRunComposerInsert, type CodeRunScope } from "./scope";
import {
  forgetCodeRun,
  setCodeRunLive,
  useCodeRunStore,
  type CodeRunLive,
  type CodeRunRecord,
} from "./store";

const EMPTY_LINES: readonly string[] = [];
const COPIED_RESET_MS = 1500;
/** Within this distance of the end, new output keeps the view pinned to the bottom. */
const PINNED_SLOP = 16;

const MutedX = withUnistyles(X, mutedIconColorMapping);
const MutedCopy = withUnistyles(Copy, mutedIconColorMapping);
const MutedCheck = withUnistyles(Check, mutedIconColorMapping);
const MutedEye = withUnistyles(Eye, mutedIconColorMapping);
const MutedEyeOff = withUnistyles(EyeOff, mutedIconColorMapping);
const MutedChevronDown = withUnistyles(ChevronDown, mutedIconColorMapping);
const MutedChevronRight = withUnistyles(ChevronRight, mutedIconColorMapping);
const SuccessIcon = withUnistyles(CircleCheck, (theme) => ({ color: theme.colors.statusSuccess }));
const FailureIcon = withUnistyles(CircleX, (theme) => ({ color: theme.colors.statusDanger }));
const RunningIcon = withUnistyles(CircleDot, mutedIconColorMapping);

const STATUS_ICON = {
  running: <RunningIcon size={12} />,
  done: <SuccessIcon size={12} />,
  failed: <FailureIcon size={12} />,
};

interface CodeRunCardProps {
  runKey: string;
  scope: CodeRunScope;
  command: string;
  /** Called after the card's run is forgotten, so the fence can fold the card away. */
  onClose: () => void;
}

/** Inline card under a shell fence: confirm the command, then follow and answer its run. */
export function CodeRunCard({ runKey, scope, command, onClose }: CodeRunCardProps) {
  const record = useCodeRunStore((state) => state.records[runKey]);
  const client = useSessionStore((state) => state.sessions[scope.serverId]?.client ?? null);
  return (
    <View style={styles.card} dataSet={markdownCopyDataSet.ignore} testID="code-run-card">
      {record ? (
        <RunSession
          runKey={runKey}
          scope={scope}
          record={record}
          client={client}
          onClose={onClose}
        />
      ) : (
        <RunDraft
          runKey={runKey}
          scope={scope}
          command={command}
          client={client}
          onClose={onClose}
        />
      )}
    </View>
  );
}

/** "Runs as admin" and similar: a quiet warning next to a command, never an extra tap. */
export function CommandRiskLabel({ command }: { command: string }) {
  const { t } = useTranslation();
  const risk = commandRisk(command);
  if (risk === null) return null;
  const label = risk === "admin" ? t("codeRun.risk.admin") : t("codeRun.risk.deletes");
  return (
    <Text style={styles.risk} testID="code-run-risk">
      {label}
    </Text>
  );
}

interface RunDraftProps {
  runKey: string;
  scope: CodeRunScope;
  command: string;
  client: CodeRunClient | null;
  onClose: () => void;
}

function RunDraft({ runKey, scope, command, client, onClose }: RunDraftProps) {
  const { t } = useTranslation();
  const input = useRef<EditingTextInputHandle>(null);
  const live = useCodeRunStore((state) => state.live[runKey]);
  const connected = useHostRuntimeIsConnected(scope.serverId);
  const hostLabel = useHosts().find((host) => host.serverId === scope.serverId)?.label;
  const [draft, setDraft] = useState(command);
  const starting = live?.kind === "starting";
  const run = useCallback(() => {
    const edited = draft.trim();
    if (!client || edited === "") return;
    startCodeRun({ client, scope, key: runKey, command: edited }).catch((error: unknown) => {
      console.error("Unable to start code run", error);
      setCodeRunLive(runKey, { kind: "startFailed" });
    });
  }, [client, draft, runKey, scope]);
  const cancel = useCallback(() => {
    forgetCodeRun(runKey);
    onClose();
  }, [onClose, runKey]);
  return (
    <>
      <Text style={styles.where} numberOfLines={1} ellipsizeMode="middle" testID="code-run-where">
        {t("codeRun.where", {
          host: hostLabel ?? scope.serverId,
          folder: shortenPath(scope.cwd),
        })}
      </Text>
      <FormTextInput
        ref={input}
        initialValue={command}
        onChangeText={setDraft}
        multiline
        size="sm"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        accessibilityLabel={t("codeRun.commandLabel")}
        style={styles.commandInput}
        testID="code-run-command"
      />
      <CommandRiskLabel command={draft} />
      {live?.kind === "startFailed" ? (
        <Text style={styles.error}>{t("codeRun.startFailed")}</Text>
      ) : null}
      {connected ? null : <Text style={styles.hint}>{t("codeRun.hostOffline")}</Text>}
      <View style={styles.confirmRow}>
        <Button variant="ghost" size="md" onPress={cancel} testID="code-run-cancel">
          {t("codeRun.cancel")}
        </Button>
        <Button
          variant="default"
          size="md"
          leftIcon={Play}
          loading={starting}
          disabled={!connected || !client || draft.trim() === ""}
          onPress={run}
          style={styles.confirmButton}
          testID="code-run-confirm"
        >
          {t("codeRun.run")}
        </Button>
      </View>
    </>
  );
}

interface RunSessionProps {
  runKey: string;
  scope: CodeRunScope;
  record: CodeRunRecord;
  client: CodeRunClient | null;
  onClose: () => void;
}

type CloseState = { kind: "idle" } | { kind: "closing" } | { kind: "failed" };

function RunSession({ runKey, scope, record, client, onClose }: RunSessionProps) {
  const { t } = useTranslation();
  const live = useCodeRunStore((state) => state.live[runKey]);
  const insert = useCodeRunComposerInsert();
  const [closeState, setCloseState] = useState<CloseState>({ kind: "idle" });
  const terminalClosed = live?.kind === "terminalClosed";
  const running = record.exitCode === null && !record.stopped && !terminalClosed;
  const status = runStatus(record, live);
  // A successful run folds to its status line; anything else stays open to read.
  const [expanded, setExpanded] = useState(status.kind !== "exited" || status.exitCode !== 0);
  const lines = outputLines(live);
  useRunObservation({ runKey, serverId: scope.serverId, record, client, enabled: !terminalClosed });

  const { openTerminal: openWorkspaceTerminal } = scope;
  const openTerminal = useCallback(() => {
    openWorkspaceTerminal({ workspaceId: record.workspaceId, terminalId: record.terminalId });
  }, [openWorkspaceTerminal, record.terminalId, record.workspaceId]);

  const close = useCallback(async () => {
    if (!terminalClosed) {
      if (!client) return;
      setCloseState({ kind: "closing" });
      try {
        await client.killTerminal(record.terminalId);
      } catch (error) {
        console.error("Unable to close code run terminal", error);
        setCloseState({ kind: "failed" });
        return;
      }
    }
    forgetCodeRun(runKey);
    onClose();
  }, [client, onClose, record.terminalId, runKey, terminalClosed]);

  const rerun = useCallback(() => {
    if (!client) return;
    setExpanded(true);
    rerunCodeRun(client, runKey, record);
  }, [client, record, runKey]);

  const sendToAgent = useCallback(() => {
    insert?.(
      formatRunReport({
        command: record.command,
        output: lines,
        exitCode: record.exitCode,
        labels: {
          exitStatus: t("codeRun.report.exitStatus"),
          stopped: t("codeRun.report.stopped"),
          truncated: t("codeRun.report.truncated"),
        },
      }),
    );
  }, [insert, lines, record.command, record.exitCode, t]);

  const toggleExpanded = useCallback(() => setExpanded((open) => !open), []);
  const collapsible = !running;
  return (
    <>
      <View style={styles.header}>
        <StatusLine
          status={status}
          expanded={expanded}
          collapsible={collapsible}
          onToggle={toggleExpanded}
        />
        <View style={styles.headerActions}>
          <Button
            variant="ghost"
            size="xs"
            leftIcon={SquareTerminal}
            disabled={terminalClosed}
            onPress={openTerminal}
            testID="code-run-open-terminal"
          >
            {t("codeRun.openTerminal")}
          </Button>
          <ToolbarButton
            label={t("codeRun.close")}
            onPress={close}
            disabled={closeState.kind === "closing"}
            testID="code-run-close"
          >
            <MutedX size={14} />
          </ToolbarButton>
        </View>
      </View>
      {expanded ? <RunOutput lines={lines} running={running} /> : null}
      {closeState.kind === "failed" ? (
        <Text style={styles.error}>{t("codeRun.closeFailed")}</Text>
      ) : null}
      {running ? (
        <RunControls runKey={runKey} record={record} client={client} lines={lines} />
      ) : null}
      {!running && expanded ? (
        <View style={styles.finishRow}>
          <Button
            variant="outline"
            size="sm"
            leftIcon={RotateCcw}
            disabled={terminalClosed || !client}
            onPress={rerun}
            testID="code-run-rerun"
          >
            {t("codeRun.rerun")}
          </Button>
          {insert ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={Send}
              onPress={sendToAgent}
              style={styles.flexButton}
              testID="code-run-send"
            >
              {t("codeRun.sendToAgent")}
            </Button>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

interface StatusLineProps {
  status: RunStatus;
  expanded: boolean;
  collapsible: boolean;
  onToggle: () => void;
}

function StatusLine({ status, expanded, collapsible, onToggle }: StatusLineProps) {
  const { t } = useTranslation();
  const badge = (
    <StatusBadge
      size="xs"
      label={statusLabel(status, t)}
      variant={statusVariant(status)}
      leading={statusIcon(status)}
    />
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  if (!collapsible) return <View style={styles.status}>{badge}</View>;
  return (
    <PressHighlight
      onPress={onToggle}
      style={styles.status}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={expanded ? t("codeRun.collapse") : t("codeRun.expand")}
      testID="code-run-status"
    >
      {expanded ? <MutedChevronDown size={14} /> : <MutedChevronRight size={14} />}
      {badge}
    </PressHighlight>
  );
}

/** Scrollable tail of the run. Follows new output unless the reader scrolled up. */
function RunOutput({ lines, running }: { lines: readonly string[]; running: boolean }) {
  const { t } = useTranslation();
  const scroll = useRef<ScrollView>(null);
  const pinned = useRef(true);
  const [copied, setCopied] = useState(false);
  const resetCopied = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetCopied.current), []);
  const trackPinned = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    pinned.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - PINNED_SLOP;
  }, []);
  const followOutput = useCallback(() => {
    if (pinned.current) scroll.current?.scrollToEnd({ animated: false });
  }, []);
  const copyOutput = useCallback(async () => {
    await Clipboard.setStringAsync(lines.join("\n"));
    setCopied(true);
    clearTimeout(resetCopied.current);
    resetCopied.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, [lines]);
  const empty = running ? t("codeRun.noOutput") : t("codeRun.noOutputFinished");
  return (
    <View style={styles.outputBox}>
      <ScrollView
        ref={scroll}
        style={styles.outputScroll}
        nestedScrollEnabled
        onScroll={trackPinned}
        scrollEventThrottle={64}
        onContentSizeChange={followOutput}
      >
        <Text style={styles.output} selectable testID="code-run-output">
          {lines.length > 0 ? lines.join("\n") : empty}
        </Text>
      </ScrollView>
      {lines.length > 0 ? (
        <View style={styles.outputCopy}>
          <ToolbarButton
            label={copied ? t("codeRun.copied") : t("codeRun.copyOutput")}
            onPress={copyOutput}
            testID="code-run-copy-output"
          >
            {copied ? <MutedCheck size={14} /> : <MutedCopy size={14} />}
          </ToolbarButton>
        </View>
      ) : null}
    </View>
  );
}

interface RunControlsProps {
  runKey: string;
  record: CodeRunRecord;
  client: CodeRunClient | null;
  lines: readonly string[];
}

/** Everything a running command can be asked for: an answer, a quick choice, or a key. */
function RunControls({ runKey, record, client, lines }: RunControlsProps) {
  const { t } = useTranslation();
  const prompt = readRunPrompt(lines);
  const answer = useCallback(
    (text: string) => {
      if (client) answerCodeRun(client, record, text);
    },
    [client, record],
  );
  const pressEnter = useCallback(() => {
    if (client) pressCodeRunKey(client, record, "enter");
  }, [client, record]);
  const pressTab = useCallback(() => {
    if (client) pressCodeRunKey(client, record, "tab");
  }, [client, record]);
  const interrupt = useCallback(() => {
    if (client) interruptCodeRun(client, runKey, record);
  }, [client, record, runKey]);
  const answerYes = useCallback(() => answer("y"), [answer]);
  const answerNo = useCallback(() => answer("n"), [answer]);
  return (
    <>
      {prompt?.kind === "confirm" ? (
        <View style={styles.chips}>
          <Button variant="secondary" size="sm" onPress={answerYes} testID="code-run-chip-yes">
            {t("codeRun.chips.yes")}
          </Button>
          <Button variant="secondary" size="sm" onPress={answerNo} testID="code-run-chip-no">
            {t("codeRun.chips.no")}
          </Button>
          <Button variant="outline" size="sm" onPress={pressEnter} testID="code-run-chip-enter">
            {t("codeRun.keys.enter")}
          </Button>
        </View>
      ) : (
        <AnswerField key={prompt?.kind ?? "input"} prompt={prompt} onAnswer={answer} />
      )}
      <View style={styles.keyRow}>
        <Button variant="ghost" size="xs" onPress={pressEnter} testID="code-run-key-enter">
          {t("codeRun.keys.enter")}
        </Button>
        <Button variant="ghost" size="xs" onPress={pressTab} testID="code-run-key-tab">
          {t("codeRun.keys.tab")}
        </Button>
        <Button variant="outline" size="xs" onPress={interrupt} testID="code-run-stop">
          {t("codeRun.keys.interrupt")}
        </Button>
      </View>
    </>
  );
}

interface AnswerFieldProps {
  prompt: RunPrompt;
  /** Receives the typed line once; the field clears itself and keeps no copy. */
  onAnswer: (text: string) => void;
}

function AnswerField({ prompt, onAnswer }: AnswerFieldProps) {
  const { t } = useTranslation();
  const input = useRef<EditingTextInputHandle>(null);
  const [revealed, setRevealed] = useState(false);
  const secret = prompt?.kind === "password";
  const send = useCallback(() => {
    const field = input.current;
    if (!field) return;
    onAnswer(field.getText());
    field.reset();
  }, [onAnswer]);
  const reveal = useCallback(() => {
    if (input.current) revealField(input.current);
  }, []);
  const toggleRevealed = useCallback(() => setRevealed((shown) => !shown), []);
  let label: string | null = null;
  if (prompt?.kind === "password")
    label = prompt.sudo ? t("codeRun.prompt.sudoPassword") : t("codeRun.prompt.password");
  const placeholder = label ?? t("codeRun.answerPlaceholder");
  return (
    <View style={styles.answer}>
      {label ? <Text style={styles.answerLabel}>{label}</Text> : null}
      <View style={styles.answerRow}>
        <FormTextInput
          ref={input}
          size="sm"
          placeholder={placeholder}
          accessibilityLabel={placeholder}
          autoFocus={secret}
          onFocus={reveal}
          secureTextEntry={secret && !revealed}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          importantForAutofill="no"
          textContentType="none"
          keyboardType={secret ? "default" : "visible-password"}
          blurOnSubmit={false}
          returnKeyType="send"
          onSubmitEditing={send}
          style={styles.answerInput}
          testID="code-run-answer"
        />
        {secret ? (
          <ToolbarButton
            label={revealed ? t("codeRun.hidePassword") : t("codeRun.showPassword")}
            onPress={toggleRevealed}
            testID="code-run-reveal"
          >
            {revealed ? <MutedEyeOff size={16} /> : <MutedEye size={16} />}
          </ToolbarButton>
        ) : null}
        <Button variant="secondary" size="sm" onPress={send} testID="code-run-answer-send">
          {t("codeRun.send")}
        </Button>
      </View>
    </View>
  );
}

/** Follows the terminal only while the card is on screen, its panel is shown and the app is in front. */
function useRunObservation(input: {
  runKey: string;
  serverId: string;
  record: CodeRunRecord;
  client: CodeRunClient | null;
  enabled: boolean;
}) {
  const { runKey, serverId, record, client, enabled } = input;
  const appVisible = useAppVisible();
  const panelActive = useRetainedPanelActive();
  const connected = useHostRuntimeIsConnected(serverId);
  const liveRestore = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.["terminal-restore-modes"] === true,
  );
  const { terminalId, nonce } = record;
  const active = enabled && appVisible && panelActive && connected && client !== null;
  useEffect(() => {
    if (!active || !client) return;
    return observeCodeRun({
      client,
      key: runKey,
      record: { terminalId, nonce },
      liveRestore,
      onFinish: signalFinish,
    });
  }, [active, client, liveRestore, nonce, runKey, terminalId]);
}

function signalFinish(exitCode: number) {
  if (!isNative) return;
  const feedback =
    exitCode === 0
      ? Haptics.NotificationFeedbackType.Success
      : Haptics.NotificationFeedbackType.Error;
  void Haptics.notificationAsync(feedback).catch(() => {});
}

function outputLines(live: CodeRunLive | undefined): readonly string[] {
  if (live?.kind === "output" || live?.kind === "terminalClosed") return live.lines;
  return EMPTY_LINES;
}

type RunStatus =
  | { kind: "running" }
  | { kind: "exited"; exitCode: number; durationSeconds: number | null }
  | { kind: "stopped" }
  | { kind: "terminalClosed" };

function runStatus(record: CodeRunRecord, live: CodeRunLive | undefined): RunStatus {
  if (record.exitCode !== null)
    return { kind: "exited", exitCode: record.exitCode, durationSeconds: record.durationSeconds };
  if (record.stopped) return { kind: "stopped" };
  if (live?.kind === "terminalClosed") return { kind: "terminalClosed" };
  return { kind: "running" };
}

function statusVariant(status: RunStatus): StatusBadgeVariant {
  if (status.kind !== "exited") return "muted";
  return status.exitCode === 0 ? "success" : "error";
}

function statusIcon(status: RunStatus) {
  if (status.kind === "running") return STATUS_ICON.running;
  if (status.kind !== "exited") return null;
  return status.exitCode === 0 ? STATUS_ICON.done : STATUS_ICON.failed;
}

function statusLabel(status: RunStatus, t: TFunction): string {
  switch (status.kind) {
    case "running":
      return t("codeRun.running");
    case "exited": {
      const label =
        status.exitCode === 0
          ? t("codeRun.done", { code: status.exitCode })
          : t("codeRun.failed", { code: status.exitCode });
      return status.durationSeconds === null
        ? label
        : `${label} · ${formatRunDuration(status.durationSeconds)}`;
    }
    case "stopped":
      return t("codeRun.stopped");
    case "terminalClosed":
      return t("codeRun.terminalClosed");
  }
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginTop: theme.spacing[2],
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  where: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  risk: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
    minHeight: 32,
    borderRadius: theme.borderRadius.md,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  confirmRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  confirmButton: {
    flex: 1,
  },
  finishRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  flexButton: {
    flex: 1,
  },
  commandInput: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    height: "auto",
    minHeight: 44,
  },
  outputBox: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  outputScroll: {
    maxHeight: 280,
  },
  output: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: Math.round(theme.fontSize.code * 1.45),
    color: theme.colors.foreground,
    padding: theme.spacing[2],
    paddingRight: theme.spacing[8],
  },
  outputCopy: {
    position: "absolute",
    top: theme.spacing[1],
    right: theme.spacing[1],
  },
  chips: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  keyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  answer: {
    gap: theme.spacing[1],
  },
  answerLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  answerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  answerInput: {
    flex: 1,
    fontFamily: theme.fontFamily.mono,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
