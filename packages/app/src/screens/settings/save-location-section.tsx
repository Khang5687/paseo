import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { getIsElectron, isWeb } from "@/constants/platform";
import { describeFolder, pickDirectory } from "@/downloads/folder";
import { useAppSettings } from "@/hooks/use-settings";

type SaveHintKey = "web" | "desktop" | "ios" | "android";

function saveHintKey(): SaveHintKey {
  if (getIsElectron()) return "desktop";
  if (isWeb) return "web";
  return Platform.OS === "ios" ? "ios" : "android";
}

/** Where Download puts a file: asked every time by default, or a fixed place. */
export function SaveLocationSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const hintKey = saveHintKey();
  const changeAsk = useCallback(
    (downloadAskWhere: boolean) => void updateSettings({ downloadAskWhere }),
    [updateSettings],
  );
  const chooseFolder = useCallback(async () => {
    const folder = await pickDirectory();
    if (folder) {
      await updateSettings({ downloadFolderUri: folder.uri });
    }
  }, [updateSettings]);
  const folderName = describeFolder(settings.downloadFolderUri);

  return (
    <SettingsSection title={t("settings.files.save.title")} testID="save-location-settings">
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.files.save.askWhere")}
          hint={t(`settings.files.save.askWhereHint.${hintKey}`)}
          value={settings.downloadAskWhere}
          onValueChange={changeAsk}
          disabled={hintKey === "web"}
          testID="save-location-ask"
        />
        {hintKey === "android" && !settings.downloadAskWhere ? (
          <SettingsRow
            label={t("settings.files.save.folder")}
            hint={folderName ?? t("settings.files.save.folderNone")}
            testID="save-location-folder"
          >
            <Button variant="outline" size="sm" onPress={chooseFolder}>
              {folderName ? t("settings.files.save.change") : t("settings.files.save.choose")}
            </Button>
          </SettingsRow>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
