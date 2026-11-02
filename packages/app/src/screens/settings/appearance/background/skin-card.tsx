import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet as NativeStyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Image } from "expo-image";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Ban, ImagePlus, Info, MoreVertical, Pencil, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useSkinThumbnail, type SkinSummary } from "@/skins";
import { ICON_SIZE, type Theme } from "@/styles/theme";

// expo-image on web reads only plain style objects; a Unistyles style reaches it without its
// layout, so the thumbnail keeps a static React Native style.
const thumbnailStyle = NativeStyleSheet.absoluteFill;

const ThemedSpinner = withUnistyles(LoadingSpinner);
const ThemedBan = withUnistyles(Ban);
const ThemedImagePlus = withUnistyles(ImagePlus);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash = withUnistyles(Trash2);
const ThemedInfo = withUnistyles(Info);

const foregroundMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const mutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const spinnerMapping = (theme: Theme) => ({ color: theme.colors.foreground });

interface GalleryCardProps {
  label: string;
  selected: boolean;
  pending: boolean;
  onPress: () => void;
  /** Pointer entered or keyboard focus landed on the card. */
  onPreviewIntent?: () => void;
  /** Pointer left the card before the preview delay elapsed. */
  onPreviewCancel?: () => void;
  /** Focus left the card. */
  onPreviewEnd?: () => void;
  menu?: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

/**
 * One 16:9 tile. Hover is tracked on the plain outer View and press on the inner Pressable
 * (docs/hover.md); the optional menu trigger is a sibling of the Pressable, so it never nests
 * inside it.
 */
function GalleryCard({
  label,
  selected,
  pending,
  onPress,
  onPreviewIntent,
  onPreviewCancel,
  onPreviewEnd,
  menu,
  testID,
  style,
  children,
}: GalleryCardProps) {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const handlePointerEnter = useCallback(() => {
    setIsHovered(true);
    onPreviewIntent?.();
  }, [onPreviewIntent]);
  const handlePointerLeave = useCallback(() => {
    setIsHovered(false);
    onPreviewCancel?.();
  }, [onPreviewCancel]);
  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onPreviewIntent?.();
  }, [onPreviewIntent]);
  const handleBlur = useCallback(() => {
    setIsFocused(false);
    onPreviewEnd?.();
  }, [onPreviewEnd]);

  const accessibilityState = useMemo(() => ({ selected, busy: pending }), [pending, selected]);
  const frameStyle = useMemo(
    () => [styles.frame, selected ? styles.frameSelected : null],
    [selected],
  );
  const showMenu = isHovered || isFocused || isNative || isCompact;
  const menuStyle = useMemo(
    () => [styles.menuSlot, showMenu ? null : styles.menuSlotHidden],
    [showMenu],
  );
  const containerStyle = useMemo(() => [styles.card, style], [style]);

  return (
    <View
      style={containerStyle}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        onPress={onPress}
        onFocus={handleFocus}
        onBlur={handleBlur}
        style={frameStyle}
        testID={testID}
      >
        {children}
        {pending ? (
          <View style={styles.pendingOverlay}>
            <ThemedSpinner uniProps={spinnerMapping} />
          </View>
        ) : null}
      </Pressable>
      {menu ? (
        <View style={menuStyle} pointerEvents={showMenu ? "box-none" : "none"}>
          {menu}
        </View>
      ) : null}
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

interface NoneCardProps {
  selected: boolean;
  pending: boolean;
  onPress: () => void;
  onPreviewCancel: () => void;
  style?: StyleProp<ViewStyle>;
}

export const NoneCard = memo(function NoneCard({
  selected,
  pending,
  onPress,
  onPreviewCancel,
  style,
}: NoneCardProps) {
  const { t } = useTranslation();
  return (
    <GalleryCard
      label={t("settings.appearance.background.gallery.none")}
      selected={selected}
      pending={pending}
      onPress={onPress}
      onPreviewIntent={onPreviewCancel}
      style={style}
      testID="settings-background-none"
    >
      <View style={styles.placeholder}>
        <ThemedBan size={ICON_SIZE.lg} uniProps={mutedMapping} />
      </View>
    </GalleryCard>
  );
});

interface AddImageCardProps {
  pending: boolean;
  onPress: () => void;
  onPreviewCancel: () => void;
  style?: StyleProp<ViewStyle>;
}

export const AddImageCard = memo(function AddImageCard({
  pending,
  onPress,
  onPreviewCancel,
  style,
}: AddImageCardProps) {
  const { t } = useTranslation();
  return (
    <GalleryCard
      label={t("settings.appearance.background.gallery.addImage")}
      selected={false}
      pending={pending}
      onPress={onPress}
      onPreviewIntent={onPreviewCancel}
      style={style}
      testID="settings-background-add"
    >
      <View style={styles.placeholder}>
        <ThemedImagePlus size={ICON_SIZE.lg} uniProps={mutedMapping} />
      </View>
    </GalleryCard>
  );
});

function renderKebabIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreVertical size={ICON_SIZE.sm} uniProps={hovered ? foregroundMapping : mutedMapping} />
  );
}

interface SkinCardMenuProps {
  skin: SkinSummary;
  onEdit: (skin: SkinSummary) => void;
  onDelete: (skin: SkinSummary) => void;
  onDetails: (skin: SkinSummary) => void;
}

function SkinCardMenu({ skin, onEdit, onDelete, onDetails }: SkinCardMenuProps) {
  const { t } = useTranslation();
  const handleEdit = useCallback(() => onEdit(skin), [onEdit, skin]);
  const handleDelete = useCallback(() => onDelete(skin), [onDelete, skin]);
  const handleDetails = useCallback(() => onDetails(skin), [onDetails, skin]);
  const menuLabel = t("settings.appearance.background.menu.actions", {
    name: skin.name,
  });
  const editIcon = useMemo(() => <ThemedPencil size={ICON_SIZE.md} uniProps={mutedMapping} />, []);
  const deleteIcon = useMemo(() => <ThemedTrash size={ICON_SIZE.md} uniProps={mutedMapping} />, []);
  const detailsIcon = useMemo(() => <ThemedInfo size={ICON_SIZE.md} uniProps={mutedMapping} />, []);

  if (!skin.editable && !skin.attribution) {
    return null;
  }

  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        hitSlop={8}
        style={styles.menuTrigger}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel={menuLabel}
        testID={`settings-background-menu-${skin.id}`}
      >
        {renderKebabIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={200} sheetTitle={skin.name}>
        {skin.editable ? (
          <>
            <DropdownMenuItem leading={editIcon} onSelect={handleEdit}>
              {t("settings.appearance.background.menu.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem leading={deleteIcon} destructive onSelect={handleDelete}>
              {t("settings.appearance.background.menu.delete")}
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem leading={detailsIcon} onSelect={handleDetails}>
            {t("settings.appearance.background.menu.details")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface SkinCardProps {
  skin: SkinSummary;
  selected: boolean;
  pending: boolean;
  onCommit: (id: string) => void;
  onPreviewIntent: (id: string) => void;
  onPreviewCancel: () => void;
  onPreviewEnd: () => void;
  onEdit: (skin: SkinSummary) => void;
  onDelete: (skin: SkinSummary) => void;
  onDetails: (skin: SkinSummary) => void;
  style?: StyleProp<ViewStyle>;
}

export const SkinCard = memo(function SkinCard({
  skin,
  selected,
  pending,
  onCommit,
  onPreviewIntent,
  onPreviewCancel,
  onPreviewEnd,
  onEdit,
  onDelete,
  onDetails,
  style,
}: SkinCardProps) {
  const thumbnail = useSkinThumbnail(skin.id);
  const handlePress = useCallback(() => onCommit(skin.id), [onCommit, skin.id]);
  const handlePreviewIntent = useCallback(
    () => onPreviewIntent(skin.id),
    [onPreviewIntent, skin.id],
  );
  const contentPosition = useMemo(
    () => ({
      left: `${skin.focal.x * 100}%` as const,
      top: `${skin.focal.y * 100}%` as const,
    }),
    [skin.focal.x, skin.focal.y],
  );
  const thumbnailSource = useMemo(() => (thumbnail ? { uri: thumbnail } : null), [thumbnail]);
  const menu = useMemo(
    () => <SkinCardMenu skin={skin} onEdit={onEdit} onDelete={onDelete} onDetails={onDetails} />,
    [onDelete, onDetails, onEdit, skin],
  );

  return (
    <GalleryCard
      label={skin.name}
      selected={selected}
      pending={pending}
      onPress={handlePress}
      onPreviewIntent={handlePreviewIntent}
      onPreviewCancel={onPreviewCancel}
      onPreviewEnd={onPreviewEnd}
      menu={menu}
      style={style}
      testID={`settings-background-skin-${skin.id}`}
    >
      {thumbnailSource ? (
        <Image
          source={thumbnailSource}
          contentFit="cover"
          contentPosition={contentPosition}
          style={thumbnailStyle}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText} numberOfLines={2}>
            {skin.name}
          </Text>
        </View>
      )}
    </GalleryCard>
  );
});

const styles = StyleSheet.create((theme) => ({
  card: {
    position: "relative",
    gap: theme.spacing[2],
  },
  frame: {
    aspectRatio: 16 / 9,
    borderRadius: theme.borderRadius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  frameSelected: {
    borderColor: theme.colors.accent,
  },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[2],
  },
  placeholderText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  pendingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.35)",
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  menuSlot: {
    position: "absolute",
    top: theme.spacing[1],
    right: theme.spacing[1],
  },
  menuSlotHidden: {
    opacity: 0,
  },
  menuTrigger: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
}));
