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
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { CodeRunCard, CommandRiskLabel } from "./card";
import { hashCode, shellFenceCommand } from "./command";
import { codeRunKey, useCodeRunScope, type CodeRunScope } from "./scope";
import { useCodeRunStore } from "./store";
import {
  hasRunRequest,
  matchCodeRunHost,
  parseFenceInfo,
  resolveCodeRunTarget,
  targetServerId,
  type CodeRunTarget,
  type FenceRunRequest,
} from "./target";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);
const NO_WORKSPACES: ReadonlyMap<string, WorkspaceDescriptor> = new Map();

interface CodeFenceProps {
  code: string;
  language: string | null | undefined;
  /** The info string after the language, where `host=` and `cwd=` live. */
  meta?: string | null;
}

/** A Markdown code fence. Shell fences in a chat that can run them get a Run control. */
export function CodeFence({ code, language, meta }: CodeFenceProps) {
  const scope = useCodeRunScope();
  const info = useMemo(() => parseFenceInfo(language, meta), [language, meta]);
  const command = useMemo(
    () => (scope ? shellFenceCommand(info.language, code) : null),
    [scope, info.language, code],
  );
  if (!scope || command === null)
    return <ThemedCodeBlock code={code} language={language} uniProps={markdownCodeStyle} />;
  return (
    <RunnableFence
      scope={scope}
      code={code}
      language={info.language}
      request={info.request}
      command={command}
    />
  );
}

/** Whether a native fence must leave the library's text view to get its Run control. */
export function isRunnableShellFence(language: string, code: string): boolean {
  return shellFenceCommand(parseFenceInfo(language, null).language, code) !== null;
}

/** A runnable fence that names its host or folder (`host=`, `cwd=`). */
export function isRunnableTaggedShellFence(
  language: string,
  code: string,
  meta: string | null,
): boolean {
  const info = parseFenceInfo(language, meta);
  return hasRunRequest(info.request) && shellFenceCommand(info.language, code) !== null;
}

/** The host and folder a fence's `host=`/`cwd=` point at, as the app sees that host now. */
function useCodeRunTarget(chatScope: CodeRunScope, request: FenceRunRequest): CodeRunTarget {
  const hosts = useHosts();
  const host = useMemo(() => {
    if (request.host !== null) return matchCodeRunHost(request.host, hosts);
    const chatHost = hosts.find((entry) => entry.serverId === chatScope.serverId);
    return chatHost ?? { serverId: chatScope.serverId, label: chatScope.serverId };
  }, [chatScope.serverId, hosts, request.host]);
  const serverId = host?.serverId ?? chatScope.serverId;
  const connected = useHostRuntimeIsConnected(serverId);
  const homeDirectory = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.homeDirectory ?? null,
  );
  const workspaces = useSessionStore(
    (state) => state.sessions[serverId]?.workspaces ?? NO_WORKSPACES,
  );
  const keepsChatDrawers = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.chatTerminals === true,
  );
  return useMemo(
    () =>
      resolveCodeRunTarget(chatScope, request, {
        host,
        connected,
        homeDirectory,
        workspaces: workspaces.values(),
        keepsChatDrawers,
      }),
    [chatScope, connected, homeDirectory, host, keepsChatDrawers, request, workspaces],
  );
}

function RunnableFence({
  scope,
  code,
  language,
  request,
  command,
}: {
  scope: CodeRunScope;
  code: string;
  language: string | null;
  request: FenceRunRequest;
  command: string;
}) {
  // A fence still arriving may be cut mid-command; its card opens once the reply settles.
  const streaming = useContext(MarkdownStreamingContext);
  const target = useCodeRunTarget(scope, request);
  // An unknown host never starts a run, so its key only has to keep the card's draft apart.
  const serverId = targetServerId(target) ?? "";
  const runKey = useMemo(
    () => codeRunKey(serverId, scope, hashCode(code)),
    [serverId, scope, code],
  );
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
        <CodeRunCard
          runKey={runKey}
          target={target}
          openTerminal={scope.openTerminal}
          command={command}
          onClose={closeDraft}
        />
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
