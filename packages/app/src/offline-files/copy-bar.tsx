import { useCallback } from "react";
import { Text, View } from "react-native";
import { Download, Share2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { canInstallPackage, installSavedPackage } from "@/downloads/install-package";
import { shareFileBytes } from "@/stores/download-store";
import { formatTimeAgo } from "@/utils/time";
import { readOfflineFileBytes, type OfflineFile } from "./store";

/**
 * Says the file is a saved copy and how old it is, and hands it to other apps. An APK on an
 * Android build that may install packages also gets Install.
 */
export function OfflineCopyBar({ entry }: { entry: OfflineFile }) {
  const { t } = useTranslation();
  const toast = useToast();
  const fileName = entry.path.split(/[\\/]/).pop() ?? "file";
  const share = useCallback(async () => {
    await shareFileBytes({
      bytes: await readOfflineFileBytes(entry),
      fileName,
      mimeType: entry.mimeType,
    });
  }, [entry, fileName]);
  const install = useCallback(async () => {
    try {
      await installSavedPackage(entry);
    } catch {
      toast.error(t("downloads.installFailed"));
    }
  }, [entry, t, toast]);
  return (
    <View style={styles.offlineBar} testID="offline-file-bar">
      <Text style={styles.offlineText} numberOfLines={1}>
        {t("offlineFiles.savedAgo", { time: formatTimeAgo(new Date(entry.savedAt)) })}
      </Text>
      <View style={styles.actions}>
        {canInstallPackage(fileName) ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Download}
            onPress={install}
            testID="offline-file-install"
          >
            {t("downloads.install")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Share2}
          onPress={share}
          testID="offline-file-share"
        >
          {t("offlineFiles.share")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  offlineBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  offlineText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
  },
}));
