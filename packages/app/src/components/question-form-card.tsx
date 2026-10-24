import { Alert } from "@/components/ui/alert";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { useState, useCallback, useMemo, useRef, type RefObject } from "react";
import { View, Text, Pressable, type PressableStateCallbackType } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Check, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { PendingPermission } from "@/types/shared";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { isWeb } from "@/constants/platform";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import type { EditingTextInputHandle } from "@/components/ui/text-input/types";
import { ScrollableCodeSurface } from "@/components/ui/scrollable-code-surface";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswerLists,
  buildQuestionFormAnswers,
  isOneTapQuestion,
  isQuestionAnswered,
  parseQuestionFormQuestions,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
  type QuestionFormQuestion,
  type QuestionOption,
} from "./question-form-card-core";

interface QuestionFormCardProps {
  permission: PendingPermission;
  onRespond: (response: AgentPermissionResponse) => void;
  isResponding: boolean;
  responseError: string | null;
}

const IS_WEB = isWeb;
// Native previews are uncapped: inside the option's Pressable, Android never hands a
// drag to the preview's nested scroll, so lines past a cap would be unreachable.
const OPTION_PREVIEW_MAX_HEIGHT = IS_WEB ? 240 : undefined;

function getQuestionInputPlaceholder({
  question,
  answerPlaceholder,
  otherPlaceholder,
}: {
  question: QuestionFormQuestion;
  answerPlaceholder: string;
  otherPlaceholder: string;
}): string {
  return (
    question.placeholder ?? (question.options.length === 0 ? answerPlaceholder : otherPlaceholder)
  );
}

interface QuestionOptionRowProps {
  qIndex: number;
  optIndex: number;
  option: QuestionOption;
  isSelected: boolean;
  multiSelect: boolean;
  isResponding: boolean;
  onToggle: (qIndex: number, optIndex: number, multiSelect: boolean) => void;
}

function QuestionOptionRow({
  qIndex,
  optIndex,
  option,
  isSelected,
  multiSelect,
  isResponding,
  onToggle,
}: QuestionOptionRowProps) {
  const { theme } = useUnistyles();

  const handlePress = useCallback(() => {
    onToggle(qIndex, optIndex, multiSelect);
  }, [onToggle, qIndex, optIndex, multiSelect]);

  const pressableStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.optionItem,
      (Boolean(hovered) || isSelected) && {
        backgroundColor: theme.colors.surface2,
      },
      pressed && styles.optionItemPressed,
    ],
    [isSelected, theme.colors.surface2],
  );

  const optionLabelStyle = useMemo(
    () => [
      styles.optionLabel,
      { color: isSelected ? theme.colors.foreground : theme.colors.foregroundMuted },
    ],
    [isSelected, theme.colors.foreground, theme.colors.foregroundMuted],
  );
  const optionDescriptionStyle = useMemo(
    () => [styles.optionDescription, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const accessibilityState = useMemo(() => ({ checked: isSelected }), [isSelected]);

  // Static left-side control: square for multi-select, circle for single-select.
  // Always rendered so toggling only swaps fill/border — the row never reflows.
  const controlStyle = useMemo(
    () => [
      styles.selectionControl,
      multiSelect ? styles.selectionControlCheckbox : styles.selectionControlRadio,
      {
        borderColor: isSelected ? theme.colors.accent : theme.colors.foregroundExtraMuted,
        backgroundColor: isSelected && multiSelect ? theme.colors.accent : "transparent",
      },
    ],
    [isSelected, multiSelect, theme.colors.accent, theme.colors.foregroundExtraMuted],
  );
  const radioDotStyle = useMemo(
    () => [styles.selectionRadioDot, { backgroundColor: theme.colors.accent }],
    [theme.colors.accent],
  );

  return (
    <Pressable
      style={pressableStyle}
      onPress={handlePress}
      disabled={isResponding}
      accessibilityRole={multiSelect ? "checkbox" : "radio"}
      accessibilityLabel={option.label}
      accessibilityState={accessibilityState}
      aria-checked={isSelected}
    >
      <View style={styles.optionItemContent}>
        <View style={controlStyle}>
          {isSelected && multiSelect ? (
            <Check size={12} color={theme.colors.accentForeground} />
          ) : null}
          {isSelected && !multiSelect ? <View style={radioDotStyle} /> : null}
        </View>
        <View style={styles.optionTextBlock}>
          <Text style={optionLabelStyle}>{option.label}</Text>
          {option.description ? (
            <Text style={optionDescriptionStyle}>{option.description}</Text>
          ) : null}
          {option.preview ? (
            // Shown for every option at once so they can be compared before picking.
            // Long lines wrap, as in Claude Code, since most previews are prose.
            <ScrollableCodeSurface
              tone="surface0"
              maxHeight={OPTION_PREVIEW_MAX_HEIGHT}
              horizontal={false}
              selectable={false}
              textStyle={styles.optionPreviewText}
              testID="question-form-option-preview"
            >
              {option.preview}
            </ScrollableCodeSurface>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

interface QuestionNavButtonProps {
  index: number;
  total: number;
  header: string;
  isActive: boolean;
  isAnswered: boolean;
  isResponding: boolean;
  onSelect: (index: number) => void;
}

function QuestionNavButton({
  index,
  total,
  header,
  isActive,
  isAnswered,
  isResponding,
  onSelect,
}: QuestionNavButtonProps) {
  const { theme } = useUnistyles();
  const accessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);
  const handlePress = useCallback(() => {
    onSelect(index);
  }, [index, onSelect]);
  const pressableStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => {
      return [
        styles.questionNavButton,
        {
          backgroundColor:
            isActive || Boolean(hovered) ? theme.colors.surface2 : theme.colors.surface1,
          borderColor: isActive ? theme.colors.foregroundMuted : theme.colors.border,
        },
        pressed && styles.optionItemPressed,
      ];
    },
    [
      isActive,
      theme.colors.border,
      theme.colors.foregroundMuted,
      theme.colors.surface1,
      theme.colors.surface2,
    ],
  );
  const textStyle = useMemo(
    () => [
      styles.questionNavText,
      { color: isActive ? theme.colors.foreground : theme.colors.foregroundMuted },
    ],
    [isActive, theme.colors.foreground, theme.colors.foregroundMuted],
  );

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={`Question ${index + 1} of ${total}`}
      accessibilityState={accessibilityState}
      aria-selected={isActive}
      testID={`question-form-question-nav-${index + 1}`}
      style={pressableStyle}
      onPress={handlePress}
      disabled={isResponding}
    >
      {isAnswered ? (
        <Check
          size={12}
          color={isActive ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
      ) : null}
      <Text style={textStyle} numberOfLines={1}>
        {header}
      </Text>
    </Pressable>
  );
}

interface QuestionNavProps {
  questions: QuestionFormQuestion[];
  activeIndex: number;
  isAnswered: (qIndex: number) => boolean;
  isResponding: boolean;
  onSelect: (index: number) => void;
}

// Titled tabs (one per question header) with a check on answered ones. Hidden for
// a lone question — a single "1 of 1" tab carries no information.
function QuestionNav({
  questions,
  activeIndex,
  isAnswered,
  isResponding,
  onSelect,
}: QuestionNavProps) {
  if (questions.length <= 1) {
    return null;
  }
  return (
    <View
      style={styles.questionNav}
      testID="question-form-question-nav"
      accessibilityRole="tablist"
    >
      {questions.map((question, qIndex) => (
        <QuestionNavButton
          key={question.header}
          index={qIndex}
          total={questions.length}
          header={question.header}
          isActive={qIndex === activeIndex}
          isAnswered={isAnswered(qIndex)}
          isResponding={isResponding}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

interface QuestionOtherInputProps {
  qIndex: number;
  inputRef: RefObject<EditingTextInputHandle | null>;
  accessibilityLabel: string;
  value: string;
  placeholder: string;
  isResponding: boolean;
  onChange: (qIndex: number, text: string) => void;
  onSubmit: () => void;
}

function QuestionOtherInput({
  qIndex,
  inputRef,
  accessibilityLabel,
  value,
  placeholder,
  isResponding,
  onChange,
  onSubmit,
}: QuestionOtherInputProps) {
  const { theme } = useUnistyles();
  const handleChange = useCallback(
    (text: string) => {
      onChange(qIndex, text);
    },
    [onChange, qIndex],
  );
  const otherInputStyle = useMemo(
    () =>
      [
        styles.otherInput,
        {
          borderColor: value.length > 0 ? theme.colors.borderAccent : theme.colors.border,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface2,
        },
        IS_WEB ? { outlineStyle: "none", outlineWidth: 0, outlineColor: "transparent" } : null,
      ] as const,
    [
      value.length,
      theme.colors.borderAccent,
      theme.colors.border,
      theme.colors.foreground,
      theme.colors.surface2,
    ],
  );
  return (
    <TextInput
      ref={inputRef}
      // @ts-expect-error - outlineStyle is web-only
      style={otherInputStyle}
      accessibilityLabel={accessibilityLabel}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      initialValue={value}
      onChangeText={handleChange}
      onSubmitEditing={onSubmit}
      editable={!isResponding}
      blurOnSubmit={false}
    />
  );
}

interface OneTapOptionButtonProps {
  optIndex: number;
  label: string;
  size: "sm" | "md";
  isResponding: boolean;
  isRespondingOption: boolean;
  onAnswer: (optIndex: number) => void;
}

function OneTapOptionButton({
  optIndex,
  label,
  size,
  isResponding,
  isRespondingOption,
  onAnswer,
}: OneTapOptionButtonProps) {
  const handlePress = useCallback(() => onAnswer(optIndex), [onAnswer, optIndex]);
  return (
    <Button
      variant="secondary"
      size={size}
      onPress={handlePress}
      disabled={isResponding}
      loading={isRespondingOption}
      accessibilityLabel={label}
      testID={`question-form-answer-${optIndex + 1}`}
    >
      {label}
    </Button>
  );
}

function QuestionText({ text }: { text: string }) {
  return (
    <View style={styles.questionHeader}>
      <View testID="question-form-current-question" style={styles.questionText}>
        <MarkdownRenderer text={text} compact />
      </View>
    </View>
  );
}

interface QuestionCardBodyProps extends QuestionFormCardProps {
  questions: QuestionFormQuestion[];
}

// Each option is its own button, so one tap answers. Phones stack them full width.
function OneTapQuestionCard({
  permission,
  questions,
  onRespond,
  isResponding,
  responseError,
}: QuestionCardBodyProps) {
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const [respondingOption, setRespondingOption] = useState<number | null>(null);
  const [isDismissing, setIsDismissing] = useState(false);
  const [question] = questions;
  const size = isMobile ? "md" : "sm";
  const dismissLabel = resolveDismissLabel(questions, t("common.actions.dismiss"));
  const actionsStyle = useMemo(
    () => [styles.oneTapActions, !isMobile && styles.oneTapActionsDesktop],
    [isMobile],
  );

  const handleAnswer = useCallback(
    (optIndex: number) => {
      if (isResponding) return;
      setRespondingOption(optIndex);
      setIsDismissing(false);
      onRespond({
        behavior: "allow",
        updatedInput: {
          ...permission.request.input,
          answers: buildQuestionFormAnswers(questions, { 0: new Set([optIndex]) }, {}),
          answerLists: buildQuestionFormAnswerLists(questions, { 0: new Set([optIndex]) }, {}),
        },
      });
    },
    [isResponding, onRespond, permission.request.input, questions],
  );
  const handleDismiss = useCallback(() => {
    if (isResponding) return;
    setRespondingOption(null);
    setIsDismissing(true);
    onRespond({ behavior: "deny", message: "Dismissed by user" });
  }, [isResponding, onRespond]);

  return (
    <View style={styles.container} testID="question-form-card">
      <QuestionText text={question.question} />
      <View style={actionsStyle} accessibilityLabel={question.question}>
        {question.options.map((option, optIndex) => (
          <OneTapOptionButton
            key={option.label}
            optIndex={optIndex}
            label={option.label}
            size={size}
            isResponding={isResponding}
            isRespondingOption={isResponding && respondingOption === optIndex}
            onAnswer={handleAnswer}
          />
        ))}
        <Button
          variant="ghost"
          size={size}
          leftIcon={X}
          onPress={handleDismiss}
          disabled={isResponding}
          loading={isResponding && isDismissing}
          accessibilityLabel={dismissLabel}
          testID="question-form-dismiss"
        >
          {dismissLabel}
        </Button>
      </View>
      {responseError ? <Alert variant="error" description={responseError} size="sm" /> : null}
    </View>
  );
}

export function QuestionFormCard(props: QuestionFormCardProps) {
  const questions = useMemo(
    () => parseQuestionFormQuestions(props.permission.request.input),
    [props.permission.request.input],
  );
  if (!questions) return null;
  return isOneTapQuestion(questions) ? (
    <OneTapQuestionCard {...props} questions={questions} />
  ) : (
    <QuestionForm {...props} questions={questions} />
  );
}

function QuestionForm({
  permission,
  questions,
  onRespond,
  isResponding,
  responseError,
}: QuestionCardBodyProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();

  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const otherInputRef = useRef<EditingTextInputHandle | null>(null);
  const [respondingAction, setRespondingAction] = useState<"submit" | "dismiss" | null>(null);
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);

  const toggleOption = useCallback(
    (qIndex: number, optIndex: number, multiSelect: boolean) => {
      const current = selections[qIndex] ?? new Set<number>();
      const next = new Set(current);
      if (multiSelect) {
        if (next.has(optIndex)) {
          next.delete(optIndex);
        } else {
          next.add(optIndex);
        }
      } else if (next.has(optIndex)) {
        next.clear();
      } else {
        next.clear();
        next.add(optIndex);
      }

      setSelections((prev) => ({ ...prev, [qIndex]: next }));

      // Single-select: an option and a custom answer replace each other, as in Claude Code.
      // Multi-select keeps both. The editing surface owns its text and never replays state
      // (docs/forms.md), so clearing state alone would leave stale text on screen that
      // submit ignores; clear the surface explicitly.
      if (!multiSelect && otherTexts[qIndex]) {
        setOtherTexts((prev) => {
          const nextTexts = { ...prev };
          delete nextTexts[qIndex];
          return nextTexts;
        });
        otherInputRef.current?.replaceText("");
      }

      if (!multiSelect && next.size > 0 && qIndex === activeQuestionIndex) {
        setActiveQuestionIndex(Math.min(qIndex + 1, questions.length - 1));
      }
    },
    [activeQuestionIndex, otherTexts, questions, selections],
  );

  const setOtherText = useCallback(
    (qIndex: number, text: string) => {
      setOtherTexts((prev) => ({ ...prev, [qIndex]: text }));
      const multiSelect = questions[qIndex]?.multiSelect ?? false;
      if (!multiSelect && text.length > 0) {
        setSelections((prev) => {
          if (!prev[qIndex] || prev[qIndex].size === 0) return prev;
          return { ...prev, [qIndex]: new Set<number>() };
        });
      }
    },
    [questions],
  );

  const allAnswered = areQuestionsAnswered(questions, selections, otherTexts);
  const resolvedActiveQuestionIndex = Math.min(activeQuestionIndex, questions.length - 1);
  const activeQuestion = questions[resolvedActiveQuestionIndex];
  const activeQuestionAnswered = isQuestionAnswered(
    activeQuestion,
    resolvedActiveQuestionIndex,
    selections,
    otherTexts,
  );
  const isLastQuestion = resolvedActiveQuestionIndex === questions.length - 1;

  const handleSubmit = useCallback(() => {
    if (!allAnswered || isResponding) return;
    setRespondingAction("submit");
    onRespond({
      behavior: "allow",
      updatedInput: {
        ...permission.request.input,
        answers: buildQuestionFormAnswers(questions, selections, otherTexts),
        answerLists: buildQuestionFormAnswerLists(questions, selections, otherTexts),
      },
    });
  }, [
    questions,
    allAnswered,
    isResponding,
    selections,
    otherTexts,
    onRespond,
    permission.request.input,
  ]);

  const handleDeny = useCallback(() => {
    if (!questions || isResponding) return;
    setRespondingAction("dismiss");
    if (shouldSubmitEmptyOnDismiss(questions)) {
      onRespond({
        behavior: "allow",
        updatedInput: {
          ...permission.request.input,
          answers: buildQuestionFormAnswers(questions, selections, otherTexts),
          answerLists: buildQuestionFormAnswerLists(questions, selections, otherTexts),
        },
      });
      return;
    }
    onRespond({
      behavior: "deny",
      message: "Dismissed by user",
    });
  }, [questions, isResponding, onRespond, otherTexts, permission.request.input, selections]);

  const handleSelectQuestion = useCallback((index: number) => {
    setActiveQuestionIndex(index);
  }, []);

  const navIsAnswered = useCallback(
    (qIndex: number) => isQuestionAnswered(questions[qIndex], qIndex, selections, otherTexts),
    [questions, selections, otherTexts],
  );

  const handlePrimaryAction = useCallback(() => {
    if (!isLastQuestion) {
      if (!activeQuestionAnswered || isResponding) return;
      setActiveQuestionIndex((index) => Math.min(index + 1, questions.length - 1));
      return;
    }
    handleSubmit();
  }, [activeQuestionAnswered, handleSubmit, isLastQuestion, isResponding, questions.length]);

  const dismissButtonStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.actionButton,
      {
        backgroundColor: hovered ? theme.colors.surface2 : theme.colors.surface1,
        borderColor: theme.colors.borderAccent,
      },
      pressed && styles.optionItemPressed,
    ],
    [theme.colors.surface2, theme.colors.surface1, theme.colors.borderAccent],
  );

  const pendingAction = isResponding ? respondingAction : null;
  const primaryDisabled = isResponding || (isLastQuestion ? !allAnswered : !activeQuestionAnswered);
  const primaryActionLabel = isLastQuestion
    ? t("message.question.submit")
    : t("message.question.next");
  const submitButtonStyle = useCallback(
    ({ pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.actionButton,
      {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accent,
        opacity: primaryDisabled ? 0.5 : 1,
      },
      pressed && !primaryDisabled ? styles.optionItemPressed : null,
    ],
    [primaryDisabled, theme.colors.accent],
  );

  // Single-select radios need a group; checkboxes are valid standalone.
  const optionsGroupAccessibility = useMemo(
    () =>
      !activeQuestion.multiSelect
        ? ({
            accessibilityRole: "radiogroup",
            accessibilityLabel: activeQuestion.question,
          } as const)
        : {},
    [activeQuestion],
  );
  const actionsContainerStyle = useMemo(
    () => [styles.actionsContainer, !isMobile && styles.actionsContainerDesktop],
    [isMobile],
  );
  const dismissActionTextStyle = useMemo(
    () => [styles.actionText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const submitActionTextColor = theme.colors.accentForeground;
  const submitActionTextStyle = useMemo(
    () => [styles.actionText, { color: submitActionTextColor }],
    [submitActionTextColor],
  );

  const dismissLabel = resolveDismissLabel(questions, t("common.actions.dismiss"));
  const selected = selections[resolvedActiveQuestionIndex] ?? new Set<number>();
  const otherText = otherTexts[resolvedActiveQuestionIndex] ?? "";
  const showTextInput = questionShowsTextInput(activeQuestion);

  return (
    <View style={styles.container} testID="question-form-card">
      <QuestionNav
        questions={questions}
        activeIndex={resolvedActiveQuestionIndex}
        isAnswered={navIsAnswered}
        isResponding={isResponding}
        onSelect={handleSelectQuestion}
      />
      <QuestionText text={activeQuestion.question} />

      <View key={activeQuestion.question} style={styles.questionBlock}>
        {activeQuestion.options.length > 0 ? (
          <View style={styles.optionsWrap} {...optionsGroupAccessibility}>
            {activeQuestion.options.map((opt, optIndex) => (
              <QuestionOptionRow
                key={opt.label}
                qIndex={resolvedActiveQuestionIndex}
                optIndex={optIndex}
                option={opt}
                isSelected={selected.has(optIndex)}
                multiSelect={activeQuestion.multiSelect}
                isResponding={isResponding}
                onToggle={toggleOption}
              />
            ))}
          </View>
        ) : null}
        {showTextInput ? (
          <QuestionOtherInput
            qIndex={resolvedActiveQuestionIndex}
            inputRef={otherInputRef}
            accessibilityLabel={activeQuestion.question}
            value={otherText}
            placeholder={getQuestionInputPlaceholder({
              question: activeQuestion,
              answerPlaceholder: t("message.question.answerPlaceholder"),
              otherPlaceholder: t("message.question.otherPlaceholder"),
            })}
            isResponding={isResponding}
            onChange={setOtherText}
            onSubmit={handlePrimaryAction}
          />
        ) : null}
      </View>

      {responseError ? <Alert variant="error" description={responseError} size="sm" /> : null}

      <View style={actionsContainerStyle}>
        <Pressable
          style={dismissButtonStyle}
          onPress={handleDeny}
          disabled={isResponding}
          accessibilityRole="button"
          accessibilityLabel={dismissLabel}
          testID="question-form-dismiss"
        >
          {pendingAction === "dismiss" ? (
            <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
          ) : (
            <View style={styles.actionContent}>
              <X size={14} color={theme.colors.foregroundMuted} />
              <Text style={dismissActionTextStyle}>{dismissLabel}</Text>
            </View>
          )}
        </Pressable>

        <Pressable
          style={submitButtonStyle}
          onPress={handlePrimaryAction}
          disabled={primaryDisabled}
          accessibilityRole="button"
          accessibilityLabel={primaryActionLabel}
          testID="question-form-primary-action"
        >
          {pendingAction === "submit" ? (
            <LoadingSpinner size="small" color={theme.colors.accentForeground} />
          ) : (
            <View style={styles.actionContent}>
              <Check size={14} color={submitActionTextColor} />
              <Text style={submitActionTextStyle}>{primaryActionLabel}</Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
  },
  questionBlock: {
    gap: theme.spacing[2],
  },
  questionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    flex: 1,
  },
  questionText: {
    flex: 1,
    minWidth: 0,
  },
  optionsWrap: {
    gap: theme.spacing[1],
  },
  questionNav: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
  },
  questionNavButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: 28,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
  },
  questionNavText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  optionItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  optionItemPressed: {
    opacity: 0.9,
  },
  optionItemContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  optionTextBlock: {
    flex: 1,
    gap: theme.spacing[1],
  },
  optionLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 22,
  },
  optionDescription: {
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  optionPreviewText: {
    lineHeight: 20,
    ...(isWeb ? { whiteSpace: "pre-wrap", overflowWrap: "break-word" } : null),
  },
  selectionControl: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
    marginTop: 2, // optical-align 18px control to the 22px label first line
  },
  selectionControlCheckbox: {
    borderRadius: theme.borderRadius.base,
  },
  selectionControlRadio: {
    borderRadius: 999,
  },
  selectionRadioDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  otherInput: {
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    fontSize: theme.fontSize.base,
  },
  actionsContainer: {
    gap: theme.spacing[2],
  },
  actionsContainerDesktop: {
    flexDirection: "row",
    justifyContent: "flex-start",
    alignItems: "center",
  },
  // Same inset as the question, so the buttons line up with the command's code block.
  oneTapActions: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  oneTapActionsDesktop: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
  },
  actionButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    borderWidth: theme.borderWidth[1],
  },
  actionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionText: {
    fontSize: theme.fontSize.base,
  },
}));
