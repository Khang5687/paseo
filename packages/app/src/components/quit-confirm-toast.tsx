import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { getIsElectronRuntime } from "@/constants/layout";
import { listenToDesktopEvent } from "@/desktop/electron/events";

interface QuitConfirmEventPayload {
  visible: boolean;
}

// Desktop main owns the Cmd+Q state machine (packages/desktop/src/features/quit-confirm);
// this only draws the hint it asks for.
export function QuitConfirmToast() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!getIsElectronRuntime()) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void listenToDesktopEvent<QuitConfirmEventPayload>("quit-confirm", (payload) => {
      if (!cancelled) setVisible(payload.visible === true);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
      return undefined;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (!getIsElectronRuntime()) return null;

  // The container stays mounted so the pill's exiting animation can run.
  return (
    <View style={styles.container}>
      {visible ? (
        <Animated.View
          style={styles.pill}
          entering={FadeIn.duration(120)}
          exiting={FadeOut.duration(120)}
        >
          <Text style={styles.text}>{t("desktop.quitConfirm.hint")}</Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
    pointerEvents: "none",
  },
  pill: {
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.full,
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[8],
    ...theme.shadow.lg,
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
  },
}));
