import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentOpenQuestion, AgentQuestionAnswer } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { ComposerTrackPill } from "@/composer/tracks";
import { resolveSendNowBehavior } from "@/composer/input/state";
import { useToast } from "@/contexts/toast-context";
import { useAppSettings } from "@/hooks/use-settings";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { isQuestionAnswered } from "./answer-message";
import { QuestionCard, useOpenQuestionAnswers } from "./question-card";
import { sendQuestionAnswers } from "./send-answers";

/** Labels the pill names before it stops listing them. */
const PILL_LABEL_LIMIT = 3;

/**
 * The bar above the composer that lists the chat's open ❓ questions (owner decisions Q109, Q122,
 * Q123). Tapping it opens every card in one panel; one Send answers all the answered cards in
 * one message, and the skipped ones stay open.
 */
export const OpenQuestionsTrack = memo(function OpenQuestionsTrack({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const { questions, answers } = useOpenQuestionAnswers(serverId, agentId);
  const segments = useMemo(() => {
    const labels = questions.flatMap((question) => (question.label ? [question.label] : []));
    const shown = labels.slice(0, PILL_LABEL_LIMIT);
    const tail = labels.length > shown.length ? " · …" : "";
    const text = [t("questions.pill", { count: questions.length }), ...shown].join(" · ") + tail;
    return [{ bucket: "needs_input" as const, text }];
  }, [questions, t]);

  if (questions.length === 0) return null;
  return (
    <ComposerTrackPill
      segments={segments}
      panelTitle={t("questions.panelTitle")}
      testID="open-questions-pill"
      accessibilityLabel={t("questions.pill", { count: questions.length })}
    >
      <OpenQuestionsPanel
        serverId={serverId}
        agentId={agentId}
        questions={questions}
        answers={answers}
      />
    </ComposerTrackPill>
  );
});

function OpenQuestionsPanel({
  serverId,
  agentId,
  questions,
  answers,
}: {
  serverId: string;
  agentId: string;
  questions: readonly AgentOpenQuestion[];
  answers: ReadonlyMap<string, AgentQuestionAnswer>;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const { settings } = useAppSettings();
  const [sending, setSending] = useState(false);
  const answeredCount = questions.filter((question) =>
    isQuestionAnswered(answers.get(question.id)),
  ).length;

  const handleSend = useCallback(() => {
    if (!client) return;
    setSending(true);
    sendQuestionAnswers({
      client,
      serverId,
      agentId,
      questions,
      answerFor: (question) => answers.get(question.id),
      activeTurnBehavior: resolveSendNowBehavior(settings),
    })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : t("questions.sendFailed"));
      })
      .finally(() => setSending(false));
  }, [agentId, answers, client, questions, serverId, settings, t, toast]);

  return (
    <View style={styles.panel} testID="open-questions-panel">
      {questions.map((question) => (
        <QuestionCard
          key={question.id}
          serverId={serverId}
          agentId={agentId}
          question={question}
          answer={answers.get(question.id)}
        />
      ))}
      <View style={styles.footer}>
        <Text style={styles.footerText} testID="open-questions-summary">
          {t("questions.summary", {
            answered: answeredCount,
            total: questions.length,
            open: questions.length - answeredCount,
          })}
        </Text>
        <Button
          variant="default"
          size="sm"
          disabled={answeredCount === 0 || !client}
          loading={sending}
          onPress={handleSend}
          testID="open-questions-send"
        >
          {t("questions.send", { count: answeredCount })}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  footerText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
