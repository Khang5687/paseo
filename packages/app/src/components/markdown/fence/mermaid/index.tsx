import { useContext } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { MarkdownStreamingContext } from "../../streaming-context";
import { MermaidFenceHost } from "./host";
const ThemedHost = withUnistyles(MermaidFenceHost);
const styles = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: { backgroundColor: theme.colors.surface2, padding: 12, borderRadius: 8 },
});
export function MermaidFence({ code }: { code: string }) {
  const streaming = useContext(MarkdownStreamingContext);
  return <ThemedHost code={code} phase={streaming ? "streaming" : "complete"} uniProps={styles} />;
}
