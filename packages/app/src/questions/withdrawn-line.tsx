import { createContext, useCallback, useContext, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { WithdrawnQuestion } from "@getpaseo/protocol/question-withdraw";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { Theme } from "@/styles/theme";

/**
 * Jumps the chat to the reply that asks a question, by label. The stream view provides it; a
 * reply shown anywhere else has no timeline to jump in, so its labels are plain text.
 */
export const QuestionJumpContext = createContext<((label: string) => void) | null>(null);

const ThemedX = withUnistyles(X);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * An agent's ✖️ lines as small gray lines, "Q630 withdrawn → Q653" (owner decision Q215). The
 * reason the agent wrote stays in its reply's source. Tapping a line that names the question
 * replacing it jumps there; the whole line is the touch target, so it is easy to hit on a phone.
 */
export function WithdrawnQuestionLines({
  questions,
}: {
  questions: readonly WithdrawnQuestion[];
}): ReactElement {
  return (
    <View style={styles.list} testID="withdrawn-questions">
      {questions.map((question) => (
        <WithdrawnLine key={question.label} question={question} />
      ))}
    </View>
  );
}

function WithdrawnLine({ question }: { question: WithdrawnQuestion }): ReactElement {
  const { t } = useTranslation();
  const jump = useContext(QuestionJumpContext);
  const target = jump ? question.replacedBy : null;
  const handlePress = useCallback(() => {
    if (jump && target) jump(target);
  }, [jump, target]);
  const testID = `withdrawn-question-${question.label}`;
  const content = (
    <>
      <ThemedX size={12} uniProps={mutedIconMapping} />
      <Text style={styles.text}>
        {t("questions.withdrawn", { label: question.label })}
        {question.replacedBy ? " → " : null}
        {question.replacedBy ? (
          <Text style={target ? styles.link : undefined}>{question.replacedBy}</Text>
        ) : null}
      </Text>
    </>
  );
  if (!target) {
    return (
      <View style={styles.line} testID={testID}>
        {content}
      </View>
    );
  }
  return (
    <PressHighlight
      style={styles.line}
      highlightStyle={styles.linePressed}
      onPress={handlePress}
      accessibilityRole="link"
      accessibilityLabel={t("questions.jumpTo", { label: target })}
      testID={testID}
    >
      {content}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    alignItems: "flex-start",
  },
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: 28,
    paddingHorizontal: theme.spacing[1],
    marginHorizontal: -theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  linePressed: {
    backgroundColor: theme.colors.surface2,
  },
  text: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  link: {
    textDecorationLine: "underline",
  },
}));
