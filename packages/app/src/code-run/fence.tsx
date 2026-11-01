import { useCallback, useContext, useMemo, useState } from "react";
import { View } from "react-native";
import { Play } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { markdownCodeStyle } from "@/components/markdown/code-style";
import { MarkdownStreamingContext } from "@/components/markdown/streaming-context";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { CodeRunCard, CommandRiskLabel } from "./card";
import { hashCode, shellFenceCommand } from "./command";
import { codeRunKey, useCodeRunScope, type CodeRunScope } from "./scope";
import { useCodeRunStore } from "./store";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);

interface CodeFenceProps {
  code: string;
  language: string | null | undefined;
}

/** A Markdown code fence. Shell fences in a chat that can run them get a Run control. */
export function CodeFence({ code, language }: CodeFenceProps) {
  const scope = useCodeRunScope();
  const command = useMemo(
    () => (scope ? shellFenceCommand(language, code) : null),
    [scope, language, code],
  );
  if (!scope || command === null)
    return <ThemedCodeBlock code={code} language={language} uniProps={markdownCodeStyle} />;
  return <RunnableFence scope={scope} code={code} language={language} command={command} />;
}

/** Whether a native fence must leave the library's text view to get its Run control. */
export function isRunnableShellFence(language: string, code: string): boolean {
  return shellFenceCommand(language, code) !== null;
}

function RunnableFence({
  scope,
  code,
  language,
  command,
}: CodeFenceProps & { scope: CodeRunScope; command: string }) {
  // A fence still arriving may be cut mid-command; its card opens once the reply settles.
  const streaming = useContext(MarkdownStreamingContext);
  const runKey = useMemo(() => codeRunKey(scope, hashCode(code)), [scope, code]);
  const hasRun = useCodeRunStore(
    (state) => state.records[runKey] !== undefined || state.live[runKey] !== undefined,
  );
  const [drafting, setDrafting] = useState(false);
  const openDraft = useCallback(() => setDrafting(true), []);
  const closeDraft = useCallback(() => setDrafting(false), []);
  const cardOpen = hasRun || drafting;
  const available = !streaming && !cardOpen;
  // Touch layouts get a labeled 44pt button under the block; hover layouts keep the icon by Copy.
  const compact = useIsCompactFormFactor();
  const touch = isNative || compact;
  const run = useMemo(() => ({ onPress: openDraft, available }), [openDraft, available]);
  return (
    <View>
      <ThemedCodeBlock
        code={code}
        language={language}
        run={touch ? undefined : run}
        uniProps={markdownCodeStyle}
      />
      {touch && available ? <TouchRunButton command={command} onPress={openDraft} /> : null}
      {cardOpen ? (
        <CodeRunCard runKey={runKey} scope={scope} command={command} onClose={closeDraft} />
      ) : null}
    </View>
  );
}

function TouchRunButton({ command, onPress }: { command: string; onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.touchRow}>
      <Button
        variant="secondary"
        size="md"
        leftIcon={Play}
        onPress={onPress}
        accessibilityLabel={t("codeRun.runCommand")}
        testID="code-block-run"
      >
        {t("codeRun.run")}
      </Button>
      <CommandRiskLabel command={command} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  touchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
}));
