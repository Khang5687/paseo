import { Text } from "react-native";
import {
  forwardRef,
  useCallback,
  useMemo,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import type {
  CodeBlockRendererProps,
  LinkRendererProps,
  MarkdownRenderers,
} from "react-native-enriched-markdown";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useFileLink, type AssistantFileLinkSource } from "@/assistant-file-links";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  useContextMenu,
} from "@/components/ui/context-menu";
import { useSaveFileLinkOffline } from "@/offline-files/use-save-offline";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { Theme } from "@/styles/theme";
import { MermaidFence } from "./fence/mermaid";
import { markdownLinkSource } from "./source";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);
const codeStyle = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: { backgroundColor: theme.colors.surface2, padding: 12, borderRadius: 8 },
});
function WebCodeBlock({ code, language }: CodeBlockRendererProps) {
  if (language?.toLowerCase() === "mermaid") return <MermaidFence code={code} />;
  return <ThemedCodeBlock code={code} language={language} uniProps={codeStyle} />;
}

// The library styles links inline, so a stylesheet :hover rule cannot underline them.
const LINK_HOVER_STYLE = { textDecoration: "underline" } as const;

function WebLink({ link, anchorProps, children }: LinkRendererProps) {
  const source = useMemo(
    () => markdownLinkSource(link.url, link.sourceType),
    [link.url, link.sourceType],
  );
  const { tooltipPath, onHoverIn, isFile } = useFileLink(source);
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
  const renderLink = useCallback(
    (onContextMenu?: (event: MouseEvent<HTMLAnchorElement>) => void) => (
      <Tooltip delayDuration={400}>
        <TooltipTrigger asChild onHoverIn={onHoverIn}>
          <InlineLinkTrigger>
            <a
              {...anchorProps}
              style={anchorStyle}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
              onContextMenu={onContextMenu}
            >
              {children}
            </a>
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
    ),
    [
      anchorProps,
      anchorStyle,
      children,
      handleMouseEnter,
      handleMouseLeave,
      onHoverIn,
      tooltipPath,
    ],
  );
  return isFile ? <FileLinkMenu source={source} renderLink={renderLink} /> : renderLink();
}

type RenderLink = (onContextMenu: (event: MouseEvent<HTMLAnchorElement>) => void) => ReactNode;

/** Right click, or a long press in a phone browser, offers to save a file link for offline use. */
function FileLinkMenu({
  source,
  renderLink,
}: {
  source: AssistantFileLinkSource;
  renderLink: RenderLink;
}) {
  const { t } = useTranslation();
  const saveOffline = useSaveFileLinkOffline();
  const save = useCallback(() => saveOffline(source), [saveOffline, source]);
  return (
    <ContextMenu>
      <FileLinkMenuTrigger renderLink={renderLink} />
      <ContextMenuContent align="start" minWidth={180} testID="file-link-context-menu">
        <ContextMenuItem onSelect={save} testID="file-link-save-offline">
          {t("offlineFiles.saveOffline")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ContextMenuTrigger renders a View, and a div is invalid inside the library's prose paragraphs,
// so the link's own anchor opens the menu at the pointer.
function FileLinkMenuTrigger({ renderLink }: { renderLink: RenderLink }) {
  const menu = useContextMenu();
  const open = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();
      menu.setAnchorRect({ x: event.pageX, y: event.pageY, width: 0, height: 0 });
      menu.setOpen(true);
    },
    [menu],
  );
  return renderLink(open);
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
