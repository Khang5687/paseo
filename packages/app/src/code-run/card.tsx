import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Play, Send, Square, SquareTerminal, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { markdownCopyDataSet } from "@/assistant-selection-copy/markup";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { formatRunReport, isPasswordPrompt } from "./command";
import {
  answerCodeRun,
  interruptCodeRun,
  observeCodeRun,
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

/** The card shows the tail; the full scrollback is one tap away in the terminal tab. */
const VISIBLE_OUTPUT_LINES = 24;
const EMPTY_LINES: readonly string[] = [];

const CloseIcon = withUnistyles(X, mutedIconColorMapping);
const ThemedSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const RUNNING_SPINNER = <ThemedSpinner size="small" />;

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
  const starting = live?.kind === "starting";
  const run = useCallback(() => {
    const edited = input.current?.getText().trim() ?? command;
    if (!client || edited === "") return;
    startCodeRun({ client, scope, key: runKey, command: edited }).catch((error: unknown) => {
      console.error("Unable to start code run", error);
      setCodeRunLive(runKey, { kind: "startFailed" });
    });
  }, [client, command, runKey, scope]);
  const cancel = useCallback(() => {
    forgetCodeRun(runKey);
    onClose();
  }, [onClose, runKey]);
  return (
    <>
      <FormTextInput
        ref={input}
        initialValue={command}
        multiline
        size="sm"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        accessibilityLabel={t("codeRun.commandLabel")}
        style={styles.commandInput}
        testID="code-run-command"
      />
      {live?.kind === "startFailed" ? (
        <Text style={styles.error}>{t("codeRun.startFailed")}</Text>
      ) : null}
      {connected ? null : <Text style={styles.hint}>{t("codeRun.hostOffline")}</Text>}
      <View style={styles.actions}>
        <Button variant="ghost" size="xs" onPress={cancel}>
          {t("codeRun.cancel")}
        </Button>
        <Button
          variant="default"
          size="xs"
          leftIcon={Play}
          loading={starting}
          disabled={!connected || !client}
          onPress={run}
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
  const lines = outputLines(live);
  const awaitingPassword = running && isPasswordPrompt(lines);
  useRunObservation({ runKey, serverId: scope.serverId, record, client, enabled: !terminalClosed });

  const { openTerminal: openWorkspaceTerminal } = scope;
  const openTerminal = useCallback(() => {
    openWorkspaceTerminal({ workspaceId: record.workspaceId, terminalId: record.terminalId });
  }, [openWorkspaceTerminal, record.terminalId, record.workspaceId]);

  const stop = useCallback(() => {
    if (client) interruptCodeRun(client, runKey, record);
  }, [client, record, runKey]);

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

  const status = runStatus(record, live);
  const visibleLines = lines.slice(-VISIBLE_OUTPUT_LINES);
  return (
    <>
      <View style={styles.header}>
        <StatusBadge
          size="xs"
          label={statusLabel(status, t)}
          variant={statusVariant(status)}
          leading={status.kind === "running" ? RUNNING_SPINNER : null}
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
          >
            <CloseIcon size={14} />
          </ToolbarButton>
        </View>
      </View>
      {lines.length > VISIBLE_OUTPUT_LINES ? (
        <Text style={styles.hint}>{t("codeRun.lastLines", { lines: VISIBLE_OUTPUT_LINES })}</Text>
      ) : null}
      <Text style={styles.output} selectable testID="code-run-output">
        {visibleLines.length > 0 ? visibleLines.join("\n") : t("codeRun.noOutput")}
      </Text>
      {closeState.kind === "failed" ? (
        <Text style={styles.error}>{t("codeRun.closeFailed")}</Text>
      ) : null}
      {running ? (
        <RunInput record={record} client={client} secure={awaitingPassword} onStop={stop} />
      ) : null}
      {!running && insert ? (
        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="xs"
            leftIcon={Send}
            onPress={sendToAgent}
            testID="code-run-send"
          >
            {t("codeRun.sendToAgent")}
          </Button>
        </View>
      ) : null}
    </>
  );
}

interface RunInputProps {
  record: CodeRunRecord;
  client: CodeRunClient | null;
  /** Masks the field and keeps the keyboard from learning what is typed. */
  secure: boolean;
  onStop: () => void;
}

function RunInput({ record, client, secure, onStop }: RunInputProps) {
  const { t } = useTranslation();
  const input = useRef<EditingTextInputHandle>(null);
  const send = useCallback(() => {
    const field = input.current;
    if (!client || !field) return;
    answerCodeRun(client, record, field.getText());
    field.reset();
  }, [client, record]);
  const placeholder = secure ? t("codeRun.passwordPlaceholder") : t("codeRun.answerPlaceholder");
  return (
    <View style={styles.inputRow}>
      <FormTextInput
        ref={input}
        size="xs"
        placeholder={placeholder}
        accessibilityLabel={placeholder}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        importantForAutofill="no"
        keyboardType={secure ? "default" : "visible-password"}
        blurOnSubmit={false}
        returnKeyType="send"
        onSubmitEditing={send}
        style={styles.answerInput}
        testID="code-run-answer"
      />
      <Button variant="secondary" size="xs" onPress={send}>
        {t("codeRun.send")}
      </Button>
      <Button variant="outline" size="xs" leftIcon={Square} onPress={onStop} testID="code-run-stop">
        {t("codeRun.stop")}
      </Button>
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
    return observeCodeRun({ client, key: runKey, record: { terminalId, nonce }, liveRestore });
  }, [active, client, liveRestore, nonce, runKey, terminalId]);
}

function outputLines(live: CodeRunLive | undefined): readonly string[] {
  if (live?.kind === "output" || live?.kind === "terminalClosed") return live.lines;
  return EMPTY_LINES;
}

type RunStatus =
  | { kind: "running" }
  | { kind: "exited"; exitCode: number }
  | { kind: "stopped" }
  | { kind: "terminalClosed" };

function runStatus(record: CodeRunRecord, live: CodeRunLive | undefined): RunStatus {
  if (record.exitCode !== null) return { kind: "exited", exitCode: record.exitCode };
  if (record.stopped) return { kind: "stopped" };
  if (live?.kind === "terminalClosed") return { kind: "terminalClosed" };
  return { kind: "running" };
}

function statusVariant(status: RunStatus): StatusBadgeVariant {
  if (status.kind !== "exited") return "muted";
  return status.exitCode === 0 ? "success" : "error";
}

function statusLabel(status: RunStatus, t: TFunction): string {
  switch (status.kind) {
    case "running":
      return t("codeRun.running");
    case "exited":
      return t("codeRun.exited", { code: status.exitCode });
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  commandInput: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    height: "auto",
    minHeight: 32,
  },
  output: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: Math.round(theme.fontSize.code * 1.45),
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
  },
  inputRow: {
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
