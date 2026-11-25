import { Text } from "react-native";
import { forwardRef, useCallback, useMemo, useState, type ComponentProps } from "react";
import type {
  CodeBlockRendererProps,
  LinkRendererProps,
  MarkdownRenderers,
} from "react-native-enriched-markdown";
import { StyleSheet } from "react-native-unistyles";
import { useFileLink } from "@/assistant-file-links";
import { CodeFence } from "@/code-run/fence";
import { FileLinkContextMenu } from "@/assistant-file-links/context-menu";
import { MARKDOWN_COPY_RECOGNIZED_LINK_ATTRIBUTE } from "@/assistant-selection-copy/markup";
import { useSaveFileLinkOffline } from "@/offline-files/use-save-offline";
import { useForgeShorthand } from "@/git/forge-shorthand";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { MermaidFence } from "./fence/mermaid";
import { isRecognizedLink, markdownLinkSource } from "./source";
import { WebBlockquote } from "./quote-block.web";

function WebCodeBlock({ code, language }: CodeBlockRendererProps) {
  if (language?.toLowerCase() === "mermaid") return <MermaidFence code={code} />;
  return <CodeFence code={code} language={language} />;
}

// The library styles links inline, so a stylesheet :hover rule cannot underline them.
const LINK_HOVER_STYLE = { textDecoration: "underline" } as const;

function WebLink({ link, anchorProps, children }: LinkRendererProps) {
  const forgeShorthand = useForgeShorthand();
  // A forge reference like `#12` carries its web URL so hover, copy and new-tab opens work.
  const forgeUrl = link.sourceType === "text" ? forgeShorthand?.resolve(link.url) : null;
  const source = useMemo(
    () => (forgeUrl ? markdownLinkSource(forgeUrl) : markdownLinkSource(link.url, link.sourceType)),
    [forgeUrl, link.url, link.sourceType],
  );
  const { tooltipPath, fileCandidate, onHoverIn, resolveFile } = useFileLink(source);
  const tooltip = forgeUrl ?? tooltipPath;
  const saveFileLinkOffline = useSaveFileLinkOffline();
  const saveOffline = useCallback(() => saveFileLinkOffline(source), [saveFileLinkOffline, source]);
  const [hovered, setHovered] = useState(false);
  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);
  const anchorStyle = useMemo(
    () => ({
      ...anchorProps.style,
      overflowWrap: "anywhere" as const,
      ...(hovered ? LINK_HOVER_STYLE : null),
    }),
    [anchorProps.style, hovered],
  );
  // Selection copy pastes a link Paseo recognized as the text the reply showed.
  const recognized = isRecognizedLink(link);
  const copyAnchorProps = useMemo(
    () =>
      recognized
        ? { ...anchorProps, [MARKDOWN_COPY_RECOGNIZED_LINK_ATTRIBUTE]: "true" }
        : anchorProps,
    [anchorProps, recognized],
  );
  const anchor = (
    <a
      {...copyAnchorProps}
      href={forgeUrl ?? anchorProps.href}
      style={anchorStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
    </a>
  );
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild onHoverIn={onHoverIn}>
        <InlineLinkTrigger>
          {fileCandidate ? (
            <FileLinkContextMenu
              fileCandidate={fileCandidate}
              resolveFile={resolveFile}
              onSaveOffline={saveOffline}
            >
              {anchor}
            </FileLinkContextMenu>
          ) : (
            anchor
          )}
        </InlineLinkTrigger>
      </TooltipTrigger>
      {tooltip ? (
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {tooltip}
          </Text>
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}
// TooltipTrigger also supplies native Pressable handlers; forward only DOM events.
// A View renders a div, which is invalid inside the library's prose paragraphs.
const InlineLinkTrigger = forwardRef<HTMLSpanElement, ComponentProps<"span">>(
  function InlineLinkTrigger({ children, onMouseEnter, onMouseLeave, onFocus, onBlur }, ref) {
    return (
      <span
        ref={ref}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {children}
      </span>
    );
  },
);
const styles = StyleSheet.create((theme) => ({
  tooltipPath: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));

export const WEB_RENDERERS: MarkdownRenderers = {
  codeBlock: WebCodeBlock,
  link: WebLink,
  blockquote: WebBlockquote,
};
