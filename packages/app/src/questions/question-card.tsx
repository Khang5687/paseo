import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import type {
  AgentOpenQuestion,
  AgentQuestionAnswer,
  AgentQuestionAnswerFile,
} from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { MenuTextField } from "@/components/ui/menu";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { AnswerFileList, AttachFilesButton } from "./answer-files";
import { isQuestionAnswered, resolveAnswer } from "./answer-message";
import { questionAnswerScopeKey, saveQuestionAnswer, useQuestionAnswerStore } from "./answer-store";

const ThemedCheck = withUnistyles(Check);
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

const EMPTY_QUESTIONS: readonly AgentOpenQuestion[] = [];
const EMPTY_FILES: AgentQuestionAnswerFile[] = [];

/** An agent's open ❓ questions, with the answer each card shows: this device's or the host's. */
export function useOpenQuestionAnswers(serverId: string, agentId: string) {
  const questions = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.openQuestions ?? EMPTY_QUESTIONS;
  });
  const local = useQuestionAnswerStore(
    useShallow((state) => state.answers[questionAnswerScopeKey(serverId, agentId)]),
  );
  const answers = useMemo(() => {
    const result = new Map<string, AgentQuestionAnswer>();
    for (const question of questions) {
      const answer = resolveAnswer(local?.[question.id], question.answer);
      if (answer) result.set(question.id, answer);
    }
    return result;
  }, [local, questions]);
  return { questions, answers };
}

function foldedAnswerText(
  question: AgentOpenQuestion,
  answer: AgentQuestionAnswer | undefined,
  yes: string,
): string {
  if (!answer?.pick) return answer?.text ?? "";
  return question.pick ?? yes;
}

/**
 * One open ❓ question as a card: "Go with pick", your own words, and files. An answered card
 * folds to one green line with Change. Answers save as you go and reach every device.
 */
export function QuestionCard({
  serverId,
  agentId,
  question,
  answer,
}: {
  serverId: string;
  agentId: string;
  question: AgentOpenQuestion;
  answer: AgentQuestionAnswer | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const answered = isQuestionAnswered(answer);
  // An answered card folds to one line; typing keeps it open until Enter or "Go with pick".
  const [editing, setEditing] = useState(!answered);
  const files = answer?.files ?? EMPTY_FILES;
  const save = useCallback(
    (next: Omit<AgentQuestionAnswer, "updatedAt">) =>
      saveQuestionAnswer({ serverId, agentId, questionId: question.id, answer: next }),
    [agentId, question.id, serverId],
  );
  // The field is uncontrolled; it is rebuilt only when the answer changes on another device,
  // never for this device's own typing, which would drop the caret.
  const fieldText = answer && !answer.pick ? answer.text : "";
  const typedRef = useRef(fieldText);
  const [fieldKey, setFieldKey] = useState(0);
  useEffect(() => {
    if (typedRef.current === fieldText) return;
    typedRef.current = fieldText;
    setFieldKey((key) => key + 1);
  }, [fieldText]);
  const handleGoWithPick = useCallback(() => {
    save({ pick: true, text: "", files });
    setEditing(false);
  }, [files, save]);
  const handleChangeText = useCallback(
    (text: string) => {
      typedRef.current = text;
      setEditing(true);
      save({ pick: false, text, files });
    },
    [files, save],
  );
  const handleSubmitText = useCallback(() => {
    if (answered) setEditing(false);
  }, [answered]);
  const handleChange = useCallback(() => setEditing(true), []);
  const handleFiles = useCallback(
    (nextFiles: AgentQuestionAnswerFile[]) =>
      save({ pick: answer?.pick ?? false, text: answer?.text ?? "", files: nextFiles }),
    [answer?.pick, answer?.text, save],
  );
  const handleRemoveFile = useCallback(
    (fileId: string) => handleFiles(files.filter((entry) => entry.id !== fileId)),
    [files, handleFiles],
  );
  const heading = question.label ? `${question.label} · ${question.title}` : question.title;

  if (answered && !editing) {
    return (
      <View style={styles.folded} testID={`open-question-${question.id}-answered`}>
        <ThemedCheck size={14} uniProps={successIconMapping} />
        <Text style={styles.foldedText} numberOfLines={1}>
          {`${heading} · ${foldedAnswerText(question, answer, t("questions.yes"))}`}
        </Text>
        <Button
          variant="ghost"
          size="sm"
          onPress={handleChange}
          testID={`open-question-${question.id}-change`}
        >
          {t("questions.change")}
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.card} testID={`open-question-${question.id}`}>
      <Text style={styles.title}>{heading}</Text>
      {question.body ? <Text style={styles.body}>{question.body}</Text> : null}
      {question.pick ? <Text style={styles.pick}>{`➡️ ${question.pick}`}</Text> : null}
      <View style={styles.actions}>
        {question.pick ? (
          <Button
            variant={answer?.pick ? "default" : "secondary"}
            size="sm"
            onPress={handleGoWithPick}
            testID={`open-question-${question.id}-pick`}
          >
            {t("questions.goWithPick")}
          </Button>
        ) : null}
        <AttachFilesButton
          client={client}
          files={files}
          onChange={handleFiles}
          testID={`open-question-${question.id}-attach`}
        />
      </View>
      <MenuTextField
        key={fieldKey}
        initialValue={fieldText}
        onChangeText={handleChangeText}
        onSubmitEditing={handleSubmitText}
        placeholder={t("questions.ownPlaceholder")}
        testID={`open-question-${question.id}-text`}
      />
      <AnswerFileList files={files} onRemove={handleRemoveFile} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
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
  pick: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  folded: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.statusSuccessTint,
  },
  foldedText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.base,
  },
}));
