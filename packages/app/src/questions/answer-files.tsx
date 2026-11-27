import { useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Paperclip, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { uploadFileAttachments } from "@/composer/actions";
import { useToast } from "@/contexts/toast-context";
import { useFilePicker } from "@/hooks/use-file-picker";
import type { Theme } from "@/styles/theme";
import { MAX_ANSWER_FILES } from "./answer-message";

/** A file an answer carries, already uploaded to the host (text questions and question boxes). */
export interface AnswerFile {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
}

const ThemedPaperclip = withUnistyles(Paperclip);
const ThemedX = withUnistyles(X);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Picks files, uploads them to the host, and hands back the answer's new file list. */
export function AttachFilesButton({
  client,
  files,
  onChange,
  testID,
}: {
  client: DaemonClient | null;
  files: readonly AnswerFile[];
  onChange: (files: AnswerFile[]) => void;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { pickFiles } = useFilePicker();
  const [uploading, setUploading] = useState(false);
  const handlePress = useCallback(() => {
    if (!client) return;
    void (async () => {
      const picked = await pickFiles();
      if (!picked?.length) return;
      const room = MAX_ANSWER_FILES - files.length;
      if (picked.length > room) {
        toast.error(t("questions.tooManyFiles", { max: MAX_ANSWER_FILES }));
      }
      setUploading(true);
      try {
        const uploaded = await uploadFileAttachments({ client, files: picked.slice(0, room) });
        onChange([...files, ...uploaded.map(({ attachment: { type: _type, ...file } }) => file)]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("questions.uploadFailed"));
      } finally {
        setUploading(false);
      }
    })();
  }, [client, files, onChange, pickFiles, t, toast]);
  return (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={Paperclip}
      loading={uploading}
      disabled={!client || files.length >= MAX_ANSWER_FILES}
      onPress={handlePress}
      accessibilityLabel={t("questions.attach")}
      testID={testID}
    >
      {files.length > 0 ? String(files.length) : t("questions.attach")}
    </Button>
  );
}

/** The files an answer carries, each with a remove button. Renders nothing when empty. */
export function AnswerFileList({
  files,
  onRemove,
}: {
  files: readonly AnswerFile[];
  onRemove: (fileId: string) => void;
}): ReactElement | null {
  if (files.length === 0) return null;
  return (
    <View style={styles.files}>
      {files.map((file) => (
        <AnswerFileChip key={file.id} file={file} onRemove={onRemove} />
      ))}
    </View>
  );
}

function AnswerFileChip({
  file,
  onRemove,
}: {
  file: AnswerFile;
  onRemove: (fileId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleRemove = useCallback(() => onRemove(file.id), [file.id, onRemove]);
  return (
    <View style={styles.fileChip}>
      <ThemedPaperclip size={12} uniProps={mutedIconMapping} />
      <Text style={styles.fileName} numberOfLines={1}>
        {file.fileName}
      </Text>
      <ToolbarButton
        label={t("questions.removeFile", { name: file.fileName })}
        onPress={handleRemove}
      >
        <ThemedX size={12} uniProps={mutedIconMapping} />
      </ToolbarButton>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  files: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 220,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  fileName: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
