import { useCallback, type ReactElement } from "react";
import { Send } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useSendToAction } from "./use-send-to";

/** "Send to…" as a button, for views that have no menu. Renders nothing on a host that cannot. */
export function SendToButton({
  serverId,
  absolutePath,
}: {
  serverId: string;
  absolutePath: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const sendTo = useSendToAction(serverId);
  const handlePress = useCallback(() => sendTo?.(absolutePath), [absolutePath, sendTo]);
  if (!sendTo) return null;
  return (
    <Button variant="outline" leftIcon={Send} onPress={handlePress} testID="send-to-button">
      {t("sendTo.menuItem")}
    </Button>
  );
}
