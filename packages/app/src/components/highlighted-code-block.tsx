import React, { useCallback, useMemo, useState } from "react";
import { View, Text, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Play } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { HighlightToken } from "@getpaseo/highlight";
import { BlockCopyButton, blockCopyGlyphInset } from "@/components/markdown/block-copy-button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { smallIconButtonChromeFrameSize } from "@/components/ui/icon-button-chrome";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { highlightToKeyedLines, type KeyedLine } from "@/utils/highlight-cache";
import {
  markdownCopyCodeBlockDataSet,
  markdownCopyDataSet,
  TRAILING_CODE_LINE_BREAKS,
} from "@/assistant-selection-copy/markup";

const ThemedPlay = withUnistyles(Play, mutedIconColorMapping);

export interface CodeBlockRunControl {
  onPress: () => void;
  /** False hides the control and keeps its space, e.g. while the fence streams in. */
  available: boolean;
}

interface HighlightedCodeBlockProps {
  code: string;
  language: string | null | undefined;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
  /** Shows a Run control beside Copy. */
  run?: CodeBlockRunControl;
}

// Fence info strings ("```ts", "```typescript", "```ts {1,3}") map to the
// extension-based parser table in @getpaseo/highlight. Aliases here only
// cover names that don't already match an extension key in parsers.ts.
const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  golang: "go",
  "c++": "cpp",
  csharp: "cs",
  "c#": "cs",
  objc: "m",
  "objective-c": "m",
  markdown: "md",
  elixir: "ex",
  terraform: "tf",
  shell: "sh",
  ruby: "rb",
  kotlin: "kt",
  powershell: "ps1",
  pwsh: "ps1",
  protobuf: "proto",
  perl: "pl",
  latex: "tex",
  stex: "tex",
};

export function fenceLanguageToExtension(info: string | null | undefined): string | null {
  if (!info) return null;
  const first = info.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first) return null;
  const normalized = first.replace(/^\./, "");
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

function stripTerminalFenceNewline(code: string): string {
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}

export const HighlightedCodeBlock = React.memo(function HighlightedCodeBlock({
  code,
  language,
  inheritedStyles,
  textStyle,
  run,
}: HighlightedCodeBlockProps) {
  // Box styles (bg / padding / border / radius / margin) go on the wrapper View
  // so the absolute copy button positions relative to the visible code area,
  // not to a parent that includes the Text's own marginVertical.
  const { containerStyle, innerTextStyle } = useMemo(
    () => splitFenceStyle(inheritedStyles, textStyle),
    [inheritedStyles, textStyle],
  );
  const renderedCode = useMemo(() => stripTerminalFenceNewline(code), [code]);
  const copyDataSet = useMemo(
    () => ({ ...CODE_SURFACE_DATASET, ...markdownCopyCodeBlockDataSet(language) }),
    [language],
  );

  const keyedLines = useMemo<KeyedLine[] | null>(
    () => highlightToKeyedLines(renderedCode, fenceLanguageToExtension(language)),
    [renderedCode, language],
  );

  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const controlsVisible = isHovered || isNative || isCompact;
  // Copy the code without its trailing blank lines. A fence body ends in a newline,
  // and ends in more than one when the author left a blank line before the closing
  // fence; pasting any of them into a terminal runs the last line.
  const copyCode = useCallback(async () => {
    const content = code.replace(TRAILING_CODE_LINE_BREAKS, "");
    if (!content) return false;
    return Clipboard.setStringAsync(content);
  }, [code]);
  // Two controls cover more of the first line than Copy alone; keep the code clear of them.
  const runnable = run !== undefined;
  const codeTextStyle = useMemo(
    () => (runnable ? [innerTextStyle, runButtonStyles.runReserve] : innerTextStyle),
    [innerTextStyle, runnable],
  );

  return (
    <View
      style={containerStyle}
      dataSet={copyDataSet}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {keyedLines ? (
        <Text style={codeTextStyle} dataSet={markdownCopyDataSet.code}>
          {renderCodeSegments(keyedLines)}
        </Text>
      ) : (
        <Text style={codeTextStyle} dataSet={markdownCopyDataSet.code}>
          {renderedCode}
        </Text>
      )}
      {run ? <RunButton onPress={run.onPress} visible={controlsVisible && run.available} /> : null}
      <BlockCopyButton
        onCopy={copyCode}
        visible={controlsVisible}
        label={t("message.actions.copyCode")}
      />{" "}
    </View>
  );
});

function renderCodeSegments(keyedLines: KeyedLine[]): React.ReactNode[] {
  const segments: React.ReactNode[] = [];
  for (let lineIndex = 0; lineIndex < keyedLines.length; lineIndex += 1) {
    const line = keyedLines[lineIndex];
    if (lineIndex > 0) {
      segments.push(<CodeTextSpan key={`${line.key}-newline`} text={"\n"} />);
    }
    for (const { key, token } of line.tokens) {
      segments.push(<TokenSpan key={`${line.key}-${key}`} token={token} />);
    }
  }
  return segments;
}

interface TokenSpanProps {
  token: HighlightToken;
}

const TokenSpan = React.memo(function TokenSpan({ token }: TokenSpanProps) {
  return (
    <Text style={token.style ? syntaxTokenStyleFor(token.style) : undefined}>{token.text}</Text>
  );
});

interface CodeTextSpanProps {
  text: string;
}

const CodeTextSpan = React.memo(function CodeTextSpan({ text }: CodeTextSpanProps) {
  return <Text>{text}</Text>;
});

interface SplitStyles {
  containerStyle: StyleProp<ViewStyle>;
  innerTextStyle: StyleProp<TextStyle>;
}

const CONTAINER_BASE: ViewStyle = { position: "relative" };
const WEB_SELECTABLE: TextStyle = isWeb ? ({ userSelect: "text" } as TextStyle) : {};

function splitFenceStyle(inheritedStyles: TextStyle, textStyle: TextStyle): SplitStyles {
  const { fontFamily, fontSize, color, ...box } = textStyle;
  const textOnly: TextStyle = { ...WEB_SELECTABLE };
  if (fontFamily !== undefined) textOnly.fontFamily = fontFamily;
  if (fontSize !== undefined) textOnly.fontSize = fontSize;
  if (fontSize !== undefined) textOnly.lineHeight = Math.round(fontSize * 1.45);
  if (color !== undefined) textOnly.color = color;
  return {
    containerStyle: [box as ViewStyle, CONTAINER_BASE],
    innerTextStyle: [inheritedStyles, textOnly],
  };
}

interface RunButtonProps {
  onPress: () => void;
  visible: boolean;
}

/** Sits beside the copy control, which owns the corner. */
const RunButton = React.memo(function RunButton({ onPress, visible }: RunButtonProps) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const [focused, setFocused] = useState(false);
  const focus = useCallback(() => setFocused(true), []);
  const blur = useCallback(() => setFocused(false), []);
  const shown = visible || focused;
  return (
    <View style={runButtonStyles.corner(compact)} dataSet={markdownCopyDataSet.ignore}>
      <ToolbarButton
        compact={compact}
        label={t("codeRun.run")}
        onPress={onPress}
        onFocus={focus}
        onBlur={blur}
        style={shown ? runButtonStyles.shown : runButtonStyles.hidden}
        testID="code-block-run"
      >
        <ThemedPlay size={paneContentToolbarIconSize(compact)} />
      </ToolbarButton>
    </View>
  );
});

const runButtonStyles = StyleSheet.create((theme) => ({
  runReserve: {
    paddingRight: theme.spacing[12],
  },
  // One button frame in from the copy control's corner.
  corner: (compact: boolean) => {
    const frame = smallIconButtonChromeFrameSize(compact);
    const frameOverhang = (frame - paneContentToolbarIconSize(compact)) / 2;
    const inset = blockCopyGlyphInset(theme) - frameOverhang;
    return {
      position: "absolute" as const,
      top: inset,
      right: inset + frame,
      pointerEvents: "box-none" as const,
    };
  },
  shown: { opacity: 1, pointerEvents: "auto" },
  hidden: { opacity: 0, pointerEvents: "none" },
}));
