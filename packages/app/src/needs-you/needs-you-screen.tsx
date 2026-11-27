import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "expo-router/react-navigation";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type {
  ActiveTurnBehavior,
  AgentOpenQuestion,
  AgentQuestionAnswer,
} from "@getpaseo/protocol/messages";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PermissionRequestCard } from "@/agent-stream/view";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { resolveSendNowBehavior } from "@/composer/input/state";
import { useToast } from "@/contexts/toast-context";
import { useAppSettings } from "@/hooks/use-settings";
import { PluginNeedsYouItems, usePluginNeedsYouCount } from "@/plugins/needs-you-items";
import {
  buildAnswerMessage,
  buildCopyAnswersText,
  isQuestionAnswered,
  resolveAnswer,
} from "@/questions/answer-message";
import { questionAnswerScopeKey, useQuestionAnswerStore } from "@/questions/answer-store";
import { CopyAnswersButton } from "@/questions/copy-answers-button";
import { QuestionCard } from "@/questions/question-card";
import { sendQuestionAnswers } from "@/questions/send-answers";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { formatCompactTimeAgo } from "@/utils/time";
import type { NeedsYouChat } from "./model";
import { useNeedsYouChats } from "./use-needs-you";

type AnswerFor = (
  serverId: string,
  agentId: string,
  question: AgentOpenQuestion,
) => AgentQuestionAnswer | undefined;

/** The answer a card shows: this device's newer half answer, else the host's. */
function useAnswerFor(): AnswerFor {
  const local = useQuestionAnswerStore((state) => state.answers);
  return useCallback(
    (serverId, agentId, question) =>
      resolveAnswer(
        local[questionAnswerScopeKey(serverId, agentId)]?.[question.id],
        question.answer,
      ),
    [local],
  );
}

function countAnswers(chats: readonly NeedsYouChat[], answerFor: AnswerFor) {
  let total = 0;
  let answered = 0;
  for (const chat of chats) {
    for (const group of chat.questionGroups) {
      for (const question of group.questions) {
        total += 1;
        if (isQuestionAnswered(answerFor(chat.serverId, group.agentId, question))) answered += 1;
      }
    }
  }
  return { total, answered };
}

/**
 * Needs you (owner decisions Q91, Q98, Q107): every chat waiting on the owner, the longest
 * waiting first, with the cards to answer it here. One Send sends each chat its own answers.
 */
export function NeedsYouScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) return <View style={styles.container} />;
  return <NeedsYouScreenContent />;
}

function NeedsYouScreenContent(): ReactElement {
  const { t } = useTranslation();
  const chats = useNeedsYouChats();
  const pluginCount = usePluginNeedsYouCount();
  const answerFor = useAnswerFor();
  const { total, answered } = useMemo(() => countAnswers(chats, answerFor), [answerFor, chats]);
  const empty = chats.length === 0 && pluginCount === 0;

  return (
    <View style={styles.container} testID="needs-you-screen">
      <MenuHeader title={t("needsYou.title")} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {empty ? (
          <Text style={styles.empty} testID="needs-you-empty">
            {t("needsYou.empty")}
          </Text>
        ) : (
          <Text style={styles.subtitle}>{t("needsYou.subtitle")}</Text>
        )}
        {chats.map((chat) => (
          <NeedsYouChatSection key={chat.key} chat={chat} answerFor={answerFor} />
        ))}
        <PluginNeedsYouItems />
      </ScrollView>
      {total > 0 ? (
        <NeedsYouFooter chats={chats} answerFor={answerFor} total={total} answered={answered} />
      ) : null}
    </View>
  );
}

function NeedsYouChatSection({
  chat,
  answerFor,
}: {
  chat: NeedsYouChat;
  answerFor: AnswerFor;
}): ReactElement {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(chat.serverId);
  const handleOpen = useCallback(() => {
    navigateToWorkspace({ serverId: chat.serverId, workspaceId: chat.workspaceId });
  }, [chat.serverId, chat.workspaceId]);
  const hasCards = chat.questionGroups.length > 0 || chat.permissions.length > 0;
  const waited =
    chat.waitingSince === null
      ? null
      : t("needsYou.waited", { time: formatCompactTimeAgo(new Date(chat.waitingSince)) });

  return (
    <View style={styles.section} testID={`needs-you-chat-${chat.workspaceId}`}>
      <View style={styles.sectionHead}>
        <View style={styles.sectionTitles}>
          <Text style={styles.sectionTitle} numberOfLines={1}>
            {chatHeading(chat)}
          </Text>
          {waited ? <Text style={styles.sectionMeta}>{waited}</Text> : null}
        </View>
        <Button
          variant="ghost"
          size="sm"
          onPress={handleOpen}
          testID={`needs-you-open-${chat.workspaceId}`}
        >
          {t("needsYou.openChat")}
        </Button>
      </View>
      {chat.questionGroups.flatMap((group) =>
        group.questions.map((question) => (
          <QuestionCard
            key={`${group.agentId}:${question.id}`}
            serverId={chat.serverId}
            agentId={group.agentId}
            question={question}
            answer={answerFor(chat.serverId, group.agentId, question)}
          />
        )),
      )}
      {chat.permissions.map((permission) => (
        <PermissionRequestCard key={permission.key} permission={permission} client={client} />
      ))}
      {hasCards ? null : <Text style={styles.sectionMeta}>{t("needsYou.answerInChat")}</Text>}
    </View>
  );
}

function NeedsYouFooter({
  chats,
  answerFor,
  total,
  answered,
}: {
  chats: readonly NeedsYouChat[];
  answerFor: AnswerFor;
  total: number;
  answered: number;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { settings } = useAppSettings();
  const [sending, setSending] = useState(false);
  const insets = useSafeAreaInsets();
  const footerStyle = useMemo(
    () => [styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }],
    [insets.bottom],
  );

  const handleSend = useCallback(() => {
    setSending(true);
    void sendEveryChat({
      chats,
      answerFor,
      activeTurnBehavior: resolveSendNowBehavior(settings),
      onFailed: (chat) => toast.error(t("needsYou.sendFailed", { title: chat.title })),
    })
      .then((sent) => (sent > 0 ? toast.show(t("needsYou.sent", { count: sent })) : null))
      .finally(() => setSending(false));
  }, [answerFor, chats, settings, t, toast]);

  const getCopyText = useCallback(() => copyAnswersText(chats, answerFor), [answerFor, chats]);

  return (
    <View style={footerStyle}>
      <Text style={styles.footerText} testID="needs-you-summary">
        {t("needsYou.summary", { answered, total })}
      </Text>
      <View style={styles.footerActions}>
        <CopyAnswersButton
          getText={getCopyText}
          disabled={answered === 0}
          testID="needs-you-copy"
        />
        <Button
          variant="default"
          size="sm"
          disabled={answered === 0}
          loading={sending}
          onPress={handleSend}
          testID="needs-you-send"
        >
          {t("needsYou.send", { count: answered })}
        </Button>
      </View>
    </View>
  );
}

/** What a chat's section heading says; Copy answers uses it as the chat's header line. */
function chatHeading(chat: NeedsYouChat): string {
  return `${chat.projectName} › ${chat.title}`;
}

/** What Copy answers copies: the lines `sendEveryChat` would send, under each chat's heading. */
function copyAnswersText(chats: readonly NeedsYouChat[], answerFor: AnswerFor): string | null {
  return buildCopyAnswersText(
    chats.map((chat) => ({
      title: chatHeading(chat),
      messages: chat.questionGroups.map((group) =>
        buildAnswerMessage(group.questions, (question) =>
          answerFor(chat.serverId, group.agentId, question),
        ),
      ),
    })),
  );
}

/**
 * One message per agent with answered cards, each carrying only that agent's answers. A chat
 * that fails keeps its answers and the others still go. Resolves how many chats got a message.
 */
async function sendEveryChat(input: {
  chats: readonly NeedsYouChat[];
  answerFor: AnswerFor;
  activeTurnBehavior: ActiveTurnBehavior;
  onFailed: (chat: NeedsYouChat) => void;
}): Promise<number> {
  const runtime = getHostRuntimeStore();
  const results = await Promise.all(
    input.chats.map(async (chat) => {
      const client = runtime.getClient(chat.serverId);
      if (!client) return false;
      try {
        const sent = await Promise.all(
          chat.questionGroups.map((group) =>
            sendQuestionAnswers({
              client,
              serverId: chat.serverId,
              agentId: group.agentId,
              questions: group.questions,
              answerFor: (question) => input.answerFor(chat.serverId, group.agentId, question),
              activeTurnBehavior: input.activeTurnBehavior,
            }),
          ),
        );
        return sent.some(Boolean);
      } catch {
        input.onFailed(chat);
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.canvas,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
    gap: theme.spacing[4],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
    paddingTop: theme.spacing[8],
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sectionTitles: {
    flex: 1,
    minWidth: 0,
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  sectionMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  footerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  footerText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
