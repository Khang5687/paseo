import { useCallback, useContext, useMemo, useState } from "react";
import { View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { markdownCodeStyle } from "@/components/markdown/code-style";
import { MarkdownStreamingContext } from "@/components/markdown/streaming-context";
import { CodeRunCard } from "./card";
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
  const toggleDraft = useCallback(() => setDrafting((open) => !open), []);
  const closeDraft = useCallback(() => setDrafting(false), []);
  const cardOpen = hasRun || drafting;
  const available = !streaming && !hasRun;
  const run = useMemo(() => ({ onPress: toggleDraft, available }), [toggleDraft, available]);
  return (
    <View>
      <ThemedCodeBlock code={code} language={language} run={run} uniProps={markdownCodeStyle} />
      {cardOpen ? (
        <CodeRunCard runKey={runKey} scope={scope} command={command} onClose={closeDraft} />
      ) : null}
    </View>
  );
}
