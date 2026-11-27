import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, Paperclip, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import type {
  AgentOpenQuestion,
  AgentQuestionAnswer,
  AgentQuestionAnswerFile,
} from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { MenuTextField } from "@/components/ui/menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { uploadFileAttachments } from "@/composer/actions";
import { useToast } from "@/contexts/toast-context";
import { useFilePicker } from "@/hooks/use-file-picker";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { MAX_ANSWER_FILES, isQuestionAnswered, resolveAnswer } from "./answer-message";
import { questionAnswerScopeKey, saveQuestionAnswer, useQuestionAnswerStore } from "./answer-store";

const ThemedCheck = withUnistyles(Check);
const ThemedPaperclip = withUnistyles(Paperclip);
const ThemedX = withUnistyles(X);
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

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
          serverId={serverId}
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
      {files.length > 0 ? (
        <View style={styles.files}>
          {files.map((file) => (
            <AnswerFileChip key={file.id} file={file} onRemove={handleRemoveFile} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function AttachFilesButton({
  serverId,
  files,
  onChange,
  testID,
}: {
  serverId: string;
  files: AgentQuestionAnswerFile[];
  onChange: (files: AgentQuestionAnswerFile[]) => void;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const { pickFiles } = useFilePicker();
  const [uploading, setUploading] = useState(false);
  const handlePress = useCallback(() => {
    if (!client) return;
    void (async () => {
      const picked = await pickFiles();
      if (!picked?.length) return;
      const room = MAX_ANSWER_FILES - files.length;
      if (picked.length > room) {
        toast.error(t("questions.tooManyFiles", { max: MAX_ANSWER_FILES }));
      }
      setUploading(true);
      try {
        const uploaded = await uploadFileAttachments({ client, files: picked.slice(0, room) });
        onChange([...files, ...uploaded.map(({ attachment: { type: _type, ...file } }) => file)]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("questions.uploadFailed"));
      } finally {
        setUploading(false);
      }
    })();
  }, [client, files, onChange, pickFiles, t, toast]);
  return (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={Paperclip}
      loading={uploading}
      disabled={!client || files.length >= MAX_ANSWER_FILES}
      onPress={handlePress}
      accessibilityLabel={t("questions.attach")}
      testID={testID}
    >
      {files.length > 0 ? String(files.length) : t("questions.attach")}
    </Button>
  );
}

function AnswerFileChip({
  file,
  onRemove,
}: {
  file: AgentQuestionAnswerFile;
  onRemove: (fileId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleRemove = useCallback(() => onRemove(file.id), [file.id, onRemove]);
  return (
    <View style={styles.fileChip}>
      <ThemedPaperclip size={12} uniProps={mutedIconMapping} />
      <Text style={styles.fileName} numberOfLines={1}>
        {file.fileName}
      </Text>
      <ToolbarButton
        label={t("questions.removeFile", { name: file.fileName })}
        onPress={handleRemove}
      >
        <ThemedX size={12} uniProps={mutedIconMapping} />
      </ToolbarButton>
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
  files: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 220,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  fileName: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
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
