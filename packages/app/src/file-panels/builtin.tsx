import {
  useWorkspace,
  useFileUrl,
  type PluginFile,
  type PluginFilePanelProps,
} from "@getpaseo/plugin/client";
import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import { useSessionStore } from "@/stores/session-store";
import { DocumentFrame } from "./document-frame";
import { FileHtmlPreview } from "./html-preview";
import { FilePanelLoading } from "./loading";
import { FileMarkdownPreview } from "./markdown-preview";
import { MediaPlayer } from "./media-player";
import { TextFilePanel, type TextFilePreviewProps } from "./source/panel";
import type { RenderingFilePanel, SourceFilePanel } from "./catalog";

/** Source: the text file panel with no Preview, for text files no other built-in panel claims. */
function SourcePanel(props: PluginFilePanelProps) {
  return <TextFilePanel {...props} />;
}

/** Markdown: the text file panel with the rendered document as its Preview. */
function MarkdownPanel(props: PluginFilePanelProps) {
  return <TextFilePanel {...props} preview={MarkdownPreview} />;
}

/** HTML: the text file panel with the sandboxed page as its Preview. */
function HtmlPanel(props: PluginFilePanelProps) {
  return <TextFilePanel {...props} preview={HtmlPreview} />;
}

/** Shows Loading until the rendered Markdown has laid out once; later edits keep the content. */
function MarkdownPreview({ text, params, workspaceId, host }: TextFilePreviewProps) {
  const client = useSessionStore((state) => state.sessions[host.id]?.client ?? null);
  const workspaceRoot = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const [rendered, setRendered] = useState(false);
  const handleLayout = useCallback(() => setRendered(true), []);
  return (
    <View style={styles.container}>
      <ScrollView style={styles.container} showsVerticalScrollIndicator>
        <View onLayout={handleLayout}>
          <FileMarkdownPreview
            source={text}
            filePath={params.path}
            workspaceRoot={workspaceRoot ?? ""}
            client={client}
            serverId={host.id}
          />
        </View>
      </ScrollView>
      {rendered ? null : <FilePanelLoading />}
    </View>
  );
}

/** The page owns its scrolling, so there is no ScrollView around it. */
function HtmlPreview({ text }: TextFilePreviewProps) {
  return (
    <View style={styles.container}>
      <FileHtmlPreview html={text} testID="file-html-preview" />
    </View>
  );
}

function ImagePanel({ file }: PluginFilePanelProps) {
  const url = useFileUrl(file);
  if (url.status === "loading") return <FilePanelLoading />;
  if (url.status === "error") return <FilePanelError message={url.error.message} />;
  return <ZoomableImage uri={url.url} testID="image-file-preview" />;
}

function VideoPanel({ file }: PluginFilePanelProps) {
  return <MediaPanel file={file} kind="video" />;
}

function AudioPanel({ file }: PluginFilePanelProps) {
  return <MediaPanel file={file} kind="audio" />;
}

/** Loads the whole file, then plays it with the device's player. */
function MediaPanel({ file, kind }: { file: PluginFile; kind: "video" | "audio" }) {
  const { t } = useTranslation();
  const url = useFileUrl(file);
  const [unplayableUrl, setUnplayableUrl] = useState<string | null>(null);
  if (url.status === "loading") return <FilePanelLoading />;
  if (url.status === "error") return <FilePanelError message={url.error.message} />;
  if (unplayableUrl === url.url) {
    return <FilePanelError message={t("panels.file.failedToLoadPreview")} />;
  }
  return (
    <MediaPlayer
      url={url.url}
      kind={kind}
      testID={`${kind}-file-preview`}
      onError={setUnplayableUrl}
    />
  );
}

function PdfPanel({ file }: PluginFilePanelProps) {
  const url = useFileUrl(file);
  if (url.status === "loading") return <FilePanelLoading />;
  if (url.status === "error") return <FilePanelError message={url.error.message} />;
  return (
    <View style={styles.container}>
      <DocumentFrame url={url.url} testID="pdf-file-preview" />
    </View>
  );
}

function FilePanelError({ message }: { message: string }) {
  return (
    <View style={styles.centerState}>
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

const components = {
  "builtin:markdown": MarkdownPanel,
  "builtin:html": HtmlPanel,
  "builtin:image": ImagePanel,
  "builtin:video": VideoPanel,
  "builtin:audio": AudioPanel,
  "builtin:pdf": PdfPanel,
  "builtin:source": SourcePanel,
};

export function BuiltinFilePanelView({
  panel,
  ...props
}: PluginFilePanelProps & { panel: RenderingFilePanel | SourceFilePanel }) {
  const Component = components[panel.id];
  return <Component {...props} />;
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
