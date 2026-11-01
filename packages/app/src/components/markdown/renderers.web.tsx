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
import { useSaveFileLinkOffline } from "@/offline-files/use-save-offline";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { MermaidFence } from "./fence/mermaid";
import { markdownLinkSource } from "./source";

function WebCodeBlock({ code, language }: CodeBlockRendererProps) {
  if (language?.toLowerCase() === "mermaid") return <MermaidFence code={code} />;
  return <CodeFence code={code} language={language} />;
}

// The library styles links inline, so a stylesheet :hover rule cannot underline them.
const LINK_HOVER_STYLE = { textDecoration: "underline" } as const;

function WebLink({ link, anchorProps, children }: LinkRendererProps) {
  const source = useMemo(
    () => markdownLinkSource(link.url, link.sourceType),
    [link.url, link.sourceType],
  );
  const { tooltipPath, fileCandidate, onHoverIn, resolveFile } = useFileLink(source);
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
  const anchor = (
    <a
      {...anchorProps}
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
      {tooltipPath ? (
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {tooltipPath}
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

export const WEB_RENDERERS: MarkdownRenderers = { codeBlock: WebCodeBlock, link: WebLink };
