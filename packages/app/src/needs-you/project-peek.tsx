import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import type { AgentOpenQuestion, AgentQuestionAnswer } from "@getpaseo/protocol/messages";
import { PermissionRequestCard } from "@/agent-stream/view";
import { Button } from "@/components/ui/button";
import { MenuTextField } from "@/components/ui/menu";
import { resolveSendNowBehavior } from "@/composer/input/state";
import { useToast } from "@/contexts/toast-context";
import { useAppSettings } from "@/hooks/use-settings";
import { sendQuestionAnswers } from "@/questions/send-answers";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildNeedsYouRoute } from "@/utils/host-routes";
import type { NeedsYouChat } from "./model";
import { useNeedsYouChats } from "./use-needs-you";

/** One host's copy of a sidebar project. */
export interface PeekProjectHost {
  serverId: string;
  projectId: string;
}

interface PeekQuestionTarget {
  chat: NeedsYouChat;
  agentId: string;
  question: AgentOpenQuestion;
}

/** The waiting chats of one project, oldest first. Mount it only while the peek is open. */
function useProjectWaitingChats(hosts: readonly PeekProjectHost[]): NeedsYouChat[] {
  const chats = useNeedsYouChats();
  return useMemo(
    () =>
      chats.filter((chat) =>
        hosts.some((host) => host.serverId === chat.serverId && host.projectId === chat.projectId),
      ),
    [chats, hosts],
  );
}

function firstQuestion(chat: NeedsYouChat | undefined): PeekQuestionTarget | null {
  const group = chat?.questionGroups[0];
  const question = group?.questions[0];
  if (!chat || !group || !question) return null;
  return { chat, agentId: group.agentId, question };
}

/**
 * Peek (owner decision Q94): the oldest waiting chat of a project with its first question, to
 * answer from the rail or the chip without leaving the open chat. One tap on the pick sends it;
 * the field sends your own words. A permission box shows its own buttons.
 *
 * Sending stops the chat waiting, which would take the peek away mid-send. From the first send
 * until it unmounts the peek keeps the chat it is answering and tells its owner, through
 * `onHoldChange`, to keep it shown, so "Sent" stays readable.
 */
export function ProjectPeek({
  hosts,
  onHoldChange,
  testID,
}: {
  hosts: readonly PeekProjectHost[];
  onHoldChange?: (held: boolean) => void;
  testID: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const chats = useProjectWaitingChats(hosts);
  const [sentText, setSentText] = useState<string | null>(null);
  const [heldChat, setHeldChat] = useState<NeedsYouChat | null>(null);
  const chat = heldChat ?? chats[0];
  const more = chats.filter((entry) => entry.workspaceId !== chat?.workspaceId).length;
  const handleSending = useCallback(() => setHeldChat(chat ?? null), [chat]);
  const handleOpen = useCallback(() => {
    if (chat) navigateToWorkspace({ serverId: chat.serverId, workspaceId: chat.workspaceId });
  }, [chat]);
  const handleMore = useCallback(() => router.push(buildNeedsYouRoute()), []);
  const held = heldChat !== null;
  useEffect(() => {
    if (!held || !onHoldChange) return;
    onHoldChange(true);
    return () => onHoldChange(false);
  }, [held, onHoldChange]);

  if (sentText !== null) {
    return (
      <View style={styles.container} testID={testID}>
        <Text style={styles.sent} testID={`${testID}-sent`}>
          {t("needsYou.peek.sent", { answer: sentText })}
        </Text>
      </View>
    );
  }
  if (!chat) return null;
  const target = firstQuestion(chat);
  return (
    <View style={styles.container} testID={testID}>
      <Text style={styles.heading} numberOfLines={1}>
        {`${chat.projectName} · ${chat.title}`}
      </Text>
      <PeekBody
        chat={chat}
        target={target}
        onSending={handleSending}
        onSent={setSentText}
        testID={testID}
      />
      <View style={styles.footer}>
        {more > 0 ? (
          <Button variant="ghost" size="sm" onPress={handleMore} testID={`${testID}-more`}>
            {t("needsYou.peek.more", { count: more })}
          </Button>
        ) : (
          <View />
        )}
        <Button variant="ghost" size="sm" onPress={handleOpen} testID={`${testID}-open`}>
          {t("needsYou.peek.openChat")}
        </Button>
      </View>
    </View>
  );
}

function PeekBody({
  chat,
  target,
  onSending,
  onSent,
  testID,
}: {
  chat: NeedsYouChat;
  target: PeekQuestionTarget | null;
  onSending: () => void;
  onSent: (text: string) => void;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(chat.serverId);
  const permission = chat.permissions[0];
  if (target) {
    return (
      <PeekQuestion
        key={target.question.id}
        target={target}
        onSending={onSending}
        onSent={onSent}
        testID={testID}
      />
    );
  }
  if (permission) return <PermissionRequestCard permission={permission} client={client} />;
  return <Text style={styles.meta}>{t("needsYou.answerInChat")}</Text>;
}

function PeekQuestion({
  target,
  onSending,
  onSent,
  testID,
}: {
  target: PeekQuestionTarget;
  onSending: () => void;
  onSent: (text: string) => void;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { settings } = useAppSettings();
  const { chat, agentId, question } = target;
  const typedRef = useRef("");
  const [typed, setTyped] = useState(false);
  const [sending, setSending] = useState(false);
  const heading = question.label ? `${question.label} · ${question.title}` : question.title;

  const send = useCallback(
    (answer: Omit<AgentQuestionAnswer, "updatedAt">, shown: string) => {
      const client = getHostRuntimeStore().getClient(chat.serverId);
      if (!client) return;
      setSending(true);
      onSending();
      const full: AgentQuestionAnswer = { ...answer, updatedAt: Date.now() };
      void sendQuestionAnswers({
        client,
        serverId: chat.serverId,
        agentId,
        questions: [question],
        answerFor: () => full,
        activeTurnBehavior: resolveSendNowBehavior(settings),
      })
        .then((sent) => {
          if (sent) onSent(shown);
          return sent;
        })
        .catch(() => toast.error(t("needsYou.sendFailed", { title: chat.title })))
        .finally(() => setSending(false));
    },
    [agentId, chat.serverId, chat.title, onSending, onSent, question, settings, t, toast],
  );
  const handlePick = useCallback(
    () => send({ pick: true, text: "", files: [] }, question.pick ?? t("questions.yes")),
    [question.pick, send, t],
  );
  const handleChangeText = useCallback((text: string) => {
    typedRef.current = text;
    setTyped(text.trim().length > 0);
  }, []);
  const handleSendText = useCallback(() => {
    const text = typedRef.current.trim();
    if (text) send({ pick: false, text, files: [] }, text);
  }, [send]);

  return (
    <View style={styles.question}>
      <Text style={styles.title}>{heading}</Text>
      {question.body ? (
        <Text style={styles.body} numberOfLines={6}>
          {question.body}
        </Text>
      ) : null}
      {question.pick ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={sending}
          onPress={handlePick}
          testID={`${testID}-pick`}
        >
          {`➡️ ${question.pick}`}
        </Button>
      ) : null}
      <View style={styles.ownRow}>
        <View style={styles.ownField}>
          <MenuTextField
            onChangeText={handleChangeText}
            onSubmitEditing={handleSendText}
            placeholder={t("questions.ownPlaceholder")}
            editable={!sending}
            testID={`${testID}-text`}
          />
        </View>
        <Button
          variant="default"
          size="sm"
          disabled={!typed}
          loading={sending}
          onPress={handleSendText}
          testID={`${testID}-send`}
        >
          {t("needsYou.peek.send")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    width: "100%",
    maxWidth: 360,
  },
  heading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  question: {
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  body: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  ownRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  ownField: {
    flex: 1,
    minWidth: 0,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  sent: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.base,
  },
}));
