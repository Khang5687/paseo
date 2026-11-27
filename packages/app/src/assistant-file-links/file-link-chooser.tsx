import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { PressHighlight } from "@/components/ui/press-highlight";
import { settingsStyles } from "@/styles/settings";
import { formatChoicePath, useFileChoiceStore } from "./file-link-choice";

/** Lists the files a chat link may mean and reports the pick. Mount once at the app root. */
export function FileLinkChooserSheet() {
  const { t } = useTranslation();
  const request = useFileChoiceStore((state) => state.request);
  const settle = useFileChoiceStore((state) => state.settle);
  const cancel = useCallback(() => settle(null), [settle]);
  const header = useMemo<SheetHeader>(() => ({ title: t("panels.file.chooseFile") }), [t]);

  if (!request) return null;

  return (
    <AdaptiveModalSheet header={header} visible onClose={cancel} testID="file-link-chooser">
      <View style={settingsStyles.card}>
        {request.paths.map((path, index) => (
          <FileChoiceRow
            key={path}
            path={path}
            displayPath={formatChoicePath(path, request.workspaceRoot)}
            showBorder={index > 0}
            onChoose={settle}
          />
        ))}
      </View>
    </AdaptiveModalSheet>
  );
}

function FileChoiceRow({
  path,
  displayPath,
  showBorder,
  onChoose,
}: {
  path: string;
  displayPath: string;
  showBorder: boolean;
  onChoose: (path: string) => void;
}) {
  const choose = useCallback(() => onChoose(path), [onChoose, path]);
  const slash = displayPath.lastIndexOf("/");
  const name = displayPath.slice(slash + 1);
  const directory = slash > 0 ? displayPath.slice(0, slash) : "";
  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={displayPath}
      onPress={choose}
      style={rowStyle}
      highlightStyle={styles.pressed}
      testID={`file-link-chooser-row-${displayPath}`}
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {name}
        </Text>
        {directory ? (
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {directory}
          </Text>
        ) : null}
      </View>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  pressed: {
    backgroundColor: theme.colors.surface3,
  },
}));
