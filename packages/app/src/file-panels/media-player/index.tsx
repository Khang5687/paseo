import { useEventListener } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MediaPlayerProps } from "./types";

/**
 * The platform player (AVPlayerViewController, Media3) with its native controls, for video and
 * audio alike. It never plays until the user asks.
 */
export function MediaPlayer({ url, kind, testID, onError }: MediaPlayerProps) {
  const player = useVideoPlayer(url);
  useEventListener(player, "statusChange", ({ status }) => {
    if (status === "error") onError(url);
  });
  return (
    <View style={kind === "audio" ? styles.audioContainer : styles.videoContainer}>
      <VideoView
        testID={testID}
        player={player}
        nativeControls
        contentFit="contain"
        style={kind === "audio" ? styles.audio : styles.video}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  videoContainer: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  video: { flex: 1 },
  audioContainer: {
    flex: 1,
    justifyContent: "center",
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  audio: { width: "100%", height: 160 },
}));
