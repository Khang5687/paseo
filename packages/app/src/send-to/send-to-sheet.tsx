import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { Laptop, Monitor, Smartphone, type LucideIcon } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  AdaptiveModalSheet,
  SheetHeaderSubtitle,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { getOrCreateClientId } from "@/utils/client-id";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { FileDevice } from "@getpaseo/client/internal/daemon-client";
import { fileNameOf, listSendTargets } from "./model";
import { useSendToStore } from "./store";

const DEVICE_ICONS: Record<string, LucideIcon> = {
  phone: Smartphone,
  desktop: Laptop,
  web: Monitor,
};
const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function DeviceIcon({ kind, color }: { kind: string; color: string }) {
  const Icon = DEVICE_ICONS[kind] ?? Monitor;
  return <Icon size={ICON_SIZE.md} color={color} />;
}

/**
 * The device picker behind every "Send to…" menu item. Rendered once at the app root; menus open
 * it through `useSendToStore`.
 */
export function SendToSheet() {
  const { t } = useTranslation();
  const toast = useToast();
  const request = useSendToStore((state) => state.request);
  const close = useSendToStore((state) => state.close);
  const client = useHostRuntimeClient(request?.serverId ?? "");
  const devices = useFetchQuery({
    queryKey: ["file-devices", request?.serverId],
    enabled: request !== null && client !== null,
    dataShape: "list",
    staleTimeMs: 0,
    gcTime: 0,
    queryFn: async () => {
      const [ownId, all] = await Promise.all([getOrCreateClientId(), client!.listFileDevices()]);
      return listSendTargets(all, ownId);
    },
  });
  const fileName = request ? fileNameOf(request.path) : "";

  const send = useCallback(
    (device: FileDevice) => {
      if (!request || !client) return;
      close();
      client
        .sendFileToDevice({ deviceId: device.deviceId, path: request.path })
        .then((receipt) =>
          toast.show(t("sendTo.sent", { device: receipt.deviceName }), { variant: "success" }),
        )
        .catch((error: unknown) =>
          toast.error(
            t("sendTo.failed", { error: error instanceof Error ? error.message : String(error) }),
          ),
        );
    },
    [client, close, request, t, toast],
  );

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("sendTo.title"),
      subtitle: <SheetHeaderSubtitle text={fileName} testID="send-to-file-name" />,
    }),
    [fileName, t],
  );

  let body;
  if (devices.isPending) {
    body = (
      <View style={styles.message}>
        <ThemedSpinner size={ICON_SIZE.sm} uniProps={mutedColor} />
      </View>
    );
  } else if (devices.isError || devices.data.length === 0) {
    body = (
      <Text style={styles.messageText} testID="send-to-empty">
        {devices.isError ? t("sendTo.failed", { error: devices.error.message }) : t("sendTo.empty")}
      </Text>
    );
  } else {
    body = devices.data.map((device) => (
      <DeviceRow key={device.deviceId} device={device} onPress={send} />
    ));
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={request !== null}
      onClose={close}
      snapPoints={SNAP_POINTS}
      desktopMaxWidth={420}
      testID="send-to-sheet"
    >
      {body}
    </AdaptiveModalSheet>
  );
}

const SNAP_POINTS = ["40%", "70%"];

function DeviceRow({
  device,
  onPress,
}: {
  device: FileDevice;
  onPress: (device: FileDevice) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(device), [device, onPress]);
  const rowStyle = useMemo(
    () => [styles.row, !device.reachable && styles.rowDisabled],
    [device.reachable],
  );
  const accessibilityState = useMemo(() => ({ disabled: !device.reachable }), [device.reachable]);
  return (
    <PressHighlight
      onPress={handlePress}
      disabled={!device.reachable}
      accessibilityRole="button"
      accessibilityLabel={device.name}
      accessibilityState={accessibilityState}
      style={rowStyle}
      testID={`send-to-device-${device.deviceId}`}
    >
      <DeviceIcon kind={device.kind} color={styles.icon.color} />
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>
          {device.name}
        </Text>
        {device.reachable ? null : <Text style={styles.hint}>{t("sendTo.notConnected")}</Text>}
      </View>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  icon: { color: theme.colors.foregroundMuted },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowDisabled: { opacity: 0.5 },
  rowText: { flex: 1, minWidth: 0 },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  message: { alignItems: "center", paddingVertical: theme.spacing[6] },
  messageText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[2],
  },
}));
