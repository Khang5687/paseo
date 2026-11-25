import { useCallback } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MediaPlayerProps } from "./types";

const videoStyle = { width: "100%", height: "100%", objectFit: "contain" } as const;
const audioStyle = { width: "100%", maxWidth: 480 } as const;

/** The browser's own player with its native controls. It never plays until the user asks. */
export function MediaPlayer({ url, kind, testID, onError }: MediaPlayerProps) {
  const handleError = useCallback(() => onError(url), [onError, url]);
  if (kind === "audio") {
    return (
      <View style={styles.audioContainer}>
        <audio
          data-testid={testID}
          src={url}
          controls
          preload="metadata"
          style={audioStyle}
          onError={handleError}
        />
      </View>
    );
  }
  return (
    <View style={styles.videoContainer}>
      <video
        data-testid={testID}
        src={url}
        controls
        playsInline
        preload="metadata"
        style={videoStyle}
        onError={handleError}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  videoContainer: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  audioContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
}));
