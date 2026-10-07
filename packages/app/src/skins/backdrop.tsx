import { useEffect, useMemo, useState } from "react";
import { StyleSheet } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { Image } from "expo-image";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { usePrefersMoreContrast, useReduceMotion } from "./accessibility";
import { useActiveSkin } from "./active";
import { useRefreshSelectedPluginSkins } from "./catalog";
import { computeArtLimit } from "./contrast";
import { useSkinPreferencesStore } from "./preferences-store";
import { useSkinRoute } from "./route";
import { useActiveSkinScheme } from "./scheme";
import type { SkinBlur, SkinImageUris, SkinMetadata } from "./types";

const FADE_MS = 220;

const BLUR_RADIUS: Record<Exclude<SkinBlur, "off">, number> = {
  low: 8,
  medium: 16,
  high: 28,
};

// Static layout only: Reanimated views must not take Unistyles styles.
const layout = StyleSheet.create({
  fill: StyleSheet.absoluteFillObject,
});

interface ShownSkin {
  metadata: SkinMetadata;
  images: SkinImageUris;
}

interface ThemeColors {
  surface: string;
  foreground: string;
  foregroundMuted: string;
  colorScheme: "light" | "dark";
}

/**
 * Background art behind the whole app shell. Mount it as the first child of the shell surface
 * so the sidebar and content draw above it. It keeps the previous art on screen while the next
 * skin loads, and renders nothing when no skin is active or the OS asks for no transparency.
 */
export function SkinBackdrop() {
  const scheme = useActiveSkinScheme();
  const { state, metadata, images } = useActiveSkin(scheme);
  const [shown, setShown] = useState<ShownSkin | null>(null);
  useRefreshSelectedPluginSkins();

  useEffect(() => {
    if (state === "on" && metadata && images) setShown({ metadata, images });
    else if (state !== "loading") setShown(null);
  }, [state, metadata, images]);

  if (!shown) return null;
  return <ThemedSkinArt metadata={shown.metadata} images={shown.images} />;
}

/**
 * Draws the art over the shell's opaque `surface0` fill. Art at opacity `o` over that fill is the
 * same picture as a `surface0` scrim at `1 - o` over full art, so the contrast gate and the
 * skin's own route intensity combine as one opacity instead of dimming twice.
 */
function SkinArt({
  metadata,
  images,
  surface,
  foreground,
  foregroundMuted,
  colorScheme,
}: ShownSkin & ThemeColors) {
  const route = useSkinRoute();
  const blur = useSkinPreferencesStore((state) => state.blur);
  const visibility = useSkinPreferencesStore((state) => state.visibility);
  const moreContrast = usePrefersMoreContrast();
  const reduceMotion = useReduceMotion();
  const low = metadata.luminance?.low;
  const high = metadata.luminance?.high;
  const limit = useMemo(
    () =>
      computeArtLimit({
        surface,
        foreground,
        foregroundMuted,
        colorScheme,
        luminance: low === undefined || high === undefined ? null : { low, high },
        moreContrast,
      }),
    [surface, foreground, foregroundMuted, colorScheme, low, high, moreContrast],
  );
  const targetOpacity = Math.min(metadata.intensity[route], limit * visibility);
  const opacity = useSharedValue(0);

  useEffect(() => {
    opacity.value = reduceMotion ? targetOpacity : withTiming(targetOpacity, { duration: FADE_MS });
  }, [opacity, reduceMotion, targetOpacity]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const uri = blur === "off" ? images.display : images.small;
  const source = useMemo(() => ({ uri }), [uri]);
  const { x, y } = metadata.focal;
  const contentPosition = useMemo(() => ({ left: `${x * 100}%`, top: `${y * 100}%` }), [x, y]);

  return (
    <Animated.View pointerEvents="none" style={[layout.fill, animatedStyle]}>
      <Image
        source={source}
        blurRadius={blur === "off" ? 0 : BLUR_RADIUS[blur]}
        contentFit="cover"
        contentPosition={contentPosition}
        transition={reduceMotion ? 0 : FADE_MS}
        cachePolicy="none"
        accessible={false}
        style={layout.fill}
      />
    </Animated.View>
  );
}

const ThemedSkinArt = withUnistyles(SkinArt, (theme) => ({
  surface: theme.colors.surface0,
  foreground: theme.colors.foreground,
  foregroundMuted: theme.colors.foregroundMuted,
  colorScheme: theme.colorScheme,
}));
