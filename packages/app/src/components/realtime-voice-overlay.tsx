import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, MicOff, Moon, Square } from "lucide-react-native";
import { FOOTER_HEIGHT } from "@/constants/layout";
import { useVoiceTelemetry } from "@/contexts/voice-context";
import { VoiceBlackScreen } from "./voice-black-screen";
import { VolumeMeter } from "./volume-meter";

interface RealtimeVoiceOverlayProps {
  isMuted: boolean;
  isSwitching: boolean;
  onToggleMute: () => void;
  onStop: () => void;
}

const OVERLAY_BUTTON_SIZE = 44;
const OVERLAY_VERTICAL_PADDING = (FOOTER_HEIGHT - OVERLAY_BUTTON_SIZE) / 2;

export function RealtimeVoiceOverlay({
  isMuted,
  isSwitching,
  onToggleMute,
  onStop,
}: RealtimeVoiceOverlayProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const { volume, isSpeaking } = useVoiceTelemetry();
  const muteButtonStyle = useMemo(
    () => [
      styles.actionButton,
      styles.muteButton,
      isMuted ? styles.muteButtonMuted : undefined,
      isSwitching ? styles.buttonDisabled : undefined,
    ],
    [isMuted, isSwitching],
  );
  const stopButtonStyle = useMemo(
    () => [styles.actionButton, styles.stopButton, isSwitching ? styles.buttonDisabled : undefined],
    [isSwitching],
  );
  // Lives in the panel, so ending live voice unmounts the panel and the black screen with it.
  const [isBlack, setIsBlack] = useState(false);
  const handleBlack = useCallback(() => setIsBlack(true), []);
  const handleWake = useCallback(() => setIsBlack(false), []);
  return (
    <View style={styles.container}>
      {isBlack ? <VoiceBlackScreen onWake={handleWake} /> : null}
      <View style={styles.meterContainer}>
        <VolumeMeter
          volume={volume}
          isMuted={isMuted}
          isSpeaking={isSpeaking}
          orientation="horizontal"
        />
      </View>

      <View style={styles.actionsContainer}>
        <Button
          testID="realtime-voice-black"
          leftIcon={Moon}
          onPress={handleBlack}
          accessibilityLabel={t("realtimeVoice.actions.black")}
        >
          {t("realtimeVoice.blackScreen.button")}
        </Button>

        <Pressable
          onPress={onToggleMute}
          disabled={isSwitching}
          accessibilityRole="button"
          accessibilityLabel={
            isMuted ? t("realtimeVoice.actions.unmute") : t("realtimeVoice.actions.mute")
          }
          style={muteButtonStyle}
        >
          {isMuted ? (
            <MicOff size={theme.iconSize.lg} color={theme.colors.palette.white} strokeWidth={2.5} />
          ) : (
            <Mic size={theme.iconSize.lg} color={theme.colors.foreground} strokeWidth={2.5} />
          )}
        </Pressable>

        <Pressable
          onPress={onStop}
          disabled={isSwitching}
          accessibilityRole="button"
          accessibilityLabel={t("realtimeVoice.actions.stop")}
          style={stopButtonStyle}
        >
          {isSwitching ? (
            <LoadingSpinner size="small" color={theme.colors.palette.white} />
          ) : (
            <Square
              size={theme.iconSize.lg}
              color={theme.colors.palette.white}
              fill={theme.colors.palette.white}
              strokeWidth={2.5}
            />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    height: FOOTER_HEIGHT,
    borderRadius: theme.borderRadius["2xl"],
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: OVERLAY_VERTICAL_PADDING,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  meterContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  actionsContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  muteButton: {
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  muteButtonMuted: {
    backgroundColor: theme.colors.palette.red[600],
    borderColor: theme.colors.palette.red[800],
  },
  stopButton: {
    backgroundColor: theme.colors.palette.red[600],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.palette.red[800],
  },
  buttonDisabled: {
    opacity: 0.5,
  },
}));
