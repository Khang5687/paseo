import { useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { HardDriveDownload } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SavedFilePane } from "@/file-pane/pane";
import {
  createPaneFocusContextValue,
  PaneFocusProvider,
  PaneProvider,
  type PaneContextValue,
} from "@/panels/pane-context";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { SavedFilesList } from "./saved-files-list";
import { useOfflineFiles, type OfflineFile } from "./store";

const ThemedEmptyIcon = withUnistyles(HardDriveDownload);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const EMPTY_ICON_SIZE = 24;

/** This device's Saved library: every saved file, by host. Reads only local storage. */
export function SavedLibraryScreen(): ReactElement {
  const { t } = useTranslation();
  const files = useOfflineFiles();
  let content: ReactElement;
  if (!files) {
    content = (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  } else if (files.length === 0) {
    content = (
      <View style={styles.centered} testID="saved-library-empty">
        <ThemedEmptyIcon size={EMPTY_ICON_SIZE} uniProps={mutedColor} />
        <Text style={styles.emptyTitle}>{t("offlineFiles.library.empty")}</Text>
        <Text style={styles.emptyDescription}>{t("offlineFiles.library.emptyHint")}</Text>
      </View>
    );
  } else {
    content = (
      <View style={styles.listContent}>
        <View style={settingsStyles.card}>
          <SavedFilesList files={files} />
        </View>
      </View>
    );
  }
  return (
    <View style={styles.container} testID="saved-library">
      <MenuHeader title={t("sidebar.footer.saved")} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {content}
      </ScrollView>
    </View>
  );
}

/** One saved file, read from this device's copy. */
export function SavedFileScreen({ serverId, path }: { serverId: string; path: string }) {
  const { t } = useTranslation();
  const files = useOfflineFiles();
  const entry = files?.find((file) => file.serverId === serverId && file.path === path) ?? null;
  const name = path.split(/[\\/]/).pop() ?? path;
  let body: ReactElement;
  if (entry) {
    body = <SavedFileContext entry={entry} />;
  } else if (files) {
    body = (
      <View style={styles.centered}>
        <Text style={styles.emptyDescription}>{t("offlineFiles.library.gone")}</Text>
      </View>
    );
  } else {
    body = (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }
  return (
    <View style={styles.container} testID="saved-file-screen">
      <BackHeader title={name} />
      {body}
    </View>
  );
}

const noop = () => {};
const PANE_FOCUS = createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true });

/**
 * The file panels expect a workspace tab around them; a saved file has none, so this is a lone
 * read-only tab that keeps its panel state while the screen is open.
 */
function SavedFileContext({ entry }: { entry: OfflineFile }) {
  const [state, setState] = useState<JsonValue | undefined>(undefined);
  const pane = useMemo<PaneContextValue>(
    () => ({
      serverId: entry.serverId,
      workspaceId: "",
      host: "main",
      tabId: `saved:${entry.serverId}:${entry.path}`,
      target: { kind: "file", path: entry.path },
      state,
      openTab: noop,
      openPreferredTarget: noop,
      closeCurrentTab: router.back,
      retargetCurrentTab: noop,
      setCurrentTabState: setState,
      openFileInWorkspace: noop,
      openImportSheet: noop,
    }),
    [entry.path, entry.serverId, state],
  );
  return (
    <PaneProvider value={pane}>
      <PaneFocusProvider value={PANE_FOCUS}>
        <SavedFilePane entry={entry} />
      </PaneFocusProvider>
    </PaneProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  listContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  centered: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  // Static color holder read by the spinner (no useUnistyles).
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
