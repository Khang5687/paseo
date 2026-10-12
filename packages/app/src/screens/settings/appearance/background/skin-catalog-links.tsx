import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useInstalledPlugins } from "@/plugins/registry";
import { buildPluginSettingsRoute } from "@/plugins/settings/routes";
import { useHostFeatureMap } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";

interface SkinCatalogScreen {
  key: string;
  serverId: string;
  pluginId: string;
  screenId: string;
  title: string;
}

/** Plugin settings screens that declared `skinCatalog`, once per plugin screen across hosts. */
function useSkinCatalogScreens(): SkinCatalogScreen[] {
  const plugins = useInstalledPlugins();
  const serverIds = useMemo(
    () => [...new Set(plugins.map((plugin) => plugin.serverId))],
    [plugins],
  );
  const settingsSupport = useHostFeatureMap(serverIds, "pluginSettings");
  return useMemo(() => {
    const seen = new Set<string>();
    const screens: SkinCatalogScreen[] = [];
    for (const plugin of plugins) {
      if (!settingsSupport.get(plugin.serverId)) continue;
      for (const screen of plugin.settingsScreens) {
        if (!screen.skinCatalog) continue;
        const key = `${plugin.id}/${screen.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        screens.push({
          key,
          serverId: plugin.serverId,
          pluginId: plugin.id,
          screenId: screen.id,
          title: screen.title,
        });
      }
    }
    return screens;
  }, [plugins, settingsSupport]);
}

function SkinCatalogLink({ screen }: { screen: SkinCatalogScreen }) {
  const { t } = useTranslation();
  const open = useCallback(
    () => router.push(buildPluginSettingsRoute(screen.serverId, screen.pluginId, screen.screenId)),
    [screen.pluginId, screen.screenId, screen.serverId],
  );
  return (
    <View style={ROW_STYLE}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{screen.title}</Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.appearance.background.catalog.hint")}
        </Text>
      </View>
      <Button
        variant="secondary"
        size="sm"
        onPress={open}
        testID={`settings-background-catalog-${screen.key}`}
      >
        {t("settings.appearance.background.catalog.browse")}
      </Button>
    </View>
  );
}

const ROW_STYLE = [settingsStyles.row, settingsStyles.rowBorder];

/** Rows linking to plugin screens that browse and install more skins. */
export function SkinCatalogLinks() {
  const screens = useSkinCatalogScreens();
  return screens.map((screen) => <SkinCatalogLink key={screen.key} screen={screen} />);
}
