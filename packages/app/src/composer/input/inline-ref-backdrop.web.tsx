import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Text, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { StoreApi } from "zustand/vanilla";
import { findInlineRefTokens } from "@/composer/attachments/inline-refs";
import type { InlineRefBackdropProps } from "./inline-ref-backdrop.types";

const MIRRORED_PROPERTIES = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "textIndent",
  "tabSize",
  "wordSpacing",
] as const;

interface MirrorGeometry {
  box: Record<string, string>;
  text: TextStyle;
  scrollTop: number;
}

function useStoreText(store: StoreApi<string>): string {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/**
 * Tints `[Image #N]` / `[File #N]` tokens in the composer textarea. A textarea cannot style
 * ranges, so a transparent copy of the text lies over it with the same box and font, and only
 * the token spans paint a translucent background. Renders nothing while the draft has no token.
 */
export function InlineRefBackdrop({ textStore, textarea }: InlineRefBackdropProps) {
  const text = useStoreText(textStore);
  const tokens = useMemo(() => findInlineRefTokens(text), [text]);
  const [geometry, setGeometry] = useState<MirrorGeometry | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const hasTokens = tokens.length > 0;

  useLayoutEffect(() => {
    if (!textarea || !hasTokens) return;
    const sync = () => {
      const computed = window.getComputedStyle(textarea);
      const box: Record<string, string> = {
        position: "absolute",
        boxSizing: "border-box",
        overflow: "hidden",
        pointerEvents: "none",
        top: `${textarea.offsetTop + textarea.clientTop}px`,
        left: `${textarea.offsetLeft + textarea.clientLeft}px`,
        width: `${textarea.clientWidth}px`,
        height: `${textarea.clientHeight}px`,
      };
      for (const property of MIRRORED_PROPERTIES) box[property] = computed[property];
      setGeometry({
        box,
        text: {
          fontFamily: computed.fontFamily,
          fontSize: parseFloat(computed.fontSize),
          fontWeight: computed.fontWeight as TextStyle["fontWeight"],
          lineHeight: parseFloat(computed.lineHeight) || undefined,
          letterSpacing: parseFloat(computed.letterSpacing) || 0,
        },
        scrollTop: textarea.scrollTop,
      });
    };
    sync();
    textarea.addEventListener("scroll", sync, { passive: true });
    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(textarea);
    return () => {
      textarea.removeEventListener("scroll", sync);
      resizeObserver.disconnect();
    };
  }, [textarea, hasTokens]);

  useLayoutEffect(() => {
    if (mirrorRef.current && geometry) mirrorRef.current.scrollTop = geometry.scrollTop;
  });

  if (!hasTokens || !geometry) return null;
  const parts: Array<string | React.ReactElement> = [];
  let at = 0;
  for (const token of tokens) {
    if (token.start > at) parts.push(text.slice(at, token.start));
    parts.push(
      <Text key={token.start} style={styles.chip}>
        {text.slice(token.start, token.end)}
      </Text>,
    );
    at = token.end;
  }
  // A trailing newline needs a character after it to take up its line, as in the textarea.
  parts.push(`${text.slice(at)}​`);

  return (
    <div
      ref={mirrorRef}
      aria-hidden
      data-testid="composer-inline-ref-backdrop"
      style={geometry.box}
    >
      <Text style={[geometry.text, styles.text]}>{parts}</Text>
    </div>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: {
    color: "transparent",
  },
  chip: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.sm,
    opacity: 0.25,
  },
}));
