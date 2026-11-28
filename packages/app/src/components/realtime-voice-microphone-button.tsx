import { ChevronDown, Ear, Headphones, Headset, Smartphone, Usb } from "lucide-react-native";
import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { MicrophoneRouteKind } from "@getpaseo/expo-two-way-audio";
import { controlIconSize, createControlGeometry } from "@/components/ui/control-geometry";
import { DensityIcon } from "@/components/ui/density-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import type { Theme } from "@/styles/theme";
import {
  buildMicrophoneMenu,
  type MicrophoneLabels,
  type MicrophoneMenuRow,
} from "@/voice/microphone-menu";
import { useMicrophoneRoutes } from "@/voice/use-microphone-routes";

const TEST_ID = "realtime-voice-microphone";

const ThemedChevronDown = withUnistyles(ChevronDown);

const chevronColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function compactTriggerStyle({ pressed }: { pressed: boolean }) {
  return [styles.compactTrigger, pressed ? styles.pressed : null];
}

const KIND_ICONS: Record<MicrophoneRouteKind, typeof Smartphone> = {
  phone: Smartphone,
  bluetooth: Headphones,
  wired: Headset,
  usb: Usb,
  hearing_aid: Ear,
};

/**
 * The talk panel's microphone picker. Android only: the native engine remembers the pick per
 * phone, so it holds for voice and dictation until the user picks again. Renders nothing where
 * the OS owns the route (iOS, web, desktop).
 */
export function RealtimeVoiceMicrophoneButton(): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const microphones = useMicrophoneRoutes();
  const labels = useMemo<MicrophoneLabels>(
    () => ({
      automatic: t("realtimeVoice.microphone.automatic"),
      androidPicks: t("realtimeVoice.microphone.androidPicks"),
      notConnected: (name) => t("realtimeVoice.microphone.notConnected", { name }),
      phone: t("realtimeVoice.microphone.phone"),
      wired: t("realtimeVoice.microphone.wired"),
      usb: t("realtimeVoice.microphone.usb"),
      bluetooth: (name) => t("realtimeVoice.microphone.bluetooth", { name }),
      hearingAid: (name) => t("realtimeVoice.microphone.hearingAid", { name }),
    }),
    [t],
  );
  const menu = useMemo(
    () => (microphones ? buildMicrophoneMenu(microphones.state, labels) : null),
    [microphones, labels],
  );
  const activeIcon = KIND_ICONS[menu?.active?.kind ?? "phone"];
  const leading = useMemo(
    () => <DensityIcon icon={activeIcon} size="sm" color="foregroundMuted" />,
    [activeIcon],
  );
  const choose = microphones?.choose;
  const handleSelect = useCallback(
    (row: MicrophoneMenuRow) => {
      if (!choose?.(row.key)) return;
      toast.show(t("realtimeVoice.microphone.toast", { name: row.label }));
    },
    [choose, toast, t],
  );
  if (!menu) return null;
  const activeLabel = menu.active?.label ?? labels.automatic;
  const accessibilityLabel = t("realtimeVoice.microphone.button", { name: activeLabel });
  return (
    <DropdownMenu compactMode="sheet">
      {isCompact ? (
        // A phone-width panel has no room for the name next to Black, mute and Stop: the icon
        // shows the kind, the menu and the toast name it.
        <DropdownMenuTrigger
          testID={TEST_ID}
          accessibilityLabel={accessibilityLabel}
          style={compactTriggerStyle}
        >
          {leading}
          <ThemedChevronDown size={controlIconSize.md} uniProps={chevronColorMapping} />
        </DropdownMenuTrigger>
      ) : (
        <DropdownTrigger testID={TEST_ID} leading={leading} accessibilityLabel={accessibilityLabel}>
          {activeLabel}
        </DropdownTrigger>
      )}
      <DropdownMenuContent
        sheetTitle={t("realtimeVoice.microphone.title")}
        align="end"
        width={280}
        testID={`${TEST_ID}-menu`}
      >
        {menu.rows.map((row) => (
          <MicrophoneRow key={row.key ?? "automatic"} row={row} onSelect={handleSelect} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MicrophoneRow({
  row,
  onSelect,
}: {
  row: MicrophoneMenuRow;
  onSelect: (row: MicrophoneMenuRow) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(row), [onSelect, row]);
  const leading = useMemo(
    () =>
      row.kind ? (
        <DensityIcon icon={KIND_ICONS[row.kind]} size="sm" color="foregroundMuted" />
      ) : null,
    [row.kind],
  );
  return (
    <DropdownMenuItem
      selected={row.selected}
      showSelectedCheck
      leading={leading}
      description={row.description}
      onSelect={handleSelect}
      testID={`${TEST_ID}-item-${row.key ?? "automatic"}`}
    >
      {row.label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  compactTrigger: {
    ...createControlGeometry(theme).buttonMd,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    backgroundColor: "transparent",
  },
  pressed: {
    opacity: 0.85,
  },
}));
