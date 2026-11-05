import { memo, useMemo, useState } from "react";
import { Alert } from "react-native";
import {
  EnrichedMarkdownText,
  type LinkLongPressEvent,
  type LinkPressEvent,
} from "react-native-enriched-markdown";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import {
  useAssistantFileLinkActions,
  useAssistantFileLinkEnvironment,
} from "@/assistant-file-links";
import { useStableEvent } from "@/hooks/use-stable-event";
import { matchCommandLink, useAgentCommandHints, type CommandHints } from "@/agent-commands";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import type { Theme } from "@/styles/theme";
import { isNative, isWeb } from "@/constants/platform";
import { useSaveFileLinkOffline } from "@/offline-files/use-save-offline";
import { density, resolveDensity } from "@/styles/density";
import { MarkdownBlockStack } from "./block-stack";
import { WEB_RENDERERS } from "./renderers";
import { createMarkdownStyles } from "./styles";
import { PENDING_MARKDOWN_IMAGE } from "./source";
import { splitStreamingMarkdown } from "./streaming";
import { useMarkdownSource, type MarkdownImageContext } from "./images";
import { useChatNoteContextMenuItems } from "@/chat-notes/context";

import { CodeFence, isRunnableShellFence } from "@/code-run/fence";
import { useCodeRunScope } from "@/code-run/scope";
import { MermaidFence } from "./fence/mermaid";
import { splitNativeFences, type FenceSegment } from "./fence/segments";
import { MarkdownStreamingContext } from "./streaming-context";

const ThemedMarkdown = withUnistyles(EnrichedMarkdownText);
const MD4C_FLAGS = { latexMath: false, hardSoftBreaks: true, admonitions: true };

// Reading the breakpoint here makes Unistyles restyle the text when the layout crosses it.
const markdownStyle =
  (compact: boolean, muted = false) =>
  (theme: Theme, rt: { breakpoint?: string }) =>
    createMarkdownStyles(theme, {
      compact,
      muted,
      blockGap: resolveDensity(rt, density.blockGap),
    });
const regularStyle = markdownStyle(false);
const compactStyle = markdownStyle(true);
const compactMutedStyle = markdownStyle(true, true);

function pickMarkdownStyle(compact: boolean, muted: boolean) {
  if (!compact) return regularStyle;
  return muted ? compactMutedStyle : compactStyle;
}

export interface MarkdownRendererProps extends MarkdownImageContext {
  text: string;
  compact?: boolean;
  /** Muted text colour. Compact surfaces only. */
  muted?: boolean;
  selectable?: boolean;
  streaming?: boolean;
  onLinkPress?: (url: string) => unknown;
  agentCommands?: boolean;
}

/** All Markdown surfaces share the same engine and source adaptation. */
export const MarkdownRenderer = memo(function MarkdownRenderer(props: MarkdownRendererProps) {
  const streaming = !isWeb && !!props.streaming;
  // Only completed lines affect block closure. Do not run mdast on every reveal frame.
  const completeLines = streaming ? props.text.slice(0, props.text.lastIndexOf("\n") + 1) : "";
  const boundary = useMemo(
    () => splitStreamingMarkdown(completeLines, true).head.length,
    [completeLines],
  );
  const Part = props.agentCommands ? CommandMarkdownPart : MarkdownPart;
  if (!streaming || boundary === 0) return <Part {...props} />;
  return (
    <MarkdownBlockStack>
      <Part {...props} text={props.text.slice(0, boundary)} />
      <Part {...props} text={props.text.slice(boundary)} />
    </MarkdownBlockStack>
  );
});

const CommandMarkdownPart = memo(function CommandMarkdownPart(props: MarkdownRendererProps) {
  const commandHints = useAgentCommandHints();
  return <MarkdownPart {...props} commandHints={commandHints} />;
});

const MarkdownPart = memo(function MarkdownPart({
  text,
  compact = false,
  muted = false,
  selectable = true,
  streaming = false,
  onLinkPress,
  agentCommands: _agentCommands,
  commandHints = null,
  ...imageContext
}: MarkdownRendererProps & { commandHints?: CommandHints | null }) {
  const environment = useAssistantFileLinkEnvironment();
  const actions = useAssistantFileLinkActions();
  const client =
    imageContext.client ??
    (environment.client?.readFile
      ? { readFile: environment.client.readFile.bind(environment.client) }
      : undefined);
  const { markdown, imageSources, linkRecognition, linkSource } = useMarkdownSource(
    text,
    {
      workspaceRoot: environment.workspaceRoot,
      serverId: environment.serverId,
      ...imageContext,
      client,
    },
    commandHints?.names,
  );
  const [image, setImage] = useState<ImageLightboxSource | null>(null);
  const pressLink = useStableEvent(({ url, sourceType }: LinkPressEvent) => {
    const command = commandHints && matchCommandLink(url, sourceType, commandHints.names);
    if (command) {
      commandHints.insert(command);
      return;
    }
    const source = linkSource(url, sourceType);
    if (onLinkPress && !actions.canResolveFile(source)) onLinkPress(url);
    else actions.open(source, "preferred");
  });
  // Native links have no menu; a long press on a file offers to save it for offline use.
  // Web links get the same action from their right-click menu (`renderers.web.tsx`).
  const { t } = useTranslation();
  const saveOffline = useSaveFileLinkOffline();
  const longPressLink = useStableEvent(({ url }: LinkLongPressEvent) => {
    const source = linkSource(url);
    if (!actions.canResolveFile(source)) return;
    Alert.alert(url, undefined, [
      { text: t("offlineFiles.saveOffline"), onPress: () => saveOffline(source) },
      { text: t("common.actions.cancel"), style: "cancel" },
    ]);
  });
  const pressImage = useStableEvent(({ url }: { url: string }) => {
    if (url !== PENDING_MARKDOWN_IMAGE) setImage({ type: "uri", uri: url });
  });
  const closeImage = useStableEvent(() => setImage(null));
  // Web offers "Add note" over the browser selection; native has only the selection menu.
  const noteMenuItems = useChatNoteContextMenuItems();
  const contextMenuItems = isWeb ? undefined : noteMenuItems;
  // Shell fences leave the library only where a Run control can work.
  const canRun = useCodeRunScope() !== null;
  const segments = useMemo<FenceSegment[]>(
    () =>
      isWeb
        ? [{ kind: "markdown", id: "0", source: markdown }]
        : splitNativeFences(markdown, canRun ? isRunnableShellFence : null),
    [markdown, canRun],
  );
  return (
    <MarkdownStreamingContext.Provider value={streaming}>
      <MarkdownBlockStack imageSources={imageSources}>
        {segments.map((segment) => {
          const key = `${segment.kind}:${segment.id}`;
          if (segment.kind === "mermaid") return <MermaidFence key={key} code={segment.source} />;
          if (segment.kind === "shell")
            return <CodeFence key={key} code={segment.source} language={segment.language} />;
          return (
            <ThemedMarkdown
              key={key}
              markdown={segment.source}
              uniProps={pickMarkdownStyle(compact, muted)}
              flavor="github"
              selectable={selectable}
              md4cFlags={MD4C_FLAGS}
              linkRecognition={linkRecognition}
              enableTaskListItemToggle={false}
              enableLinkPreview={false}
              enableBlockContextMenu={false}
              contextMenuItems={contextMenuItems}
              // JS reveal owns pacing; native fade animation is a separate experiment.
              streamingAnimation={false}
              onLinkPress={pressLink}
              onLinkLongPress={isNative ? longPressLink : undefined}
              onImagePress={pressImage}
              renderers={isWeb ? WEB_RENDERERS : undefined}
            />
          );
        })}
      </MarkdownBlockStack>
      {image ? <AttachmentLightbox source={image} onClose={closeImage} /> : null}
    </MarkdownStreamingContext.Provider>
  );
});
