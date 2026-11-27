import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import type { Theme } from "@/styles/theme";

// Every attachment pill body — image thumbnail or labelled — renders at this
// height so mixed attachment trays line up.
const ATTACHMENT_CONTENT_HEIGHT = 48;
// The phone composer's tray while typing: one row of small tiles, so the files stop
// taking the room the chat needs above the keyboard.
const ATTACHMENT_TILE_SIZE = 40;

/**
 * How big the pills under this provider draw. `card` is the labelled card every surface uses;
 * `tile` is the small square of the phone composer's tray. Every pill kind — images, files,
 * forge items, plugin resources — draws through the components in this file, so one provider
 * shrinks them all without each kind knowing about the phone layout.
 */
export type AttachmentPillSize = "card" | "tile";
const AttachmentPillSizeContext = createContext<AttachmentPillSize>("card");
export const AttachmentPillSizeProvider = AttachmentPillSizeContext.Provider;
function useAttachmentPillSize(): AttachmentPillSize {
  return useContext(AttachmentPillSizeContext);
}

interface AttachmentPillProps {
  onOpen: () => void;
  onRemove: () => void;
  openAccessibilityLabel: string;
  removeAccessibilityLabel: string;
  disabled?: boolean;
  testID?: string;
  children: ReactNode;
}

export function AttachmentPill({
  onOpen,
  onRemove,
  openAccessibilityLabel,
  removeAccessibilityLabel,
  disabled = false,
  testID,
  children,
}: AttachmentPillProps) {
  const isCompact = useIsCompactFormFactor();
  const size = useAttachmentPillSize();
  const [isBodyHovered, setIsBodyHovered] = useState(false);
  const [isCloseHovered, setIsCloseHovered] = useState(false);
  const alwaysShow = isNative || isCompact;
  const showRemove = alwaysShow || isBodyHovered || isCloseHovered;
  const closeButtonStyle = useMemo(
    () => [
      size === "tile" ? styles.tileCloseButton : styles.closeButton,
      !showRemove && styles.closeButtonHidden,
    ],
    [showRemove, size],
  );
  const handleBodyHoverIn = useCallback(() => setIsBodyHovered(true), []);
  const handleBodyHoverOut = useCallback(() => setIsBodyHovered(false), []);
  const handleCloseHoverIn = useCallback(() => setIsCloseHovered(true), []);
  const handleCloseHoverOut = useCallback(() => setIsCloseHovered(false), []);
  return (
    <View style={styles.wrapper}>
      <Pressable
        testID={testID}
        onPress={onOpen}
        disabled={disabled}
        onHoverIn={handleBodyHoverIn}
        onHoverOut={handleBodyHoverOut}
        accessibilityRole="button"
        accessibilityLabel={openAccessibilityLabel}
        style={styles.frame}
      >
        {children}
      </Pressable>
      <Pressable
        onPress={onRemove}
        disabled={disabled}
        onHoverIn={handleCloseHoverIn}
        onHoverOut={handleCloseHoverOut}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={removeAccessibilityLabel}
        style={closeButtonStyle}
      >
        <ThemedX size={size === "tile" ? 10 : 12} uniProps={iconForegroundMutedMapping} />
      </Pressable>
    </View>
  );
}

interface AttachmentFrameProps {
  onPress?: () => void;
  accessibilityLabel?: string;
  testID?: string;
  children: ReactNode;
}

/** Bare attachment frame for read-only surfaces (sent messages) — no remove button. */
export function AttachmentFrame({
  onPress,
  accessibilityLabel,
  testID,
  children,
}: AttachmentFrameProps) {
  if (!onPress) {
    return (
      <View testID={testID} style={styles.frame}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={styles.frame}
    >
      {children}
    </Pressable>
  );
}

interface AttachmentLabelProps {
  icon?: ReactNode;
  title: string;
  subtitle: string;
}

/**
 * Two-line labelled pill body: attachment name over its type. As a tile, the name goes (the tile
 * is too small for it, and the type plus its `#n` token is what a phone user scans for) and the
 * icon sits over the type.
 */
export function AttachmentLabel({ icon, title, subtitle }: AttachmentLabelProps) {
  const isTile = useAttachmentPillSize() === "tile";
  if (isTile) {
    return (
      <View style={styles.tileLabelBody} accessibilityLabel={title}>
        {icon ? <View style={styles.labelIcon}>{icon}</View> : null}
        <Text style={styles.tileLabelText} numberOfLines={1}>
          {subtitle || title}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.labelBody}>
      {icon ? <View style={styles.labelIcon}>{icon}</View> : null}
      <View style={styles.labelTextColumn}>
        <Text style={styles.labelTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.labelSubtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
    </View>
  );
}

/** Square image preview pill body. `badge` (e.g. "#1") names the image's inline token. */
export function AttachmentThumbnail({
  metadata,
  badge,
}: {
  metadata: AttachmentMetadata;
  badge?: string;
}) {
  const isTile = useAttachmentPillSize() === "tile";
  const preview = useAttachmentPreviewUrl(metadata);
  const uri = preview.status === "ready" ? preview.url : null;
  const source = useMemo(() => (uri ? { uri } : null), [uri]);
  const body = source ? (
    <Image source={source} style={isTile ? styles.tileThumbnail : styles.thumbnail} />
  ) : (
    <View style={isTile ? styles.tileThumbnailPlaceholder : styles.thumbnailPlaceholder} />
  );
  if (!badge) return body;
  return (
    <View>
      {body}
      <View style={isTile ? styles.tileThumbnailBadge : styles.thumbnailBadge} pointerEvents="none">
        <Text style={styles.thumbnailBadgeText}>{badge}</Text>
      </View>
    </View>
  );
}

const ThemedX = withUnistyles(X);
const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme) => ({
  wrapper: {
    position: "relative",
  },
  frame: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    overflow: "hidden",
  },
  labelBody: {
    height: ATTACHMENT_CONTENT_HEIGHT,
    maxWidth: 260,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
  },
  labelIcon: {
    width: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  labelTextColumn: {
    minWidth: 0,
    flexShrink: 1,
  },
  labelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  labelSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  thumbnail: {
    width: ATTACHMENT_CONTENT_HEIGHT,
    height: ATTACHMENT_CONTENT_HEIGHT,
  },
  thumbnailPlaceholder: {
    width: ATTACHMENT_CONTENT_HEIGHT,
    height: ATTACHMENT_CONTENT_HEIGHT,
    backgroundColor: theme.colors.surface1,
  },
  thumbnailBadge: {
    position: "absolute",
    right: 2,
    bottom: 2,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  thumbnailBadgeText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  tileLabelBody: {
    height: ATTACHMENT_TILE_SIZE,
    minWidth: ATTACHMENT_TILE_SIZE,
    maxWidth: 80,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    paddingHorizontal: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
  },
  tileLabelText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 14,
  },
  tileThumbnail: {
    width: ATTACHMENT_TILE_SIZE,
    height: ATTACHMENT_TILE_SIZE,
  },
  tileThumbnailPlaceholder: {
    width: ATTACHMENT_TILE_SIZE,
    height: ATTACHMENT_TILE_SIZE,
    backgroundColor: theme.colors.surface1,
  },
  tileThumbnailBadge: {
    position: "absolute",
    right: 1,
    bottom: 1,
    paddingHorizontal: 3,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  closeButton: {
    position: "absolute",
    top: -8,
    left: -8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  // Top right on a tile: the tiles sit in one row from the left edge, so a top-left × would
  // reach into the composer's padding and over its neighbour.
  tileCloseButton: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  closeButtonHidden: {
    opacity: 0,
    pointerEvents: "none",
  },
}));
