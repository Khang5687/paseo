import { useCallback } from "react";
import { ExternalLink } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
} from "@/components/ui/icon-button-chrome";
import { openExternalUrl } from "@/utils/open-external-url";

const ThemedExternalLink = withUnistyles(ExternalLink);

/** Wide-layout header button that opens the agent's board task. */
export function AgentTaskLinkButton({ url }: { url: string }) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    void openExternalUrl(url).catch(console.error);
  }, [url]);
  return (
    <HeaderToggleButton
      testID="agent-task-link-button"
      onPress={handlePress}
      tooltipLabel={t("workspace.header.actions.openTask")}
      tooltipKeys={NO_KEYS}
      tooltipSide="bottom"
      accessible
      accessibilityRole="link"
      accessibilityLabel={t("workspace.header.actions.openTask")}
    >
      <ThemedExternalLink
        size={iconButtonChromeGlyphSize("large")}
        strokeWidth={1.5}
        uniProps={extraMutedIconColorMapping}
      />
    </HeaderToggleButton>
  );
}

const NO_KEYS: [] = [];
